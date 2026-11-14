import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  const byModel = await comfyWorkflowLibrary({ ...options, query: 'fasth3/v2/video.safetensors' });
  assert.equal(byModel.workflows[0].id, video.id);
  assert.deepEqual(byModel.operations, ['edit', 't2v']);
  const byProfile = await comfyWorkflowLibrary({ ...options, query: 'moss-profile', catalog: () => [] });
  assert.equal(byProfile.workflows[0].unavailableDshProfile, 'moss-profile');
  assert.equal(byProfile.workflows[0].dshProfile, undefined);
  assert.equal(byProfile.workflows[0].state, 'static-ready');
  const exact = await comfyWorkflowLibrary({ ...options, id: video.id });
  assert.equal(exact.total, 1);
  assert.deepEqual(exact.workflows[0].details.inputs, []);
  assert.deepEqual(exact.workflows[0].details.outputs, ['SaveVideo']);
  assert.deepEqual(exact.workflows[0].details.models, [model]);
  assert.equal(exact.workflows[0].details.steps.length, 3);
  assert.equal(byModel.workflows[0].details, undefined);
  assert.deepEqual((await comfyWorkflowLibrary({ ...options, id: video.file.replaceAll('/', '\\') })).workflows, exact.workflows);
  assert.equal((await comfyWorkflowLibrary({ ...options, query: 'FastH3/t2v.json' })).total, 1);
  await assert.rejects(comfyWorkflowLibrary({ ...options, id: '../t2v' }), { status: 400 });
  await assert.rejects(comfyWorkflowLibrary({ ...options, limit: 26 }), { status: 400 });
  assert.deepEqual((await comfyWorkflowLibrary({ ...options, reference: `「${video.id.toUpperCase()}」を使う` })).workflows.map(row => row.id), [video.id]);
  assert.deepEqual((await comfyWorkflowLibrary({ ...options, reference: `Use ${video.file.replaceAll('/', '\\')}` })).workflows.map(row => row.id), [video.id]);
  assert.equal((await comfyWorkflowLibrary({ ...options, reference: `skip-${video.id}` })).total, 0);
  await assert.rejects(comfyWorkflowLibrary({ ...options, reference: video.id, query: 'other' }), { status: 400 });
});

test('DSH library tool forwards a video operation as a read-only query', async t => {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), 'media-studio-library-tool-'));
  await mkdir(path.join(runtimeRoot, 'data'));
  const response = { workflows: [{ id: 'video', resourceUsage: { modelDiskBytes: 10, runtime: null } }], total: 1 };
  const seen = [];
  const registrations = new Map();
  const ctx = {
    sessions: {}, sessionPersistence: {}, agents: { get() {} },
    tools: { register(definition, activation) { registrations.set(definition.name, activation); }, presentAs() {}, guard() {} },
    on: () => () => {}, effect: fn => fn(),
    systemPrompt: { section() {}, getSectionOrder() {}, suppressRuntimeContext() {} },
  };
  const plugin = await createPlugin(ctx, { role: 'studio', runtimeRoot }, {
    scopeOf: () => ctx, scopeChainOf: () => [ctx], defineTool: definition => definition,
    loadConfiguration: async () => ({ controllerUrl: 'http://localhost', token: 'fixture' }),
    fetch: async (url, options) => {
      const parsed = new URL(url);
      seen.push([options.method, parsed.pathname, parsed.searchParams.get('mode'), parsed.searchParams.get('id')]);
      if (parsed.pathname === '/api/workflow-library/selection' && /Qwen/i.test(JSON.parse(options.body).reference)) {
        return Response.json({total:0,workflows:[]});
      }
      if (parsed.pathname === '/api/workflow-catalog') {
        return Response.json({capabilities:[{modelProfile:'qwen-image-2.1-turbo-v1',mode:'edit'}]});
      }
      if (parsed.pathname === '/api/productions/production' && parsed.searchParams.has('includeWorkflowAdvisories')) {
        return Response.json({production:{id:'production'},workflowAdvisories:[{
          id:'example',recommendation:{status:'not-recommended',issue:'abnormal-termination',summary:'OS bugcheck'},
        }]});
      }
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
  const exec = { agent: { session: { id: 'fixture' } }, callId: 'workflow-details', signal: new AbortController().signal };
  assert.equal((await tool.execute({ id: 'video' }, exec)).workflows[0].id, 'video');
  assert.equal((await tool.execute({ query: 'MiniMax H3 Image edit dependencies custom nodes model files required inputs execution steps' }, exec)).status, 'invalid_filter');
  assert.deepEqual(seen, [['GET', '/api/workflow-library', 't2v', null], ['GET', '/api/workflow-library', 't2v', null], ['GET', '/api/workflow-library', null, 'video']]);
  const { when } = registrations.get('local_workflow_library');
  const events = [{ type: 'turn/start' }, ...Array.from({ length: 4 }, () => ({ type: 'tool/call', data: { name: 'local_workflow_library' } }))];
  exec.agent.session.snapshotEvents = () => events;
  assert.equal(when(exec), false);
  events.push({ type: 'turn/end' }, { type: 'turn/start' });
  assert.equal(when(exec), true);
  const workflowPath = 'Media Studio/FastH3/t2v.json';
  events.push({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text',
    text: `ComfyUI単体のワークフロー「FastH3」（${workflowPath}）の入力素材・依存関係と実行手順を教えてください。`,
  }] } });
  const contexts = [];
  exec.deferContext = context => contexts.push(context);
  response.workflows[0].file = workflowPath;
  const byPath = await tool.execute({ id: workflowPath.replaceAll('/', '\\') }, exec);
  assert.equal(byPath.workflows[0].id, 'video');
  assert.equal(seen.at(-1)[3], workflowPath);
  assert.equal(contexts[0].source.summary, 'catalog-answer-ready');
  events.push({ type: 'user/message', data: contexts[0] });
  assert.equal(when(exec), false);
  events.splice(-2, 2, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text',
    text: 'ワークフロー「FastH3」（ワークフローID: video）のDSHでの登録・依存状況と、必要な保守作業を教えてください。',
  }] } });
  await tool.execute({ id: 'a-different-workflow', query: 'wrong name', page: 3 }, exec);
  assert.equal(seen.at(-1)[3], 'video');
  assert.equal(contexts.length, 2);
  const create = plugin.tools.find(tool => tool.name === 'local_production_create');
  const blocked = await create.execute({ request: 'Edit a cup.', modelProfile: 'moss-image-sft-official-v1', mode:'edit' }, exec);
  assert.equal(blocked.status, 'workflow_unavailable_in_dsh');
  assert.equal(blocked.workflow.id, 'video');
  assert.deepEqual(seen.filter(([method]) => method === 'POST'), [['POST', '/api/workflow-library/selection', null, null]]);
  const label = 'Qwen-Image 2.1 Turbo で編集';
  const call = {type:'tool/call',seq:20,data:{callId:'choice',name:'ask_user_question',turn:1,step:4,
    arguments:JSON.stringify({questions:[{id:'model_choice',options:[{label},{label:'生成しない'}]}]})}};
  const answer = selected => ({type:'tool/result',seq:21,sourceEventSeqs:[20],data:{turn:1,step:4,
    message:{role:'tool',source:{kind:'tool',callId:'choice'},toolCallId:'choice',isError:false,
      content:[{type:'text',text:JSON.stringify({answers:[{id:'model_choice',selected:[selected]}]})}]}}});
  events.push(call, answer(label));
  const mismatch = await create.execute({request:'Recolor a cup',modelProfile:'moss-image-sft-official-v1',mode:'edit'},exec);
  assert.equal(mismatch.status,'workflow_selection_mismatch');
  assert.equal(mismatch.workflow.dshProfile,'qwen-image-2.1-turbo-v1');
  events[events.length-1] = answer('生成しない');
  assert.equal((await create.execute({request:'Recolor a cup',modelProfile:'qwen-image-2.1-turbo-v1',mode:'edit'},exec)).status,'generation_declined');
  events[events.length-1] = answer('Qwen-Image 2.1 Base で編集'); // option never offered
  assert.equal((await create.execute({request:'Recolor a cup',modelProfile:'qwen-image-2.1-turbo-v1',mode:'edit'},exec)).status,'workflow_unavailable_in_dsh');

  const render = plugin.tools.find(tool => tool.name === 'local_prepared_render');
  const settings = {productionId:'production',workflowId:'draft',expectedRevision:2};
  const notice = await render.execute(settings, exec);
  assert.equal(notice.status, 'workflow_warning');
  assert.match(notice.warnings[0].recommendation.summary, /OS bugcheck/);
  assert.ok(!seen.some(([method, url]) => method==='POST' && url.endsWith('/render-prepared')));
  call.data.arguments=JSON.stringify({questions:[{id:notice.questionId,options:[{label:'実行する'},{label:'中止する'}]}]});
  const riskAnswer = selected => {
    const event = answer(selected);
    event.data.message.content[0].text=JSON.stringify({answers:[{id:notice.questionId,selected:[selected]}]});
    return event;
  };
  events[events.length-1]=riskAnswer('中止する');
  assert.equal((await render.execute(settings,exec)).status,'generation_declined');
  events[events.length-1]=riskAnswer('実行する');
  assert.equal((await render.execute({...settings,expectedRevision:3},exec)).status,'workflow_warning');
  // Approval allows the request to reach the existing vision and admission checks.
  let visionChecks=0;
  ctx.llm={resolveModelInfo:async()=>{visionChecks++;return {inputModalities:[]};}};
  exec.agent.options={provider:'local-strata',model:'strata-core'};
  await assert.rejects(() => render.execute({expectedRevision:2,workflowId:'draft',productionId:'production'},exec));
  assert.equal(visionChecks,1);
});

test('a MiniMax H3 edit lookup reports the saved template inputs and defaults', async t => {
  const userDirectory = await mkdtemp(path.join(tmpdir(), 'media-studio-h3-edit-library-'));
  t.after(() => rm(userDirectory, { recursive: true, force: true }));
  const entry = { id: 'minimax-h3-image-edit', family: 'MiniMax H3 Image', label: 'MiniMax H3 Image Edit',
    mode: 'edit', media: 'image', file: 'Media Studio/MiniMax H3 Image/image_minimax_h3_image_edit.json', models: [] };
  const graphPath = path.join(userDirectory, 'default/workflows', entry.file);
  await mkdir(path.dirname(graphPath), { recursive: true });
  await mkdir(path.join(userDirectory, 'media-studio'));
  const nodes = [
    { type: 'LoadImage' },
    { type: 'PrimitiveStringMultiline', title: 'Text (user_prompt)', widgets_values: ['Example prompt'] },
    { type: 'PrimitiveBoolean', title: 'Boolean (Enable PE?)', widgets_values: [false] },
    { type: 'MiniMaxH3ImageConditioning' },
    { type: 'ResizeImageMaskNode', widgets_values: ['scale total pixels', 4] },
    { type: 'ResizeImageMaskNode', widgets_values: ['scale to multiple', 32] },
    { type: 'KSampler', widgets_values: [0, 'fixed', 6, 1, 'euler', 'simple', 1] },
    { type: 'SaveImage' },
  ];
  await writeFile(graphPath, JSON.stringify({ nodes }));
  await writeFile(path.join(userDirectory, 'media-studio/workflow-catalog.json'), JSON.stringify({ version: 1, workflows: [entry] }));
  const options = { userDirectory, installed: async () => Object.fromEntries(nodes.map(({ type }) => [type, {}])) };
  const [row] = (await comfyWorkflowLibrary({ ...options, id: entry.id })).workflows;
  assert.equal(row.state, 'static-ready');
  assert.equal(row.dshProfile, undefined);
  for (const reference of ['MiniMax H3 Image editでマグカップを編集', 'image_minimax_h3_image_edit.jsonは使えますか？']) {
    const selection = await comfyWorkflowLibrary({ ...options, reference });
    assert.equal(selection.total, 1);
    assert.equal(selection.workflows[0].id, entry.id);
    assert.equal(selection.workflows[0].dshProfile, undefined);
  }
  assert.deepEqual(row.details.inputs, ['LoadImage']);
  assert.deepEqual(row.details.outputs, ['SaveImage']);
  assert.equal(row.details.promptEnhancerEnabled, false);
  assert.equal(row.details.resizeTargetMegapixels, 4);
  assert.equal(row.details.resizeMultiple, 32);
  assert.deepEqual(row.details.sampler, { steps: 6, cfg: 1, sampler: 'euler', scheduler: 'simple', denoise: 1 });
  assert.match(row.details.steps[1], /user_prompt/);
  assert.doesNotMatch(JSON.stringify(row), /Example prompt/);
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
  const readRow = async (extra = {}) => (await comfyWorkflowLibrary({ ...options, ...extra })).workflows[0];
  const usage = async () => {
    const { modelDiskBytes, runtime } = (await readRow()).resourceUsage;
    return { modelDiskBytes, runtime };
  };
  assert.deepEqual(await usage(), { modelDiskBytes: 1024, runtime: { ...sample, frames: undefined } });
  const observed = () => ({ gpu:'NVIDIA GeForce RTX 4070 SUPER', capacity:{vramBytes:10000,ramBytes:20000,commitBytes:30000},
    available:{vramBytes:2200,ramBytes:8000,commitBytes:17000} });
  const observationsFile = path.join(indexDirectory, 'workflow-resource-observations.json');
  const measured = await readFile(observationsFile);
  assert.equal((await readRow({observeResources:observed})).recommendation, undefined, 'Transient shortage is advisory only');
  const metrics = (await readRow({observeResources:observed})).resourceUsage.metrics;
  assert.deepEqual(metrics[0], {key:'vramBytes',minimumBytes:null,headroomBytes:2400,capacityBytes:10000,availableBytes:2200,state:'below-headroom'});
  assert.equal(metrics[2].state, 'unknown', 'Do not infer Windows commit from working set or model bytes');
  const hash = createHash('sha256').update(graph).digest('hex');
  const assessment = { workflowSha256:hash, minimum:{commitBytes:31000} };
  await writeFile(observationsFile, JSON.stringify({ version:1, assessments:{'sd-depth':assessment} }));
  const shortage = (await readRow({observeResources:observed})).recommendation;
  assert.deepEqual(shortage, {status:'not-recommended',issue:'resource-capacity',evidence:'verified',shortfalls:[{key:'commitBytes',minimumBytes:31000,capacityBytes:30000}]});
  Object.assign(assessment, {issue:'abnormal-termination',evidence:'observed',date:'2026-11-15',summary:'OS bugcheck'});
  await writeFile(observationsFile, JSON.stringify({ version:1, assessments:{'sd-depth':assessment} }));
  entry.profile = 'fixture';
  await writeFile(path.join(indexDirectory, 'workflow-catalog.json'), JSON.stringify({version:1, workflows:[entry]}));
  const advisories = () => readRow({profile:'fixture',mode:'depth',advisoriesOnly:true,observeResources:observed,
    installed: () => assert.fail('Render advisory lookup does not call ComfyUI')});
  assert.equal((await advisories()).recommendation.summary, 'OS bugcheck');
  const detailedRisk = await readRow({id:'sd-depth',observeResources:observed});
  assert.match(detailedRisk.details.steps.join(' '), /without queueing/);
  assert.doesNotMatch(detailedRisk.details.steps.join(' '), /queue the workflow/);
  await writeFile(canvasPath, graph + '\n');
  assert.deepEqual(await usage(), { modelDiskBytes: 1024, runtime: null });
  assert.equal((await advisories()).recommendation.shortfalls, undefined, 'Template edits invalidate numeric minima');
  assert.equal((await advisories()).recommendation.issue, 'abnormal-termination', 'Template edits preserve its reported incident');
  await writeFile(canvasPath, graph);
  await writeFile(observationsFile, measured);
  assert.equal((await usage()).runtime?.width, 512);
  const duplicate = path.join(modelDirectory, category, 'ambiguous', name);
  await mkdir(path.dirname(duplicate));
  await writeFile(duplicate, Buffer.alloc(1024));
  assert.deepEqual(await usage(), { modelDiskBytes: null, runtime: null });
});
