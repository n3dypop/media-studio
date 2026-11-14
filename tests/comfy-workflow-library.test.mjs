import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { comfyWorkflowLibrary } from '../apps/controller/comfy-workflow-library.mjs';
import { createPlugin } from '../apps/dsh-plugins/local-genai/index.mjs';

test('ComfyUI library filters and pages templates without promoting them to managed profiles', async t => {
  const userDirectory = await mkdtemp(path.join(tmpdir(), 'media-studio-library-'));
  t.after(() => rm(userDirectory, { recursive: true, force: true }));
  const write = async (file, value) => {
    const absolute = path.join(userDirectory, file);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, JSON.stringify(value));
  };
  const model = { category: 'diffusion_models', name: 'fasth3/v2/video.safetensors' };
  const video = { id: 'fasth3-t2v', family: 'FastVideo FastH3', label: 'Text to video',
    mode: 't2v', media: 'video', file: 'Media Studio/FastH3/t2v.json', models: [model] };
  const edit = { ...video, id: 'moss-edit', family: 'MOSS', label: 'Edit', mode: 'edit', media: 'image',
    file: 'Media Studio/MOSS/edit.json', models: [], profile: 'moss-profile' };
  await write('media-studio/workflow-catalog.json', { version: 1, workflows: [edit, video] });
  await write('default/workflows/' + video.file, { nodes: [{ type: 'uuid' }], definitions: {
    subgraphs: [{ id: 'uuid', nodes: [{ type: 'UNETLoader' }, { type: 'SaveVideo' }] }],
  } });
  await write('default/workflows/' + edit.file, { nodes: [{ type: 'SaveImage' }] });
  const objects = { SaveVideo: { api_node: true }, SaveImage: {}, UNETLoader: {
    input: { required: { unet_name: ['COMBO', { options: ['fasth3\\v2\\video.safetensors'] }] } },
  } };
  let discoveries = 0;
  const installed = async () => { discoveries++; return objects; };
  const options = { userDirectory, installed, catalog: async value => {
    assert.equal(value, objects);
    return [{ modelProfile: 'moss-profile', mode: 'edit' }];
  } };
  const result = await comfyWorkflowLibrary({ ...options, query: 'fasth3', media: 'video' });
  assert.equal(result.total, 1);
  assert.equal(result.workflows[0].state, 'dependencies-missing');
  assert.deepEqual(result.workflows[0].missingNodes, ['SaveVideo']);
  assert.equal(result.workflows[0].missingModels, undefined);
  assert.equal(result.workflows[0].dshProfile, undefined);
  const secondPage = await comfyWorkflowLibrary({ ...options, page: 2, limit: 1 });
  assert.equal(secondPage.total, 2);
  assert.equal(secondPage.workflows[0].state, 'static-ready');
  assert.equal(secondPage.workflows[0].dshProfile, 'moss-profile');
  assert.equal((await comfyWorkflowLibrary({ ...options, mode: 'layout' })).total, 0);
  assert.equal(discoveries, 2);
  await assert.rejects(comfyWorkflowLibrary({ ...options, limit: 26 }), { status: 400 });
});

test('DSH library tool forwards a video operation as a read-only query', async t => {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), 'media-studio-library-tool-'));
  await mkdir(path.join(runtimeRoot, 'data'));
  const response = { workflows: [{ id: 'video', resourceUsage: { modelDiskBytes: 10, runtime: null } }], total: 1 };
  const seen = [];
  const ctx = {
    sessions: {}, sessionPersistence: {}, agents: { get() {} },
    tools: { register() {}, presentAs() {}, guard() {} },
    on: () => () => {}, effect: fn => fn(),
    systemPrompt: { section() {}, getSectionOrder() {}, suppressRuntimeContext() {} },
  };
  const plugin = await createPlugin(ctx, { role: 'studio', runtimeRoot }, {
    scopeOf: () => ctx, scopeChainOf: () => [ctx], defineTool: definition => definition,
    loadConfiguration: async () => ({ controllerUrl: 'http://localhost', token: 'fixture' }),
    fetch: async (url, options) => {
      seen.push([options.method, new URL(url).pathname, new URL(url).searchParams.get('mode')]);
      return Response.json(response);
    },
  });
  t.after(async () => { await plugin.dispose(); await rm(runtimeRoot, { recursive: true, force: true }); });
  const tool = plugin.tools.find(tool => tool.name === 'local_workflow_library');
  assert.ok(tool);
  const result = await tool.execute({ operation: 't2v', media: 'video' },
    { agent: { session: { id: 'fixture' } }, callId: 'catalog-read', signal: new AbortController().signal });
  assert.deepEqual(result, { workflows: [{ id: 'video' }], total: 1 });
  assert.deepEqual(await tool.execute({ operation: 't2v', media: 'video', includeResources: true },
    { agent: { session: { id: 'fixture' } }, callId: 'catalog-resources', signal: new AbortController().signal }), response);
  assert.deepEqual(seen, [['GET', '/api/workflow-library', 't2v'], ['GET', '/api/workflow-library', 't2v']]);
});

test('ControlNet library entries resolve nested checkpoint and adapter names', async t => {
  const userDirectory = await mkdtemp(path.join(tmpdir(), 'media-studio-controlnet-library-'));
  t.after(() => rm(userDirectory, { recursive: true, force: true }));
  const file = 'Media Studio/ControlNet SD 1.5/depth-adapter.json';
  const checkpoint = 'sd15/base.safetensors';
  const adapter = 'sd15/adapter.pth';
  await mkdir(path.join(userDirectory, 'media-studio'));
  await mkdir(path.dirname(path.join(userDirectory, 'default/workflows', file)), { recursive: true });
  await writeFile(path.join(userDirectory, 'default/workflows', file), JSON.stringify({
    nodes: ['CheckpointLoaderSimple', 'ControlNetLoader', 'ControlNetApplyAdvanced', 'SaveImage'].map(type => ({ type })),
  }));
  await writeFile(path.join(userDirectory, 'media-studio/workflow-catalog.json'), JSON.stringify({
    version: 1,
    workflows: [{ id: 'controlnet-depth-adapter', family: 'ControlNet SD 1.5', label: 'Depth Adapter',
      mode: 'depth', media: 'image', file, models: [{ category: 'checkpoints', name: checkpoint },
        { category: 'controlnet', name: adapter }] }],
  }));
  const objects = {
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sd15\\base.safetensors']] } } },
    ControlNetLoader: { input: { required: { control_net_name: [['sd15\\adapter.pth']] } } },
    ControlNetApplyAdvanced: {}, SaveImage: {},
  };
  const options = { userDirectory, installed: async () => objects, catalog: async () => [] };
  const [ready] = (await comfyWorkflowLibrary(options)).workflows;
  assert.equal(ready.state, 'static-ready');
  assert.equal(ready.dshProfile, undefined);
  objects.ControlNetLoader.input.required.control_net_name = [[]];
  const [missing] = (await comfyWorkflowLibrary(options)).workflows;
  assert.equal(missing.state, 'dependencies-missing');
  assert.deepEqual(missing.missingModels, [adapter]);
});

test('resource figures use actual disk sizes and the matching workflow measurement', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'media-studio-workflow-resources-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userDirectory = path.join(root, 'user'), modelDirectory = path.join(root, 'models');
  const canvas = 'Media Studio/SD/depth.json', canvasPath = path.join(userDirectory, 'default/workflows', canvas);
  const graph = JSON.stringify({ nodes: [{ type: 'SaveImage' }] });
  const category = 'checkpoints', name = 'base.safetensors';
  const checkpoint = path.join(modelDirectory, category, 'sd', name);
  const indexDirectory = path.join(userDirectory, 'media-studio');
  await Promise.all([path.dirname(canvasPath), indexDirectory, path.dirname(checkpoint)]
    .map(directory => mkdir(directory, { recursive: true })));
  await writeFile(canvasPath, graph);
  await writeFile(checkpoint, Buffer.alloc(1024));
  const entry = { id: 'sd-depth', family: 'SD', label: 'Depth', mode: 'depth', media: 'image', file: canvas,
    models: [{ category, name }, { category, name }] };
  await writeFile(path.join(indexDirectory, 'workflow-catalog.json'), JSON.stringify({ version: 1, workflows: [entry] }));
  const sample = { width: 512, height: 512, gpu: 'RTX 4070 SUPER', sampleIntervalMs: 100,
    vramPeakDeltaBytes: 2000, ramWorkingSetPeakBytes: 3000 };
  await writeFile(path.join(indexDirectory, 'workflow-resource-observations.json'), JSON.stringify({
    version: 1, workflows: { 'sd-depth': { ...sample, workflowSha256: createHash('sha256').update(graph).digest('hex') } },
  }));
  const options = { userDirectory, modelDirectory, installed: async () => ({ SaveImage: {}, CheckpointLoaderSimple: {
    input: { required: { ckpt_name: [[name]] } },
  } }), catalog: async () => [] };
  const usage = async () => (await comfyWorkflowLibrary(options)).workflows[0].resourceUsage;
  assert.deepEqual(await usage(), { modelDiskBytes: 1024, runtime: { ...sample, frames: undefined } });
  await writeFile(canvasPath, graph + '\n');
  assert.deepEqual(await usage(), { modelDiskBytes: 1024, runtime: null });
  await writeFile(canvasPath, graph);
  const duplicate = path.join(modelDirectory, category, 'ambiguous', name);
  await mkdir(path.dirname(duplicate));
  await writeFile(duplicate, Buffer.alloc(1024));
  assert.deepEqual(await usage(), { modelDiskBytes: null, runtime: null });
});
