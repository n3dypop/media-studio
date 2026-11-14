import { lstat, readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ApiError } from './store.mjs';
import { workflowResourceReader } from './workflow-resources.mjs';
import { comboChoices } from './media-modes.mjs';

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
  return /^[a-z0-9-]{1,64}$/.test(entry?.id ?? '') && bounded(entry.family, 80) && bounded(entry.label, 100)
    && /^[a-z0-9-]{1,24}$/.test(entry.mode ?? '') && workflowFile.test(entry.file)
    && ['image', 'video'].includes(entry.media) && Array.isArray(entry.models) && entry.models.length <= 20
    && entry.models.every(model => model && Object.hasOwn(loaders, model.category)
      && bounded(model.name, 240) && modelName.test(model.name) && !model.name.split('/').some(part => part === '.' || part === '..'))
    && (entry.profile === undefined || /^[a-z0-9.-]{1,64}$/.test(entry.profile));
}

async function inspectWorkflow(root, entry, objects, resources) {
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
  const types = [...new Set([...graph.nodes, ...subgraphs.flatMap(graph => graph.nodes)].map(node => node?.type))]
    .filter(type => !groups.has(type) && type !== 'Note' && type !== 'MarkdownNote' && type !== 'Reroute');
  if (!types.length || types.some(type => !nodeName.test(type ?? ''))) return { state: 'template-invalid' };
  const missingNodes = types.filter(type => !registeredNode(objects, type));
  const missingModels = entry.models.filter(model => !modelAvailable(objects, model)).map(model => model.name);
  const resourceUsage = await resources(entry, createHash('sha256').update(bytes).digest('hex'));
  return { state: missingModels.length || missingNodes.length ? 'dependencies-missing' : 'static-ready',
    resourceUsage,
    ...(missingNodes.length && { missingNodes }), ...(missingModels.length && { missingModels }) };
}

export async function comfyWorkflowLibrary({ userDirectory, modelDirectory, installed, catalog, query, mode, media, page = 1, limit = 12 }) {
  if ((query !== undefined && !bounded(query, 80)) || (mode !== undefined && !/^[a-z0-9-]{1,24}$/.test(mode))
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
  const terms = query?.toLowerCase().trim().split(/\s+/).filter(Boolean) ?? [];
  const entries = index.workflows.filter(entry => {
    const text = `${entry.id} ${entry.family} ${entry.label} ${entry.mode}`.toLowerCase();
    return (!mode || mode === entry.mode) && (!media || media === entry.media) && terms.every(term => text.includes(term));
  }).sort((a, b) => a.family.localeCompare(b.family) || a.id.localeCompare(b.id));
  const selected = entries.slice((page - 1) * limit, page * limit);
  if (!selected.length) return { ...empty, state: 'configured', total: entries.length };
  const objects = await installed();
  const managed = selected.some(entry => entry.profile) ? await catalog(objects) : [];
  const observations = await readLocalJson(root, 'media-studio/workflow-resource-observations.json', 128 * 1024).catch(() => null);
  const resources = workflowResourceReader(modelDirectory, observations);
  const workflows = await Promise.all(selected.map(async entry => {
    const { id, family, label, mode, media, file, profile } = entry;
    const dshProfile = managed.find(item => item.modelProfile === profile && item.mode === mode)?.modelProfile;
    return { id, family, label, mode, media, file, ...(dshProfile && { dshProfile }), ...await inspectWorkflow(root, entry, objects, resources) };
  }));
  return { ...empty, state: 'configured', total: entries.length, workflows,
    validationScope: 'Static availability in standalone ComfyUI. A dshProfile identifies a managed equivalent. No GPU execution or visual quality was tested.' };
}
