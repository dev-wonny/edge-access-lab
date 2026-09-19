import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generateKeyPair, SignJWT } from 'jose';
import { createHandler } from '../src/index.js';

const { publicKey, privateKey } = await generateKeyPair('RS256');
const worker = createHandler(() => publicKey, async () => new Response(null, { status: 404 }));
const png = new Uint8Array(await readFile(new URL('../flags/KR.png', import.meta.url)));
const issuer = 'https://test.cloudflareaccess.com';
const audience = 'test-audience';
const now = Math.floor(Date.now() / 1000);
let reads = 0;
const env = {
  TEAM_DOMAIN: issuer, POLICY_AUD: audience,
  FLAGS: { async get(key) { reads++; return key === 'KR.png' ? { body: new Uint8Array([137, 80, 78, 71]) } : null; } },
};
async function token(overrides = {}, key = privateKey) {
  return new SignJWT({ email: 'user@example.com', country: 'KR', iat: now, exp: now + 300,
    iss: issuer, aud: audience, ...overrides }).setProtectedHeader({ alg: 'RS256' }).sign(key);
}
function request(path, jwt) {
  return new Request(`https://tunnel.example.com${path}`, {
    headers: jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {},
  });
}

test('missing token cannot read either identity or R2', async () => {
  const before = reads;
  for (const path of ['/secure', '/secure/KR']) {
    assert.equal((await worker.fetch(request(path), env)).status, 401);
  }
  assert.equal(reads, before);
});
for (const [name, claims] of [
  ['expired', { exp: now - 60 }], ['wrong audience', { aud: 'other' }],
  ['wrong issuer', { iss: 'https://other.example' }], ['not yet valid', { nbf: now + 300 }],
  ['missing email', { email: undefined }],
]) {
  test(`rejects ${name} token before reading R2`, async () => {
    const before = reads;
    const response = await worker.fetch(request('/secure/KR', await token(claims)), env);
    assert.equal(response.status, 403);
    assert.equal(reads, before);
  });
}
test('rejects token signed by another key', async () => {
  const other = await generateKeyPair('RS256');
  assert.equal((await worker.fetch(request('/secure', await token({}, other.privateKey)), env)).status, 403);
});
test('HTML escapes email and uses verified issue time and country link', async () => {
  const jwt = await token({ email: '<script>@example.com' });
  const response = await worker.fetch(request('/secure', jwt), env);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /^text\/html/);
  assert.match(html, /&lt;script&gt;@example.com/);
  assert.ok(html.includes(new Date(now * 1000).toISOString()));
  assert.ok(html.includes('href="/secure/KR"'));
  assert.ok(!html.includes(jwt));
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
});
test('authenticated flag response returns image bytes and MIME type', async () => {
  const response = await worker.fetch(request('/secure/KR', await token()), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'image/png');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([137, 80, 78, 71]));
});
test('missing flag returns 404; R2 failure returns 503', async () => {
  const jwt = await token();
  assert.equal((await worker.fetch(request('/secure/US', jwt), env)).status, 404);
  const broken = { ...env, FLAGS: { get() { throw new Error('storage error'); } } };
  assert.equal((await worker.fetch(request('/secure/KR', jwt), broken)).status, 503);
});
test('route wildcard does not expose unrelated paths', async () => {
  for (const path of ['/secure-other', '/secure/KR/extra', '/headers']) {
    assert.equal((await worker.fetch(request(path), env)).status, 404);
  }
});

function flagHarness(download = async () => new Response(png, {
  headers: { 'Content-Type': 'image/png' },
})) {
  const objects = new Map();
  const downloads = [];
  const writes = [];
  const flags = {
    async get(key) {
      const bytes = objects.get(key);
      return bytes ? { body: bytes } : null;
    },
    async put(key, bytes, options) {
      writes.push({ key, bytes, options });
      objects.set(key, bytes);
      return { key };
    },
  };
  const handler = createHandler(() => publicKey, async (...args) => {
    downloads.push(args);
    return download(...args);
  });
  return { objects, downloads, writes, flags,
    fetch: (req) => handler.fetch(req, { ...env, FLAGS: flags }) };
}

test('missing flag is downloaded, stored privately, and reused on the next request', async () => {
  const h = flagHarness();
  const jwt = await token();
  const req = request('/secure/US', jwt);
  req.headers.set('Cookie', 'CF_Authorization=private-user-cookie');
  for (let i = 0; i < 2; i++) {
    const response = await h.fetch(req);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'image/png');
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), png);
  }
  assert.equal(h.downloads.length, 1);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].key, 'US.png');
  assert.deepEqual(h.writes[0].options.httpMetadata, { contentType: 'image/png' });
  const [url, options] = h.downloads[0];
  assert.equal(url, 'https://flagcdn.com/w640/us.png');
  assert.equal(options.redirect, 'error');
  assert.ok(options.signal instanceof AbortSignal);
  assert.deepEqual([...new Headers(options.headers)], [['accept', 'image/png']]);
});

test('existing R2 flag is returned even if the external source is down', async () => {
  const h = flagHarness(async () => { throw new Error('offline'); });
  h.objects.set('US.png', png);
  assert.equal((await h.fetch(request('/secure/US', await token()))).status, 200);
  assert.equal(h.downloads.length, 0);
  assert.equal(h.writes.length, 0);
});

test('unauthenticated and expired requests cannot download or populate flags', async () => {
  const h = flagHarness();
  assert.equal((await h.fetch(request('/secure/US'))).status, 401);
  assert.equal((await h.fetch(request('/secure/US', await token({ exp: now - 60 })))).status, 403);
  assert.equal(h.downloads.length, 0);
  assert.equal(h.writes.length, 0);
});

test('unknown country does not trigger an external download', async () => {
  const h = flagHarness();
  assert.equal((await h.fetch(request('/secure/XX', await token()))).status, 404);
  assert.equal(h.downloads.length, 0);
});

for (const [name, download, status] of [
  ['missing source', () => new Response(null, { status: 404 }), 404],
  ['source failure', () => new Response('error', { status: 500 }), 503],
  ['network timeout', () => { throw new DOMException('Timed out', 'TimeoutError'); }, 503],
  ['HTML error page', () => new Response('<html>Error</html>', { headers: { 'Content-Type': 'text/html' } }), 502],
  ['wrong PNG signature', () => new Response('not an image', { headers: { 'Content-Type': 'image/png' } }), 502],
  ['oversized PNG', () => new Response(new Uint8Array(256 * 1024 + 1), { headers: { 'Content-Type': 'image/png' } }), 502],
]) {
  test(`${name} is not stored and a later request can retry`, async () => {
    const h = flagHarness(download);
    const jwt = await token();
    for (let i = 0; i < 2; i++) {
      assert.equal((await h.fetch(request('/secure/US', jwt))).status, status);
    }
    assert.equal(h.downloads.length, 2);
    assert.equal(h.writes.length, 0);
    assert.equal(h.objects.size, 0);
  });
}

test('failed R2 write does not serve the downloaded bytes as a successful response', async () => {
  const h = flagHarness();
  h.flags.put = async () => { throw new Error('write failed'); };
  assert.equal((await h.fetch(request('/secure/US', await token()))).status, 503);
  assert.equal(h.objects.size, 0);
});
