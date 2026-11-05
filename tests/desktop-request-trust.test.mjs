import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDesktopRequestTrust, registerDesktopProof } from '../apps/dsh-plugins/shared/desktop-request-trust.mjs';

const origin = 'http://127.0.0.1:3080';
const path = '/api/local-studio/actions';
const marker = 'x-local-studio-action';
const cookie = 'dsh-auth-fixture=synthetic';
const audience = { method: 'POST', path };
const challenge = (headers = {}) => new Request(`${origin}/api/local-studio/desktop-proof/actions`, {
  headers: { cookie, 'x-local-studio-proof-request': '1', ...headers },
});
const post = (target = path, headers = {}, method = 'POST') => new Request(origin + target, {
  method, headers: { cookie, 'content-type': 'application/json', [marker]: '1', ...headers },
});

test('authenticated Web requests retain same-origin and marker restrictions', () => {
  const trust = createDesktopRequestTrust({ origin });
  assert.equal(trust.mutationAllowed(post(path, { origin }), { marker }), true);
  assert.equal(trust.mutationAllowed(post(path, { origin: 'https://other.example' }), { marker }), false);
  assert.equal(trust.mutationAllowed(post(path, { origin, 'sec-fetch-site': 'same-site' }), { marker }), false);
  assert.equal(trust.mutationAllowed(post(path, { origin, [marker]: '0' }), { marker }), false);
  assert.equal(trust.mutationAllowed(post(path, { origin, 'content-type': 'application/jsonp' }), { marker }), false);
});

test('Desktop proof is bound to the cookie, route, method and Host instance', async () => {
  const trust = createDesktopRequestTrust({ origin });
  const response = trust.challenge(challenge(), audience);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-store/);
  const { proof } = await response.json();
  const proofHeader = { 'x-local-studio-desktop-proof': proof };
  assert.equal(trust.mutationAllowed(post(path, proofHeader), { marker }), true);
  assert.equal(trust.mutationAllowed(post(path), { marker }), false);
  assert.equal(trust.mutationAllowed(post(path, { ...proofHeader, cookie: 'dsh-auth-fixture=another' }), { marker }), false);
  assert.equal(trust.mutationAllowed(post('/api/local-studio/services', proofHeader), { marker }), false);
  assert.equal(trust.mutationAllowed(post(path, proofHeader, 'PUT'), { marker }), false);
  assert.equal(createDesktopRequestTrust({ origin }).mutationAllowed(post(path, proofHeader), { marker }), false);
});

test('challenge and mutation reject cross-site, malformed or expired requests', async () => {
  let time = 100_000;
  const trust = createDesktopRequestTrust({ origin, ttlMs: 10_000, now: () => time });
  for (const headers of [{ origin: 'null' }, { origin: 'https://other.example' }, { 'sec-fetch-site': 'same-site' }, { cookie: 'other=1' }]) {
    assert.equal(trust.challenge(challenge(headers), audience).status, 403);
  }
  assert.equal(trust.challenge(new Request(`${origin}/api/local-studio/desktop-proof/actions?x=1`, { headers: { cookie, 'x-local-studio-proof-request': '1' } }), audience).status, 403);
  for (const invalid of [undefined, { method: 'GET', path }, { method: 'POST', path: `${path}?x=1` }, { ...audience, extra: true }]) {
    assert.equal(trust.challenge(challenge(), invalid).status, 403);
  }
  const { proof } = await trust.challenge(challenge(), audience).json();
  assert.equal(trust.mutationAllowed(post(path, { 'x-local-studio-desktop-proof': proof, 'sec-fetch-site': 'cross-site' }), { marker }), false);
  time += 10_001;
  assert.equal(trust.mutationAllowed(post(path, { 'x-local-studio-desktop-proof': proof }), { marker }), false);
  time -= 20_000;
  assert.equal(trust.mutationAllowed(post(path, { 'x-local-studio-desktop-proof': proof }), { marker }), false);
});

test('registration fixes its configured audience and does not authenticate by itself', async () => {
  const trust = createDesktopRequestTrust({ origin }), routes = new Map();
  const ctx = { connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } } } };
  const target = { ...audience }, route = '/api/local-studio/desktop-proof/actions';
  assert.throws(() => registerDesktopProof(ctx, route, trust), /Invalid proof audience/);
  const dispose = registerDesktopProof(ctx, route, trust, target);
  target.path = '/api/local-studio/services';
  const forged = 'dsh-auth-forged=not-authenticated';
  const { proof } = await routes.get(route).fetch(challenge({ cookie: forged })).json();
  // This succeeds without an actual DSH fence: proving why registration on an
  // unauthenticated HTTP route is forbidden rather than an authentication test.
  assert.equal(trust.mutationAllowed(post(path, { cookie: forged, 'x-local-studio-desktop-proof': proof }), { marker }), true);
  assert.equal(trust.mutationAllowed(post(target.path, { cookie: forged, 'x-local-studio-desktop-proof': proof }), { marker }), false);
  dispose();
  assert.equal(routes.size, 0);
});

test('Desktop Host connection rejects a guest before route-bound proof is evaluated', { skip: !process.env.MEDIA_STUDIO_DESKTOP_TEST_EXE }, () => {
  const modulePath = fileURLToPath(new URL('../apps/dsh-plugins/shared/desktop-request-trust.mjs', import.meta.url));
  const script = String.raw`
    const assert = require('node:assert/strict'), path = require('node:path');
    const {pathToFileURL} = require('node:url');
    (async () => {
      const root = path.join(process.resourcesPath, 'app.asar/dsh/node_modules/@deepseek-ai');
      const [{Context}, {HostConnectionService}, proof] = await Promise.all([
        import(pathToFileURL(path.join(root, 'cordis/lib/index.js'))),
        import(pathToFileURL(path.join(root, 'dsh-client-connection/lib/index.js'))),
        import(pathToFileURL(process.argv[1]))]);
      const ctx = new Context(), provider = ctx.plugin(c => { new HostConnectionService(c, [], {}); });
      await provider.await();
      const connection = ctx.get('connection'), trust = proof.createDesktopRequestTrust({origin:'http://127.0.0.1:3080'});
      const proofPath='/api/local-studio/desktop-proof/actions', action='/api/local-studio/actions', marker='x-local-studio-action';
      const stopProof=proof.registerDesktopProof({connection},proofPath,trust,{method:'POST',path:action});
      const stopAction=connection.fetch.register({path:action,methods:['POST'],requestBody:'buffered',fetch:r=>new Response(null,{status:trust.mutationAllowed(r,{marker})?204:403})});
      const handler=connection.createSharedFetchHandler('/api'), guest=connection.createPeer({principal:{kind:'test-guest',guest:'fixture'}});
      const cookie='dsh-auth-fixture=synthetic', issue=()=>new Request('http://desktop.invalid'+proofPath,{headers:{cookie,'x-local-studio-proof-request':'1'}});
      try {
        assert.equal((await handler.fetch(issue(),guest)).status,403);
        const response=await handler.fetch(issue(),connection.browserPeer);assert.equal(response.status,200);
        const {proof:value}=await response.json(), headers={cookie,'content-type':'application/json',[marker]:'1','x-local-studio-desktop-proof':value};
        assert.equal((await handler.fetch(new Request('http://desktop.invalid'+action,{method:'POST',headers}),connection.browserPeer)).status,204);
        assert.equal((await handler.fetch(new Request('http://desktop.invalid'+action,{method:'POST',headers:{...headers,cookie:'dsh-auth-fixture=other'}}),connection.browserPeer)).status,403);
        assert.equal((await handler.fetch(new Request('http://desktop.invalid'+action,{method:'POST',headers}),guest)).status,403);
      } finally { await stopAction();await stopProof();await guest.dispose();await provider.dispose(); }
    })().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
  `;
  const child = spawnSync(process.env.MEDIA_STUDIO_DESKTOP_TEST_EXE, ['-e', script, modulePath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message || 'Desktop Host fixture failed');
});
