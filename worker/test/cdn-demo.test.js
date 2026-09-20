import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/index.js';

function setup({ missing = false, cacheFailure = '', r2Failure = false } = {}) {
  const entries = new Map();
  const calls = { get: 0, put: 0 };
  const cache = {
    async match(key) {
      assert.equal(key.headers.get('Cookie'), null);
      assert.equal(new URL(key.url).search, '');
      if (cacheFailure === 'match') throw Error('cache unavailable');
      return entries.get(key.url)?.clone();
    },
    async put(key, response) {
      if (cacheFailure === 'put') throw Error('cache unavailable');
      calls.put++;
      entries.set(key.url, response.clone());
    },
  };
  const env = { FLAGS: { async get(key) {
    calls.get++;
    assert.equal(key, 'KR.png');
    if (r2Failure) throw Error('storage unavailable');
    return missing ? null : { body: new Uint8Array([137,80,78,71,13,10,26,10]) };
  } } };
  const handler = createHandler(() => { throw Error('must not resolve auth'); }, () => { throw Error('must not fetch'); }, () => cache);
  const request = (path='/cdn-demo/KR.png', method='GET') => handler.fetch(new Request('https://tunnel.devwonny.win'+path, {method, headers:{Cookie:'secret',Authorization:'secret'}}),env);
  return { request, calls, env };
}

test('existing R2 object: MISS then HIT across query/cookie variants, no second R2 read', async () => {
  const {request,calls}=setup();
  const first=await request('/cdn-demo/KR.png?a=1');
  assert.equal(first.headers.get('X-Demo-Cache'),'MISS');
  assert.equal(first.headers.get('Content-Type'),'image/png');
  assert.equal(first.headers.get('Set-Cookie'),null);
  assert.match(first.headers.get('Cache-Control'),/public/);
  const body=await first.arrayBuffer();
  const second=await request('/cdn-demo/KR.png?a=2');
  assert.equal(second.headers.get('X-Demo-Cache'),'HIT');
  assert.deepEqual(await second.arrayBuffer(),body);
  assert.deepEqual(calls,{get:1,put:1});
  const head=await request('/cdn-demo/KR.png','HEAD');
  assert.equal(head.headers.get('X-Demo-Cache'),'HIT');
  assert.equal(await head.text(),'');
});

test('HEAD miss fills cache with full GET image', async () => {
  const {request,calls}=setup();
  const head=await request('/cdn-demo/KR.png','HEAD');
  assert.equal(await head.text(),'');
  const get=await request();
  assert.equal(get.headers.get('X-Demo-Cache'),'HIT');
  assert.equal((await get.arrayBuffer()).byteLength,8);
  assert.equal(calls.get,1);
});

test('other objects and methods cannot read R2 or fill cache', async () => {
  const {request,calls}=setup();
  for(const path of ['/cdn-demo/DE.png','/cdn-demo/KR.png/','/cdn-demo/private.json']) {
    assert.equal((await request(path)).status,404);
  }
  const response=await request('/cdn-demo/KR.png','POST');
  assert.equal(response.status,405);
  assert.equal(response.headers.get('Allow'),'GET, HEAD');
  assert.deepEqual(calls,{get:0,put:0});
});

for(const options of [{missing:true},{r2Failure:true}]) test('missing/unavailable R2 does not cache errors '+JSON.stringify(options),async()=>{
  const {request,calls}=setup(options);
  const response=await request();
  assert.equal(response.status,options.missing?404:503);
  assert.match(response.headers.get('Cache-Control'),/no-store/);
  assert.equal(calls.put,0);
});

for(const cacheFailure of ['match','put']) test('cache failure serves existing object with BYPASS: '+cacheFailure,async()=>{
  const {request}=setup({cacheFailure});
  const response=await request();
  assert.equal(response.status,200);
  assert.equal(response.headers.get('X-Demo-Cache'),'BYPASS');
});

test('secure route still requires authentication and is never shared cached',async()=>{
  const handler=createHandler(undefined,undefined,()=>{throw Error('private path used cache');});
  const response=await handler.fetch(new Request('https://tunnel.devwonny.win/secure/KR'),{TEAM_DOMAIN:'https://example.com',POLICY_AUD:'test'});
  assert.equal(response.status,401);
  assert.match(response.headers.get('Cache-Control'),/private, no-store/);
});
