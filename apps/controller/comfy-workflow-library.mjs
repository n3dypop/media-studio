import { lstat, readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ApiError } from './store.mjs';
import { workflowResourceReader } from './workflow-resources.mjs';
import { comboChoices, WORKFLOW_QUERY_LIMIT, workflowLibraryId } from './media-modes.mjs';

const loaders = { diffusion_models: ['UNETLoader', 'unet_name'], text_encoders: ['CLIPLoader', 'clip_name'],
  vae: ['VAELoader', 'vae_name'], loras: ['LoraLoaderModelOnly', 'lora_name'], geometry_estimation: ['LoadMoGeModel', 'model_name'],
  upscale_models: ['UpscaleModelLoader', 'model_name'], checkpoints: ['CheckpointLoaderSimple','ckpt_name'],
  controlnet: ['ControlNetLoader','control_net_name'] };
const nodeName = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;
const modelName = /^(?:[\w.-]+\/)*[\w.-]+\.(?:safetensors|pth|gguf)$/i;
const workflowFile = /^Media Studio\/[A-Za-z0-9][\w .-]*\/[\w-]+\.json$/;
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
    && bounded(entry.mode, 24) && /^[a-z0-9-]+$/.test(entry.mode) && typeof entry.file === 'string' && workflowFile.test(entry.file)
    && ['image', 'video'].includes(entry.media) && Array.isArray(entry.models) && entry.models.length <= 20
    && entry.models.every(model => model && Object.hasOwn(loaders, model.category)
      && bounded(model.name, 240) && modelName.test(model.name) && !model.name.split('/').some(part => part === '.' || part === '..'))
    && (entry.profile === undefined || (bounded(entry.profile, 64) && /^[a-z0-9.-]+$/.test(entry.profile)));
}

function workflowDetails(graph, nodes, types, models) {
  const inputs = [...new Set(nodes.filter(node => ['LoadImage', 'LoadImageMask', 'LoadVideo', 'LoadAudio'].includes(node.type)).map(node => node.type))];
  const outputs = types.filter(type => /^(?:SaveImage|SaveVideo|SaveAudio|VHS_VideoCombine)$/.test(type));
  const details = { inputs, outputs, nodeTypes: types, models };
  const main = graph.nodes.filter(node => !node.mode);
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
    if (Number.isFinite(resize?.widgets_values?.[1])) details.inputMegapixels = resize.widgets_values[1];
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
    ...(detailed && { details: workflowDetails(graph, nodes, types.slice(0, 80), entry.models) }),
    ...(missingNodes.length && { missingNodes }), ...(missingModels.length && { missingModels }) };
}

export async function comfyWorkflowLibrary({ userDirectory, modelDirectory, installed, catalog, id, query, mode, media, page = 1, limit = 12 }) {
  if ((id !== undefined && (typeof id !== 'string' || !workflowLibraryId.test(id) || query !== undefined || page !== 1)) ||
    (query !== undefined && !bounded(query, WORKFLOW_QUERY_LIMIT)) || (mode !== undefined && !/^[a-z0-9-]{1,24}$/.test(mode))
    || (media !== undefined && !['image', 'video'].includes(media)) || !Number.isSafeInteger(page) || page < 1
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
    return (!id || entry.id === id) && (!mode || mode === entry.mode) && (!media || media === entry.media) && terms.every(term => text.includes(term));
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
      ...await inspectWorkflow(root, entry, objects, resources, id !== undefined) };
  }));
  return { ...empty, state: 'configured', operations, total: entries.length, workflows,
    validationScope: 'Static availability in standalone ComfyUI. A dshProfile identifies a managed equivalent. No GPU execution or visual quality was tested.' };
}
