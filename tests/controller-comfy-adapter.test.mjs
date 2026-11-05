import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
// Exercise this repository's Controller directly in local tests and CI.
import { ComfyAdapter } from '../apps/controller/comfy.mjs';
import { MOSS_PROFILE } from '../apps/controller/workflows.mjs';

const RUN = '11111111-1111-4111-8111-111111111111';
const PROMPT = '22222222-2222-4222-8222-222222222222';
const CONTROLLER = 'test-controller';
const MiB = 1024 ** 2;
const EMPTY = { queue_running: [], queue_pending: [] };
const STATS = { devices: [{ type: 'cuda', name: 'mock CUDA', vram_free: 11 * 1024 ** 3,
  torch_vram_free: 20 * MiB, torch_vram_total: 32 * MiB }] };

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let n = 0; n < 8; n++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, checksum]);
}

function png(width = 512, height = 512, metadata = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    ...Object.entries(metadata).map(([key, value]) => chunk('tEXt', Buffer.from(`${key}\0${JSON.stringify(value)}`))),
    chunk('IDAT', deflateSync(Buffer.alloc((width * 3 + 1) * height))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function fixture(t, handler, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'local-image-comfy-test-'));
  const calls = [];
  const server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const bytes of request) raw += bytes;
    const body = raw ? JSON.parse(raw) : undefined;
    const url = new URL(request.url, 'http://127.0.0.1');
    calls.push({ method: request.method, route: url.pathname, query: url.searchParams, body });
    const reply = (value, status = 200) => {
      response.statusCode = status;
      response.setHeader('Content-Type', Buffer.isBuffer(value) ? 'image/png' : 'application/json');
      response.end(Buffer.isBuffer(value) ? value : JSON.stringify(value));
    };
    try {
      if (await handler?.({ request, response, route: url.pathname, query: url.searchParams, body, reply })) return;
      if (url.pathname === '/queue') return reply(EMPTY);
      if (url.pathname === '/system_stats') return reply(STATS);
      if (url.pathname.startsWith('/history/')) return reply({});
      if (url.pathname === '/free') return reply({});
      reply({ error: { type: 'not_found' } }, 404);
    } catch (error) { reply({ test_error: error.message }, 500); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    // This directory was created by this fixture and is never supplied by a request.
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const adapter = new ComfyAdapter({
    baseUrl: `http://127.0.0.1:${server.address().port}`, outputRoot: root,
    releasePollMs: 5, releaseTimeoutMs: 1_000, ...options,
  });
  return { adapter, root, calls };
}

function build(adapter, overrides = {}) {
  return adapter.buildPrompt({ prompt: 'A realistic photograph of a red ceramic cup.', negativePrompt: 'text, watermark',
    seed: '42', width: 512, height: 512, steps: 25, ...overrides },
  { runId: RUN, promptId: PROMPT, controllerId: CONTROLLER });
}

function historyFor(payload, status = { status_str: 'success', completed: true }) {
  return {
    prompt: [1, payload.prompt_id, payload.prompt, payload.extra_data, ['15']], status,
    outputs: { 15: { images: [{ filename: 'image_00001_.png', subfolder: `controller/${RUN}/${PROMPT}`, type: 'output' }] } },
  };
}

test('known Qwen chain preserves independent positive/negative conditioning; PE cannot run', async t => {
  const { adapter } = await fixture(t);
  const payload = build(adapter, { seed: '9007199254740991', width: 768, height: 1024 });
  assert.equal(payload.prompt['1'].inputs.prompt, 'A realistic photograph of a red ceramic cup.');
  assert.equal(payload.prompt['1'].inputs.negative_prompt, 'text, watermark');
  assert.deepEqual(payload.prompt['3'].inputs.negative, ['1', 1]);
  assert.equal(payload.prompt['3'].inputs.seed, Number.MAX_SAFE_INTEGER);
  assert.equal(payload.prompt['14'].inputs.width, 768);
  assert.equal(payload.prompt['14'].inputs.height, 1024);
  assert.equal(payload.prompt['3'].inputs.steps, 25);
  assert.equal(payload.prompt['70'].inputs.sage_attention, 'disabled');
  assert.equal(Object.keys(payload.prompt).length, 11);
  assert.equal(Object.values(payload.prompt).some(node => node.class_type.includes('llama')), false);
  assert.deepEqual(payload.extra_data.local_genai, { controller_id: CONTROLLER, run_id: RUN, prompt_id: PROMPT });
  assert.deepEqual(payload.extra_data.extra_pnginfo.local_genai, payload.extra_data.local_genai);
  assert.equal(build(adapter, { width: undefined, height: undefined }).prompt['14'].inputs.width, 1376);
  assert.throws(() => build(adapter, { seed: '9007199254740992' }), /serialized exactly/);
  assert.throws(() => build(adapter, { seed: 42 }), /decimal string/);
  assert.throws(() => build(adapter, { width: 1536, height: 1536 }), /Dimensions/);
  assert.throws(() => build(adapter, { steps: 41 }), /steps/);
});

test('preflight checks node classes and model inventory with platform separator normalization', async t => {
  let objects;
  let omitModel = false;
  const { adapter } = await fixture(t, ({ route, reply }) => {
    if (route === '/object_info') { reply(objects); return true; }
  });
  objects = Object.fromEntries(Object.values(adapter.profile).map(node => [node.class_type, { input: { required: {} } }]));
  for (const [id, input] of [['6', 'vae_name'], ['7', 'unet_name'], ['108', 'clip_name']]) {
    objects[adapter.profile[id].class_type].input.required[input] = [[adapter.profile[id].inputs[input].replaceAll('\\', '/')]];
  }
  const ready = await adapter.preflight();
  assert.equal(ready.ready, true);
  assert.equal(ready.queueEmpty, true);
  assert.match(ready.details.profileSha256, /^[0-9a-f]{64}$/);
  objects.UnetLoaderGGUF.input.required.unet_name = [[]];
  delete objects.SpectrumQwenImage21;
  const missing = await adapter.preflight();
  assert.equal(missing.ready, false);
  assert.deepEqual(missing.details.missingNodes, ['SpectrumQwenImage21']);
  assert.equal(missing.details.models.find(model => model.input === 'unet_name').available, false);
});

test('legacy Qwen preflight rejects declared API or developer nodes without submitting', async t => {
  let objects;
  const { adapter, calls } = await fixture(t, ({ route, reply }) => {
    if (route === '/object_info') { reply(objects); return true; }
  });
  objects = Object.fromEntries(Object.values(adapter.profile).map(node => [node.class_type, { input: { required: {} } }]));
  for (const [id, input] of [['6', 'vae_name'], ['7', 'unet_name'], ['108', 'clip_name']]) {
    objects[adapter.profile[id].class_type].input.required[input] = [[adapter.profile[id].inputs[input]]];
  }
  for (const flag of ['api_node', 'dev_only']) {
    objects.QwenImage21Cache[flag] = true;
    const result = await adapter.preflight({modelProfile:'qwen-photo-v1'});
    assert.equal(result.ready,false);
    assert.deepEqual(result.details.unsafeNodes,['QwenImage21Cache']);
    objects.QwenImage21Cache[flag] = false;
  }
  assert.equal((await adapter.preflight({modelProfile:'qwen-photo-v1'})).ready,true);
  assert.equal(calls.filter(call => call.route === '/prompt').length,0);
});

test('lost submit response is unknown and is never retried, including a repeated local call', async t => {
  const { adapter, calls } = await fixture(t, ({ route, request }) => {
    if (route === '/prompt') { request.socket.destroy(); return true; }
  });
  const payload = build(adapter);
  await assert.rejects(adapter.submit(payload), error => error.submissionUnknown === true && error.definitelyRejected === false);
  await assert.rejects(adapter.submit(payload), error => error.submissionUnknown === true && /Duplicate/.test(error.message));
  assert.equal(calls.filter(call => call.route === '/prompt').length, 1);
});

test('only explicit 400 validation is definitely rejected; partial acceptance remains accepted', async t => {
  let mode = 'reject';
  const { adapter } = await fixture(t, ({ route, reply, body }) => {
    if (route !== '/prompt') return false;
    if (mode === 'reject') reply({ error: { type: 'prompt_outputs_failed_validation' }, node_errors: { 15: {} } }, 400);
    else reply({ prompt_id: body.prompt_id, node_errors: { 15: { errors: ['partial'] } } });
    return true;
  });
  await assert.rejects(adapter.submit(build(adapter)), error => error.submissionUnknown === false && error.definitelyRejected === true);
  mode = 'partial';
  const payload = adapter.buildPrompt({ prompt: 'A simple cup.', seed: '43' },
    { runId: RUN, promptId: '33333333-3333-4333-8333-333333333333', controllerId: CONTROLLER });
  const accepted = await adapter.submit(payload);
  assert.equal(accepted.prompt_id, payload.prompt_id);
  assert.equal(Object.keys(accepted.node_errors).length, 1);
});

test('HTTP 400 containing a prompt ID is not classified as definitely rejected', async t => {
  const { adapter } = await fixture(t, ({ route, reply, body }) => {
    if (route === '/prompt') {
      reply({ prompt_id: body.prompt_id, error: { type: 'partial_failure' }, node_errors: {} }, 400);
      return true;
    }
  });
  await assert.rejects(adapter.submit(build(adapter)), error => error.submissionUnknown === true && error.definitelyRejected === false);
});

test('HTTP timeout is submission_unknown without retry', async t => {
  // Allow the loopback request to reach the fixture even during parallel CI;
  // the fixture intentionally never responds so the timeout remains real.
  const { adapter, calls } = await fixture(t, ({ route }) => route === '/prompt', { timeoutMs: 500 });
  await assert.rejects(adapter.submit(build(adapter)), error => error.submissionUnknown === true);
  assert.equal(calls.filter(call => call.route === '/prompt').length, 1);
});

test('inspect exposes actual ownership and cancel uses only the targeted endpoint', async t => {
  let item;
  const { adapter, calls } = await fixture(t, ({ route, reply }) => {
    if (route === '/queue') { reply({ queue_running: [item], queue_pending: [] }); return true; }
    if (route === `/api/jobs/${PROMPT}/cancel`) { reply({ cancelled: true }); return true; }
  });
  const payload = build(adapter);
  item = [1, PROMPT, payload.prompt, payload.extra_data];
  const inspected = await adapter.inspect(PROMPT);
  assert.equal(inspected.running, true);
  assert.equal(inspected.queued, false);
  assert.equal(inspected.history, null);
  assert.deepEqual(inspected.extraData.local_genai, payload.extra_data.local_genai);
  assert.deepEqual(await adapter.cancel(PROMPT), { cancelled: true });
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(calls.some(call => call.route === '/interrupt'), false);
});

test('duplicate, foreign and uncertain queue/history entries stop observation and collection',async t=>{
  let queue,history;
  const {adapter,calls,root}=await fixture(t,({route,reply})=>{
    if(route==='/queue'){reply(queue);return true;}
    if(route===`/history/${PROMPT}`){reply(history??{});return true;}
  });
  const payload=build(adapter),own=[1,PROMPT,payload.prompt,payload.extra_data],foreign=[2,PROMPT,{}, {local_genai:{controller_id:'foreign',run_id:RUN,prompt_id:PROMPT}}];
  for(const [running,pending] of [[[own,foreign],[]],[[foreign,own],[]],[[own],[foreign]],[[],[own,foreign]]]){
    queue={queue_running:running,queue_pending:pending};history={};
    await assert.rejects(adapter.inspect(PROMPT),/Duplicate queue entries/);
    await assert.rejects(adapter.collect(PROMPT,{runId:RUN,controllerId:CONTROLLER,destination:path.join(root,RUN)}),/Duplicate queue entries/);
  }
  queue={queue_running:[own],queue_pending:[[3,'33333333-3333-4333-8333-333333333333',{},{}]]};
  await assert.rejects(adapter.inspect(PROMPT),/Unmanaged queue/);
  queue={queue_running:[own],queue_pending:[]};history={[PROMPT]:historyFor(payload)};
  await assert.rejects(adapter.inspect(PROMPT),/both queue and history/);
  queue=EMPTY;history={[PROMPT]:{prompt:[0,PROMPT,{},null]}};
  await assert.rejects(adapter.collect(PROMPT,{runId:RUN,controllerId:CONTROLLER}),/malformed/);
  history={[PROMPT]:null};await assert.rejects(adapter.inspect(PROMPT),/Unexpected ComfyUI history/);
  history={'33333333-3333-4333-8333-333333333333':{}};await assert.rejects(adapter.inspect(PROMPT),/Unexpected ComfyUI history/);
  assert.equal(calls.some(c=>c.route.startsWith('/api/jobs/')||c.route==='/view'),false);
});

test('a separate targeted cancel cannot make a preceding ownership snapshot atomic',async t=>{
  let active,foreignCancelled=false;
  const {adapter}=await fixture(t,({route,reply})=>{
    if(route==='/queue'){reply({queue_running:[active],queue_pending:[]});return true;}
    if(route===`/api/jobs/${PROMPT}/cancel`){foreignCancelled=active[3].local_genai.controller_id==='foreign';reply({cancelled:true});return true;}
  });
  const payload=build(adapter);active=[1,PROMPT,payload.prompt,payload.extra_data];
  assert.equal((await adapter.inspect(PROMPT)).extraData.local_genai.controller_id,CONTROLLER);
  // An unmanaged client can replace an owned job with the same ID between
  // separate HTTP requests. This is a synthetic demonstration, not safe use.
  active=[2,PROMPT,{}, {local_genai:{controller_id:'foreign',run_id:RUN,prompt_id:PROMPT}}];
  assert.deepEqual(await adapter.cancel(PROMPT),{cancelled:true});assert.equal(foreignCancelled,true);
});

test('owned partial PNG is validated and retained on failure; repeat collection does not overwrite', async t => {
  let history;
  const image = png();
  const { adapter, root } = await fixture(t, ({ route, reply, query }) => {
    if (route === `/history/${PROMPT}`) { reply({ [PROMPT]: history }); return true; }
    if (route === '/view') {
      assert.equal(query.get('type'), 'output');
      reply(image); return true;
    }
  });
  history = historyFor(build(adapter), { status_str: 'error', completed: false });
  const context = { runId: RUN, controllerId: CONTROLLER, destination: path.join(root, RUN) };
  const artifacts = await adapter.collect(PROMPT, context);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].width, 512);
  assert.equal(artifacts[0].height, 512);
  assert.equal(artifacts[0].mime, 'image/png');
  assert.match(artifacts[0].sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(await readFile(artifacts[0].path), image);
  assert.deepEqual(await adapter.collect(PROMPT, context), artifacts);
  await writeFile(artifacts[0].path, 'different');
  await assert.rejects(adapter.collect(PROMPT, context), /refusing overwrite/);
});

test('native MOSS collection requires its model tag and saves only node 15 with exact bytes and hash', async t => {
  let history;
  const image = png();
  const { adapter, root, calls } = await fixture(t, ({ route, reply, query }) => {
    if (route === `/history/${PROMPT}`) { reply({ [PROMPT]: history }); return true; }
    if (route === '/view') {
      assert.equal(query.get('filename'), 'image_00001_.png');
      assert.equal(query.get('subfolder'), `controller/${RUN}/${PROMPT}`);
      assert.equal(query.get('type'), 'output');
      reply(image); return true;
    }
  }, {
    modelProfile: MOSS_PROFILE,
    profilePath: fileURLToPath(new URL('../workflows/approved/moss-image-sft-int8-v1.json', import.meta.url)),
  });
  const graph = structuredClone(adapter.profile);
  Object.assign(graph['14'].inputs, { width: 512, height: 512 });
  graph['15'].inputs.filename_prefix = `controller/${RUN}/${PROMPT}/image`;
  const ownership = { controller_id: CONTROLLER, run_id: RUN, prompt_id: PROMPT };
  history = historyFor({ prompt_id: PROMPT, prompt: graph, extra_data: {
    local_genai: ownership, model_profile: MOSS_PROFILE,
    extra_pnginfo: { local_genai: ownership, model_profile: MOSS_PROFILE },
  } });
  assert.equal(history.prompt[2]['15'].class_type, 'SaveImage');
  // Another image-bearing output sorts before node 15; it must never be fetched.
  history.outputs['5'] = { images: [{ filename: 'image_wrong_node.png',
    subfolder: `controller/${RUN}/${PROMPT}`, type: 'output' }] };
  const context = { runId: RUN, controllerId: CONTROLLER, destination: path.join(root, RUN) };
  delete history.prompt[3].model_profile;
  await assert.rejects(adapter.collect(PROMPT, context), /Unexpected output node/);
  history.prompt[3].model_profile = 'qwen-photo-v1';
  await assert.rejects(adapter.collect(PROMPT, context), /Unexpected output node/);
  assert.equal(calls.filter(call => call.route === '/view').length, 0);
  history.prompt[3].model_profile = MOSS_PROFILE;
  const artifacts = await adapter.collect(PROMPT, context);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].name, `${PROMPT}-image_00001_.png`);
  assert.equal(artifacts[0].sha256, createHash('sha256').update(image).digest('hex'));
  assert.deepEqual(await readFile(artifacts[0].path), image);
  assert.equal(calls.filter(call => call.route === '/view').length, 1);
});

test('legacy Qwen history and PNG without model_profile remain collectable', async t => {
  let history, image;
  const { adapter, root } = await fixture(t, ({ route, reply }) => {
    if (route === `/history/${PROMPT}`) { reply({ [PROMPT]: history }); return true; }
    if (route === '/view') { reply(image); return true; }
  });
  const payload = build(adapter);
  delete payload.extra_data.model_profile;
  delete payload.extra_data.extra_pnginfo.model_profile;
  history = historyFor(payload);
  image = png(512, 512, payload.extra_data.extra_pnginfo);
  assert.equal(history.prompt[2]['15'].class_type, 'SaveImageAdvanced');
  assert.equal(JSON.stringify(history).includes('model_profile'), false);
  assert.equal(image.includes(Buffer.from('model_profile')), false);
  assert.equal(image.includes(Buffer.from('local_genai')), true);
  const artifacts = await adapter.collect(PROMPT, {
    runId: RUN, controllerId: CONTROLLER, destination: path.join(root, RUN),
  });
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].sha256, createHash('sha256').update(image).digest('hex'));
  assert.deepEqual(await readFile(artifacts[0].path), image);
});

test('matching prefix cannot authorize foreign output; invalid references and corrupt PNG are refused', async t => {
  let history;
  let image = png();
  const { adapter, root, calls } = await fixture(t, ({ route, reply }) => {
    if (route === `/history/${PROMPT}`) { reply({ [PROMPT]: history }); return true; }
    if (route === '/view') { reply(image); return true; }
  });
  history = historyFor(build(adapter));
  const context = { runId: RUN, controllerId: CONTROLLER, destination: root };
  history.prompt[3].local_genai.controller_id = 'foreign';
  await assert.rejects(adapter.collect(PROMPT, context), /ownership/);
  assert.equal(calls.some(call => call.route === '/view'), false);
  history.prompt[3].local_genai.controller_id = CONTROLLER;
  history.outputs['15'].images[0].filename = '../image.png';
  await assert.rejects(adapter.collect(PROMPT, context), /Unsafe/);
  history.outputs['15'].images[0].filename = 'image_00001_.png';
  image = png(513, 512);
  await assert.rejects(adapter.collect(PROMPT, context), /dimensions differ/);
  image = png();
  image[35] ^= 1;
  await assert.rejects(adapter.collect(PROMPT, context), /checksum/);
  await assert.rejects(adapter.collect(PROMPT, { ...context, destination: path.dirname(root) }), /escapes/);
});

test('collection rejects destination links/junctions', async t => {
  let history;
  const { adapter, root } = await fixture(t, ({ route, reply }) => {
    if (route === `/history/${PROMPT}`) { reply({ [PROMPT]: history }); return true; }
  });
  history = historyFor(build(adapter));
  const actual = path.join(root, 'actual');
  const linked = path.join(root, 'linked');
  await mkdir(actual);
  try { await symlink(actual, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('This host cannot create a test junction'); return; } throw error; }
  await assert.rejects(adapter.collect(PROMPT, { runId: RUN, controllerId: CONTROLLER, destination: linked }), /link/);
});

test('release requires empty queue and does not send free when any job exists', async t => {
  const { adapter, calls } = await fixture(t, ({ route, reply }) => {
    if (route === '/queue') { reply({ queue_running: [[1, PROMPT, {}, { local_genai: { controller_id: 'foreign' } }]], queue_pending: [] }); return true; }
  });
  await assert.rejects(adapter.release(), /nonempty or foreign queue/);
  assert.equal(calls.some(call => call.route === '/free'), false);
});

test('release accepts stable 32 MiB residue and uses driver-free evidence without double-counting', async t => {
  const { adapter, calls } = await fixture(t);
  const result = await adapter.release();
  assert.equal(result.released, true);
  assert.equal(result.torchReservedBytes, 32 * MiB);
  assert.equal(result.driverFreeBytes, 11 * 1024 ** 3 - 20 * MiB);
  assert.equal(result.samples.length, 3);
  assert.equal(calls.filter(call => call.route === '/free').length, 1);
  assert.deepEqual(calls.find(call => call.route === '/free').body, { unload_models: true, free_memory: true });
});
test('explicit unload confirms Comfy residue without requiring space held by the loaded core',async t=>{
  const {adapter,calls}=await fixture(t,({route,reply})=>{
    if(route==='/system_stats'){reply({devices:[{type:'cuda',vram_free:3*1024**3,torch_vram_free:20*MiB,torch_vram_total:32*MiB}]});return true;}
  });
  const original=adapter.releaseMinFreeBytes,result=await adapter.release({minFreeBytes:0});
  assert.equal(result.released,true);assert.equal(result.minDriverFreeBytes,0);assert.equal(adapter.releaseMinFreeBytes,original);assert.equal(calls.filter(x=>x.route==='/free').length,1);
});

test('explicit recovery epoch guard prevents free after a server change during the empty-queue check', async t => {
  const {adapter,calls}=await fixture(t);let checks=0;
  await assert.rejects(adapter.release({assertEpoch:async()=>{if(++checks===2)throw new Error('epoch changed');}}),/epoch changed/);
  assert.equal(calls.filter(call=>call.route==='/free').length,0);
});

test('explicit recovery epoch guard cannot certify release after the server changes following free', async t => {
  const {adapter,calls}=await fixture(t);let checks=0;
  await assert.rejects(adapter.release({assertEpoch:async()=>{if(++checks===3)throw new Error('epoch changed');}}),/epoch changed/);
  assert.equal(calls.filter(call=>call.route==='/free').length,1);
  assert.equal(calls.filter(call=>call.route==='/system_stats').length,0);
});

test('insufficient memory never becomes release success and free is not retried', async t => {
  const { adapter, calls } = await fixture(t, ({ route, reply }) => {
    if (route === '/system_stats') {
      reply({ devices: [{ type: 'cuda', vram_free: 10 * 1024 ** 3, torch_vram_free: 9 * 1024 ** 3, torch_vram_total: 9 * 1024 ** 3 }] });
      return true;
    }
  }, { releaseTimeoutMs: 80, releasePollMs: 5 });
  await assert.rejects(adapter.release());
  assert.equal(calls.filter(call => call.route === '/free').length, 1);
});

test('a newly appearing job stops release observation and keeps the lease unresolved', async t => {
  let queueReads = 0;
  const { adapter, calls } = await fixture(t, ({ route, reply }) => {
    if (route === '/queue') {
      queueReads++;
      reply(queueReads === 1 ? EMPTY : { queue_running: [], queue_pending: [[2, PROMPT, {}, {}]] });
      return true;
    }
  });
  await assert.rejects(adapter.release(), /retain GPU lease/);
  assert.equal(calls.filter(call => call.route === '/free').length, 1);
});
