import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'jose';
import { createHandler } from '../src/index.js';

const { publicKey, privateKey } = await generateKeyPair('RS256');
const worker = createHandler(() => publicKey);
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
