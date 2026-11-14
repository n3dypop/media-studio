import { lstat, readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ApiError } from './store.mjs';
import { workflowResourceReader } from './workflow-resources.mjs';
import { comboChoices, WORKFLOW_QUERY_LIMIT, workflowLibraryFile, workflowLibraryId } from './media-modes.mjs';

const loaders = { diffusion_models: ['UNETLoader', 'unet_name'], text_encoders: ['CLIPLoader', 'clip_name'],
  vae: ['VAELoader', 'vae_name'], loras: ['LoraLoaderModelOnly', 'lora_name'], geometry_estimation: ['LoadMoGeModel', 'model_name'],
  upscale_models: ['UpscaleModelLoader', 'model_name'], checkpoints: ['CheckpointLoaderSimple','ckpt_name'],
  controlnet: ['ControlNetLoader','control_net_name'] };
const nodeName = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;
const modelName = /^(?:[\w.-]+\/)*[\w.-]+\.(?:safetensors|pth|gguf)$/i;
const bounded = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
const normalize = value => String(value).replaceAll('\\', '/');
const registeredNode = (objects, name) => Object.hasOwn(objects, name) && objects[name]?.api_node !== true && objects[name]?.dev_only !== true;

async function readLocalFile(root, relative, maxBytes) {
  const file = path.join(root, relative);
  const info = await lstat(file);
  const resolved = await realpath(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes || resolved !== file) {
    throw new Error('Invalid workflow library file');
  }
  return readFile(file);
}

const readLocalJson = async (...args) => JSON.parse(await readLocalFile(...args));

function modelAvailable(objects, { category, name }) {
  const [node, input] = loaders[category];
  const choices = comboChoices(objects[node]?.input?.required?.[input]);
  return registeredNode(objects, node) && Array.isArray(choices) && choices.some(choice => normalize(choice) === name);
}

function validEntry(entry) {
  return typeof entry?.id === 'string' && workflowLibraryId.test(entry.id) && bounded(entry.family, 80) && bounded(entry.label, 100)
    && bounded(entry.mode, 24) && /^[a-z0-9-]+$/.test(entry.mode) && typeof entry.file === 'string' && workflowLibraryFile.test(entry.file)
    && ['image', 'video'].includes(entry.media) && Array.isArray(entry.models) && entry.models.length <= 20
    && entry.models.every(model => model && Object.hasOwn(loaders, model.category)
      && bounded(model.name, 240) && modelName.test(model.name) && !model.name.split('/').some(part => part === '.' || part === '..'))
    && (entry.profile === undefined || (bounded(entry.profile, 64) && /^[a-z0-9.-]+$/.test(entry.profile)));
}

const sourceNodes = new Set(['LoadImage', 'LoadImageMask', 'LoadVideo', 'LoadAudio']);
const promptNodes = /^(?:CLIPTextEncode.*|TextEncode.*|PrimitiveStringMultiline|MOSSImageLayoutPrompt)$/;
const diskOutputs = /^(?:SaveImage(?:Advanced)?|SaveVideo|SaveAudio(?:MP3|Opus)?|VHS_VideoCombine)$/;
const labelOf = node => {
  const label = node.title?.trim?.();
  return typeof label === 'string' && /^[\p{L}\p{N} _().<>&·:+/-]{1,80}$/u.test(label) ? label : undefined;
};

function workflowDetails(graph, nodes, types, models, objects) {
  const active = nodes.filter(node => node && !node.mode);
  const inputs = [...new Set(active.filter(node => sourceNodes.has(node.type)).map(node => node.type))];
  const outputs = types.filter(type => diskOutputs.test(type) && active.some(node => node.type === type));
  const describe = list => list.slice(0, 12).map(node => {
    const label = labelOf(node);
    return { type: node.type, ...(label && { label }) };
  });
  const nodeGroups = { bundled: types.filter(type => /^(?:nodes$|comfy_extras\.)/.test(objects[type]?.python_module ?? '')) };
  const details = { inputs, outputs, nodeTypes: types, models, nodeGroups,
    sources: describe(active.filter(node => sourceNodes.has(node.type))),
    promptControls: describe(active.filter(node => promptNodes.test(node.type) && (!node.type.startsWith('Primitive') || /^(?:Request|.*(?:user|positive|negative|edit)[ _]?prompt.*)$/i.test(labelOf(node) ?? '')))),
    steps: [
      'Open the saved workflow in ComfyUI and replace sample media in the listed input nodes.',
      'Set the exposed prompt and operation controls appropriate to the workflow. Check the listed dependency status in ComfyUI.',
      'When ready to generate, queue the workflow in ComfyUI and inspect the listed output. No job was submitted by this inspection.',
    ],
  };
  const linkedControls = graph.nodes.filter(node => !node.mode && (graph.definitions?.subgraphs ?? []).some(group => group.id === node.type))
    .flatMap(node => Array.isArray(node.inputs) ? node.inputs : [])
    .filter(input => typeof input?.name === 'string' && /^[a-zA-Z][\w.]{0,63}$/.test(input.name) && /^(STRING|IMAGE|VIDEO|AUDIO|MASK|INT|FLOAT|BOOLEAN|COMBO)$/.test(input.type));
  if (linkedControls.length) details.subgraphControls = linkedControls.slice(0, 24)
    .map(({ name, type, link }) => ({ name, type, linked: Number.isInteger(link) }));
  const main = graph.nodes.filter(node => node && !node.mode);
  const conditioning = main.find(node => node.type === 'MiniMaxH3ImageConditioning');
  const prompt = main.find(node => node.type === 'PrimitiveStringMultiline' && node.title === 'Text (user_prompt)');
  const enhancer = main.find(node => node.type === 'PrimitiveBoolean' && node.title === 'Boolean (Enable PE?)');
  if (conditioning && prompt && main.some(node => node.type === 'LoadImage') && outputs.includes('SaveImage')) {
    details.steps = [
      'Open the saved workflow in ComfyUI and choose the source image in Load Image (<Picture 1>).',
      'Replace the example in Text (user_prompt) with the editing instruction. Describe what to change and what to preserve.',
      'Check the listed model selectors and input size. Queue in ComfyUI and inspect the image emitted by Save Image.',
    ];
    if (typeof enhancer?.widgets_values?.[0] === 'boolean') details.promptEnhancerEnabled = enhancer.widgets_values[0];
    const resize = main.find(node => node.type === 'ResizeImageMaskNode' && node.widgets_values?.[0] === 'scale total pixels');
    const multiple = main.find(node => node.type === 'ResizeImageMaskNode' && node.widgets_values?.[0] === 'scale to multiple');
    if (Number.isFinite(resize?.widgets_values?.[1])) details.resizeTargetMegapixels = resize.widgets_values[1];
    if (Number.isFinite(multiple?.widgets_values?.[1])) details.resizeMultiple = multiple.widgets_values[1];
    const widgets = main.find(node => node.type === 'KSampler')?.widgets_values;
    const [, , steps, cfg, sampler, scheduler, denoise] = Array.isArray(widgets) ? widgets : [];
    if ([steps, cfg, denoise].every(Number.isFinite) && [sampler, scheduler].every(value => typeof value === 'string' && nodeName.test(value))) {
      details.sampler = { steps, cfg, sampler, scheduler, denoise };
    }
  }
  return details;
}

async function inspectWorkflow(root, entry, objects, resources, detailed) {
  let graph, bytes;
  try {
    bytes = await readLocalFile(root, `default/workflows/${entry.file}`, 1024 * 1024);
    graph = JSON.parse(bytes);
  }
  catch (error) {
    if (error.code === 'ENOENT') return { state: 'template-missing' };
    return { state: 'template-invalid' };
  }
  const subgraphs = graph?.definitions?.subgraphs ?? [];
  if (!Array.isArray(graph?.nodes) || !Array.isArray(subgraphs) || subgraphs.some(graph => !Array.isArray(graph?.nodes))) {
    return { state: 'template-invalid' };
  }
  const groups = new Set(subgraphs.map(graph => graph.id));
  const nodes = [...graph.nodes, ...subgraphs.flatMap(graph => graph.nodes)];
  const types = [...new Set(nodes.map(node => node?.type))]
    .filter(type => !groups.has(type) && type !== 'Note' && type !== 'MarkdownNote' && type !== 'Reroute');
  if (!types.length || types.some(type => typeof type !== 'string' || !nodeName.test(type))) return { state: 'template-invalid' };
  const missingNodes = types.filter(type => !registeredNode(objects, type));
  const missingModels = entry.models.filter(model => !modelAvailable(objects, model)).map(model => model.name);
  const resourceUsage = await resources(entry, createHash('sha256').update(bytes).digest('hex'));
  return { state: missingModels.length || missingNodes.length ? 'dependencies-missing' : 'static-ready',
    resourceUsage,
    ...(detailed && { details: workflowDetails(graph, nodes, types.slice(0, 80), entry.models, objects) }),
    ...(missingNodes.length && { missingNodes }), ...(missingModels.length && { missingModels }) };
}

export async function comfyWorkflowLibrary({ userDirectory, modelDirectory, installed, catalog, id, query, mode, media, details, page = 1, limit = 12 }) {
  const locator = typeof id === 'string' ? normalize(id) : '';
  if ((id !== undefined && ((!workflowLibraryId.test(locator) && (!bounded(locator, 256) || !workflowLibraryFile.test(locator))) || query !== undefined || page !== 1)) ||
    (query !== undefined && !bounded(query, WORKFLOW_QUERY_LIMIT)) || (mode !== undefined && !/^[a-z0-9-]{1,24}$/.test(mode))
    || (media !== undefined && !['image', 'video'].includes(media)) || (details !== undefined && details !== 'unique') || !Number.isSafeInteger(page) || page < 1
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 25) throw new ApiError(400, 'Invalid workflow library filter');
  const empty = { workflows: [], total: 0, page, limit };
  if (!userDirectory) return { ...empty, state: 'unconfigured' };
  let root;
  try { root = await realpath(userDirectory); }
  catch (error) {
    if (error.code === 'ENOENT') return { ...empty, state: 'unconfigured' };
    throw new ApiError(503, 'ComfyUI workflow library is unreadable');
  }
  let index;
  try { index = await readLocalJson(root, 'media-studio/workflow-catalog.json', 512 * 1024); }
  catch (error) {
    if (error.code === 'ENOENT') return { ...empty, state: 'unconfigured' };
    throw new ApiError(503, 'ComfyUI workflow library is unreadable');
  }
  if (index?.version !== 1 || !Array.isArray(index.workflows) || index.workflows.length > 1000 ||
    !index.workflows.every(validEntry) || new Set(index.workflows.map(entry => entry.id)).size !== index.workflows.length) {
    throw new ApiError(503, 'ComfyUI workflow library is invalid');
  }
  const searchable = value => value.normalize('NFKC').toLowerCase().replace(/[\/\\_.-]+/g, ' ');
  const terms = query ? searchable(query).trim().split(/\s+/).filter(Boolean) : [];
  const operations = [...new Set(index.workflows.map(entry => entry.mode))].sort();
  const entries = index.workflows.filter(entry => {
    const text = searchable([entry.id, entry.family, entry.label, entry.file, entry.mode, entry.profile, ...entry.models.map(model => model.name)].join(' '));
    return (!locator || entry.id === locator || entry.file === locator) && (!mode || mode === entry.mode) && (!media || media === entry.media) && terms.every(term => text.includes(term));
  }).sort((a, b) => a.family.localeCompare(b.family) || a.id.localeCompare(b.id));
  const selected = entries.slice((page - 1) * limit, page * limit);
  if (!selected.length) return { ...empty, state: 'configured', operations, total: entries.length };
  const objects = await installed();
  const managed = selected.some(entry => entry.profile) ? await catalog(objects) : [];
  const observations = await readLocalJson(root, 'media-studio/workflow-resource-observations.json', 128 * 1024).catch(() => null);
  const resources = workflowResourceReader(modelDirectory, observations);
  const workflows = await Promise.all(selected.map(async entry => {
    const { id, family, label, mode, media, file, profile } = entry;
    const dshProfile = managed.find(item => item.modelProfile === profile && item.mode === mode)?.modelProfile;
    return { id, family, label, mode, media, file, ...(dshProfile ? { dshProfile } : profile ? { unavailableDshProfile: profile } : {}),
      ...await inspectWorkflow(root, entry, objects, resources, Boolean(locator) || (details === 'unique' && entries.length === 1)) };
  }));
  return { ...empty, state: 'configured', operations, total: entries.length, workflows,
    validationScope: 'Static availability in standalone ComfyUI. A dshProfile identifies a managed equivalent. No GPU execution or visual quality was tested.' };
}
