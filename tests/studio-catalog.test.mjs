import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { strataCatalog } from '../apps/controller/strata-catalog.mjs';
import { monitorHandler } from '../apps/dsh-plugins/studio-monitor/index.mjs';

test('Strata catalog separates the verified configuration from observed load state', async t => {
  const root = await mkdtemp(join(tmpdir(), 'studio-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'data/strata');
  const runtime = join(root, 'runtime');
  await Promise.all([mkdir(data, { recursive: true }), mkdir(runtime)]);
  const productRoot = join(root, 'product');
  const configDir = join(productRoot, '.runtime/local-serve');
  await mkdir(configDir, { recursive: true });
  const config = join(configDir, 'serve-config.json');
  const source = JSON.stringify({ model_name: 'fixture', args: ['--native', 'C:/private/weights.gguf', '--max-context', '32768', '--resident-budget-gib', '20'],
    vision: { mmproj: 'C:/private/mmproj.gguf' }, api_key: 'not-for-client' });
  const hash = createHash('sha256').update(source).digest('hex');
  await writeFile(config, source);
  await writeFile(join(data, 'installation.json'), JSON.stringify({
    prepared: true, model: 'fixture', productRoot, config, configSha256: hash, modelSource: { repository: 'fixture/model', quantization: 'Q4' },
  }));
  const record = join(runtime, 'Strata.json');
  const receipt = { processId: 123, started: 42, instanceId: 'epoch', configSha256: hash };
  await writeFile(record, JSON.stringify(receipt));
  const status = { started: 42, model: 'fixture', engine: '0.1.59', loaded: true, vision: { enabled: true, available: false } };
  const strata = { status: async () => status, identity: { pid: 123, instanceId: 'epoch' } };
  const result = await strataCatalog({ root, strata });
  assert.equal(result.configured.weights, 'weights.gguf');
  assert.equal(result.configured.context, 32768);
  assert.equal(result.configured.residentRamBudgetBytes, 20 * 1024 ** 3);
  assert.equal(result.running.state, 'loaded');
  assert.equal(result.running.vision, 'unknown');
  assert.equal(result.configurationMatch, true);
  assert.doesNotMatch(JSON.stringify(result), /private|not-for-client/);
  status.loaded = false;
  await writeFile(record, JSON.stringify({ ...receipt, configSha256: 'f'.repeat(64) }));
  const changed = await strataCatalog({ root, strata });
  assert.equal(changed.running.state, 'unloaded');
  assert.equal(changed.configurationMatch, false);
  await writeFile(config, source + ' ');
  const unverified = await strataCatalog({ root, strata });
  assert.equal(unverified.configured, null);
  assert.equal(unverified.configurationMatch, null);
});

test('catalog forwarding is read-only and checks an existing conversation', async () => {
  const calls = [];
  const handler = monitorHandler({
    filters: ['media', 'page'],
    sessionQuery: { observeSession: async id => { if (id !== 'mine') throw Error(); } },
    controllerRequest: async ({ sessionId, params }) => { calls.push([sessionId, ...params]); return {}; },
  });
  const request = (query, method) => handler(new Request('http://localhost/catalog?' + query, { method }));
  assert.equal((await request('sessionId=mine&media=video&page=2')).status, 200);
  assert.equal((await request('sessionId=other&media=video')).status, 404);
  assert.equal((await request('sessionId=mine&media=video&media=image')).status, 400);
  assert.equal((await request('sessionId=mine&path=elsewhere')).status, 400);
  assert.equal((await request('sessionId=mine', 'POST')).status, 405);
  assert.deepEqual(calls, [['mine', ['media', 'video'], ['page', '2']]]);
});

test('DSH registers Catalog and Media & Resources as distinct sidebar tabs', async () => {
  let entry;
  const source = await readFile(new URL('../apps/dsh-plugins/studio-monitor/client.js', import.meta.url), 'utf8');
  runInNewContext(source, { window: { __ModuleLoader__: { load: value => { entry = value; } } } });
  const client = entry.factory(id => id === 'react' ? {} : { Button() {} });
  const tabs = [], slots = [];
  client.apply({
    effect: fn => fn(),
    locale: { register() {}, bind: () => key => key },
    sidebarRightTabs: { register: tab => tabs.push(tab) },
    slots: { inject: (_, register) => register(), register: slot => slots.push(slot) },
  });
  assert.deepEqual(tabs.map(tab => tab.kind), ['studio-monitor', 'studio-catalog']);
  assert.ok(slots.some(slot => slot.name === 'sidebar.right.pane.tab' && slot.key === 'studio-catalog'));
});
