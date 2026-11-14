import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import {UPSCALE_PROFILE,RESIZE_PROFILE,VIDEO_PROFILE_ID,H3_PROFILE_ID,RETIRED_VIDEO_PROFILES,MOSS_OFFICIAL_IDS,QWEN21_OFFICIAL_IDS,QWEN21_MAX_INPUTS,MODEL_PROFILES,LEGACY_QWEN_PROFILE as PROFILE,MOSS_PROFILE,assertActiveProfile,mediaIntent,assertModeProfile,assertInputBinding,comboChoices,mossInputTemplate} from './media-modes.mjs';
import {buildMossOfficialGraph,validateMossOfficialGraph,inspectMossOfficialSchemas,resolveMossOwnedInputs} from './moss-official.mjs';
import {QWEN21_PROFILES,buildQwen21Graph,validateQwen21Graph,resolveQwen21OwnedInputs} from './qwen21-workflow.mjs';
import {catalogProfile,catalogLimits,catalogModels,buildCatalogGraph,validateCatalogGraph,validateCatalogSchemas} from './catalog-profiles.mjs';
import {UPSCALE_NODE_TYPES,upscaleModels,upscaleTemplate,validateUpscaleGraph} from './upscale-workflow.mjs';
import {profileLedger,nodeLedger,coreModelLedger} from './model-ledger.mjs';
import {comfyWorkflowLibrary} from './comfy-workflow-library.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export { MODEL_PROFILES, MOSS_PROFILE } from './media-modes.mjs';
const MOSS_COUNTS = Object.freeze({ CLIPTextEncode: [1, 2], KSampler: [1, 1], EmptyFlux2LatentImage: [0, 1],
  SaveImage: [1, 1], VAELoader: [1, 1], UNETLoader: [1, 1], CLIPLoader: [1, 1], VAEDecode: [1, 1],
  ConditioningZeroOut: [0, 1], SkipLayerGuidanceDiTSimple: [0, 1], ImageScale: [0, 3],LoadImage:[0,1],VAEEncode:[0,1] });
const MOSS_TYPES = Object.freeze(Object.keys(MOSS_COUNTS));
const MOSS_NODE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_GRAPH_BYTES = 128 * 1024;
const MAX_DRAFT_BYTES = 160 * 1024;
const PREFIX = 'controller/template/image';
export const WORKFLOW_ROLES = Object.freeze({ text: '1', sampler: '3', latent: '14', save: '15' });
export const WORKFLOW_NODE_TYPES = Object.freeze([
  'TextEncodeQwenImage21', 'KSampler', 'EmptyLatentImage', 'SaveImageAdvanced',
  'VAELoader', 'UnetLoaderGGUF', 'CLIPLoaderGGUF', 'VAEDecode',
  'QwenImage21Cache', 'SpectrumQwenImage21', 'PathchSageAttentionKJ',
]);
const ROLE_TYPES = { text: 'TextEncodeQwenImage21', sampler: 'KSampler', latent: 'EmptyLatentImage', save: 'SaveImageAdvanced' };
const MODEL_INPUTS = [['6', 'VAELoader', 'vae_name', 'vae'], ['7', 'UnetLoaderGGUF', 'unet_name', 'diffusion'], ['108', 'CLIPLoaderGGUF', 'clip_name', 'text_encoder']];
const normalizeName = value => String(value).replaceAll('\\', '/');
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (object, key) => Object.hasOwn(object, key);

function jsonValue(value, depth = 0) {
  if (depth > 12) throw new Error('Workflow nesting limit exceeded');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const item of value) jsonValue(item, depth + 1); return; }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Forbidden workflow property');
      jsonValue(item, depth + 1);
    }
    return;
  }
  throw new Error('Workflow must contain only finite JSON data');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

export function workflowGraphHash(graph) {
  jsonValue(graph);
  return hashJson(graph);
}

const hashJson = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

export function qualifiedWorkflowModels(profile, modelProfile = Object.values(profile ?? {}).some(node=>node?.class_type==='CLIPLoader')?MOSS_PROFILE:PROFILE) {
  if(!MODEL_PROFILES[modelProfile])throw new Error('Unknown image model profile');
  if(catalogProfile(modelProfile))return catalogModels(profile);
  if([UPSCALE_PROFILE,RESIZE_PROFILE].includes(modelProfile))return upscaleModels(profile,modelProfile);
  assertActiveProfile(modelProfile);
  const native=modelProfile===MOSS_PROFILE||MOSS_OFFICIAL_IDS.includes(modelProfile)||QWEN21_OFFICIAL_IDS.includes(modelProfile);
  const inputs=native?[['6','VAELoader','vae_name','vae'],['7','UNETLoader','unet_name','diffusion'],['108','CLIPLoader','clip_name','text_encoder']]:MODEL_INPUTS;
  return inputs.map(([canonicalId, nodeType, input, role]) => {
    const matching = native ? Object.keys(profile ?? {}).filter(id=>profile[id]?.class_type===nodeType) : [canonicalId];
    if (matching.length !== 1) throw new Error('Qualified model profile requires one loader per model');
    const id = matching[0];
    const name = profile?.[id]?.inputs?.[input];
    if (profile?.[id]?.class_type !== nodeType || typeof name !== 'string' || !name) throw new Error('Qualified model profile is unavailable');
    return { role, nodeType, input, name, qualification: MODEL_PROFILES[modelProfile].qualification };
  });
}

function inputDefinitions(schema, node) {
  if (!isRecord(schema?.input?.required ?? {})) throw new Error('Malformed installed node schema');
  const required = { ...(schema.input?.required ?? {}) };
  const optional = { ...(schema.input?.optional ?? {}) };
  // The known text-only Qwen path has a zero-length autogrow input, omitted in API graphs.
  if (node.class_type === 'TextEncodeQwenImage21' && required.images?.[0] === 'COMFY_AUTOGROW_V3') {
    if (required.images[1]?.template?.min !== 0) throw new Error('Qwen reference-image schema changed');
    delete required.images;
  }
  // Flatten only the qualified PNG branch of the installed V3 DynamicCombo schema.
  if (node.class_type === 'SaveImageAdvanced' && required.format?.[0] === 'COMFY_DYNAMICCOMBO_V3') {
    const png = required.format[1]?.options?.find(option => option.key === 'png');
    if (!png?.inputs?.required) throw new Error('Installed save node has no PNG branch');
    required.format = [['png']];
    for (const [key, definition] of Object.entries(png.inputs.required)) required[`format.${key}`] = definition;
  }
  if(node.class_type==='SaveVideo'&&required.format?.[0]==='COMFY_DYNAMICCOMBO_V3'){
    const mp4=required.format[1]?.options?.find(option=>option.key==='mp4');
    const codec=mp4?.inputs?.required?.codec;
    const h264=codec?.[1]?.options?.find(option=>option.key==='h264');
    if(codec?.[0]!=='COMFY_DYNAMICCOMBO_V3'||!h264?.inputs?.optional?.encoding)throw new Error('Installed SaveVideo MP4/H.264 schema changed');
    required.format=[['mp4']];required['format.codec']=[['h264']];required['format.codec.encoding']=[['auto']];
    delete optional.codec;
  }
  return { required, optional };
}

function validateLiteral(value, definition, location) {
  if (!Array.isArray(definition) || definition.length < 1) throw new Error(`Missing installed type at ${location}`);
  const [type, options = {}] = definition;
  const choices = Array.isArray(type) ? type : type === 'COMBO' ? options.options : null;
  if (choices) {
    if (!Array.isArray(choices) || !choices.some(choice => choice === value)) throw new Error(`Invalid choice at ${location}`);
    return;
  }
  if (type === 'STRING') {
    if (typeof value !== 'string' || value.length > 32_768) throw new Error(`Invalid string at ${location}`);
    return;
  }
  if (type === 'BOOLEAN') {
    if (typeof value !== 'boolean') throw new Error(`Invalid boolean at ${location}`);
    return;
  }
  if (type === 'INT' || type === 'FLOAT') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (type === 'INT' && !Number.isSafeInteger(value))
        || (typeof options.min === 'number' && value < options.min)
        || (typeof options.max === 'number' && value > options.max)) throw new Error(`Invalid numeric range at ${location}`);
    return;
  }
  throw new Error(`A typed link is required at ${location}`);
}

function assertLink(value, id, slot, label) {
  if (!Array.isArray(value) || value[0] !== id || value[1] !== slot || value.length !== 2) throw new Error(`Unsupported role connection: ${label}`);
}

/** Static validation only. It does not certify image quality, timing, or a new resource profile. */
export function validateWorkflowGraph(input, { objects, models, normalize = true, modelProfile = PROFILE, enforceRuntimeQualification = true,assetBinding=null } = {}) {
  if([UPSCALE_PROFILE,RESIZE_PROFILE].includes(modelProfile)){jsonValue(input);return validateUpscaleGraph(input,{objects,models,normalize,modelProfile,assetBinding,hash:workflowGraphHash});}
  assertActiveProfile(modelProfile);
  if(modelProfile===MOSS_PROFILE)return validateMossGraph(input,{objects,models,normalize,enforceRuntimeQualification,assetBinding});
  if(modelProfile!==PROFILE)throw new Error('Model profile is not permitted');
  jsonValue(input);
  if (!isRecord(input) || JSON.stringify(input).length > MAX_GRAPH_BYTES) throw new Error('Workflow must be a bounded API graph');
  const graph = structuredClone(input);
  const ids = Object.keys(graph);
  if (ids.length < 8 || ids.length > WORKFLOW_NODE_TYPES.length) throw new Error('Workflow node count is outside the qualified single-image path');
  const byType = new Map();
  for (const id of ids) {
    const node = graph[id];
    if (!/^[1-9][0-9]{0,5}$/.test(id) || !isRecord(node) || !isRecord(node.inputs)
        || Object.keys(node).some(key => !['class_type', 'inputs', '_meta'].includes(key))) throw new Error(`Invalid API node ${id}`);
    if (!WORKFLOW_NODE_TYPES.includes(node.class_type)) throw new Error(`Node type is not permitted: ${node.class_type}`);
    if (byType.has(node.class_type)) throw new Error(`Duplicate node type is outside the qualified path: ${node.class_type}`);
    byType.set(node.class_type, id);
    if (!objects?.[node.class_type] || objects[node.class_type].api_node === true
        || objects[node.class_type].dev_only === true) throw new Error(`Node is unavailable or has an unapproved API capability: ${node.class_type}`);
    if (objects[node.class_type].output_node === true && node.class_type !== 'SaveImageAdvanced') throw new Error('Additional output side effects are not permitted');
    delete node._meta;
  }
  for (const [role, id] of Object.entries(WORKFLOW_ROLES)) {
    if (graph[id]?.class_type !== ROLE_TYPES[role]) throw new Error(`Canonical ${role} role must use node ${id}`);
  }
  for (const type of ['VAELoader', 'UnetLoaderGGUF', 'CLIPLoaderGGUF', 'VAEDecode']) {
    if (!byType.has(type)) throw new Error(`Required qualified node is missing: ${type}`);
  }
  if (normalize) graph['15'].inputs.filename_prefix = PREFIX;
  const dependencies = new Map(ids.map(id => [id, []]));
  for (const id of ids) {
    const node = graph[id];
    const { required, optional } = inputDefinitions(objects[node.class_type], node);
    for (const name of Object.keys(required)) {
      if (!own(node.inputs, name)) throw new Error(`Required input is missing: ${id}.${name}`);
    }
    for (const [name, value] of Object.entries(node.inputs)) {
      const definition = required[name] ?? optional[name];
      if (!definition) throw new Error(`Input is not permitted: ${id}.${name}`);
      if (Array.isArray(value)) {
        if (value.length !== 2 || typeof value[0] !== 'string' || !Number.isSafeInteger(value[1]) || value[1] < 0
            || !graph[value[0]]) throw new Error(`Invalid link at ${id}.${name}`);
        const type = definition[0];
        if (typeof type !== 'string' || ['STRING', 'INT', 'FLOAT', 'BOOLEAN', 'COMBO'].includes(type)) {
          throw new Error(`Literal widget inputs cannot be linked: ${id}.${name}`);
        }
        const outputs = objects[graph[value[0]].class_type].output;
        if (!Array.isArray(outputs) || outputs[value[1]] !== type) throw new Error(`Link type or output index mismatch at ${id}.${name}`);
        dependencies.get(id).push(value[0]);
      } else validateLiteral(value, definition, `${id}.${name}`);
    }
  }
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error('Workflow contains a cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const source of dependencies.get(id)) visit(source);
    visiting.delete(id); visited.add(id);
  }
  // Check all nodes for cycles, then separately ensure every node belongs to the one output.
  for (const id of ids) visit(id);
  visited.clear(); visit('15');
  if (visited.size !== ids.length) throw new Error('Workflow contains nodes unreachable from the save output; remove bypassed nodes');
  const vaeId = byType.get('VAELoader'), clipId = byType.get('CLIPLoaderGGUF'), decodeId = byType.get('VAEDecode');
  assertLink(graph['1'].inputs.clip, clipId, 0, 'text encoder');
  if (graph['1'].inputs.vae !== undefined) assertLink(graph['1'].inputs.vae, vaeId, 0, 'text VAE');
  assertLink(graph['3'].inputs.positive, '1', 0, 'positive conditioning');
  assertLink(graph['3'].inputs.negative, '1', 1, 'negative conditioning');
  assertLink(graph['3'].inputs.latent_image, '14', 0, 'latent size');
  assertLink(graph[decodeId].inputs.samples, '3', 0, 'decode sampler output');
  assertLink(graph[decodeId].inputs.vae, vaeId, 0, 'decode VAE');
  assertLink(graph['15'].inputs.images, decodeId, 0, 'save decoded image');
  const latent = graph['14'].inputs, sampler = graph['3'].inputs, save = graph['15'].inputs;
  if (![latent.width, latent.height].every(n => Number.isSafeInteger(n) && n >= 512 && n <= 1536 && n % 32 === 0)
      || latent.width * latent.height > 1_500_000 || latent.batch_size !== 1) throw new Error('Unqualified dimensions or batch size');
  if (sampler.steps < 1 || sampler.steps > 40 || sampler.cfg > 10 || sampler.denoise < 0 || sampler.denoise > 1) throw new Error('Sampler exceeds bounded generation profile');
  if (save.format !== 'png' || save['format.bit_depth'] !== '8-bit' || save['format.input_color_space'] !== 'sRGB') throw new Error('Only PNG 8-bit sRGB output is permitted');
  if (graph[clipId].inputs.type !== 'qwen_image') throw new Error('The qualified CLIP loader must use qwen_image');
  for (const model of models ?? []) {
    const id = byType.get(model.nodeType);
    if (!id || normalizeName(graph[id].inputs[model.input]) !== normalizeName(model.name)) throw new Error(`Model is outside the qualified profile: ${model.role}`);
  }
  if (!Array.isArray(models) || models.length !== 3) throw new Error('Qualified model inventory is required');
  const attention = byType.get('PathchSageAttentionKJ');
  if (attention && (graph[attention].inputs.sage_attention !== 'disabled' || graph[attention].inputs.allow_compile !== false)) throw new Error('Optional acceleration and compilation are not qualified');
  const spectrum = byType.get('SpectrumQwenImage21');
  if (spectrum) {
    const inputs = graph[spectrum].inputs;
    if (inputs.history_points > 8 || inputs.chebyshev_degree > 4 || inputs.max_consecutive_forecasts > 8
        || inputs.warmup_steps > 40 || inputs.tail_actual_steps > 40 || inputs.window_size > 8 || inputs.debug !== false) {
      throw new Error('Spectrum parameters exceed the bounded profile');
    }
  }
  return { graph, roles: { ...WORKFLOW_ROLES }, modelProfile: PROFILE,
    sha256: workflowGraphHash(graph), nodeCount: ids.length, output: { width: latent.width, height: latent.height, batch: 1, mime: 'image/png' } };
}

export function validateWorkflowSnapshot(snapshot, { objects, models, enforceRuntimeQualification = true } = {}) {
  if (!isRecord(snapshot) || !Object.hasOwn(MODEL_PROFILES,snapshot.modelProfile) || !UUID.test(snapshot.id ?? '')
      || !/^[0-9a-f]{64}$/.test(snapshot.sha256 ?? '') || workflowGraphHash(snapshot.graph) !== snapshot.sha256
      || (snapshot.schemaVersion !== undefined && ![1, 2,3].includes(snapshot.schemaVersion))) throw new Error('Workflow snapshot identity or hash mismatch');
  if(snapshot.schemaVersion===3){
    if(!['i2i','edit','upscale','video'].includes(snapshot.mode)||!snapshot.output)throw new Error('Media snapshot requires an explicit mode and output contract');
    mediaIntent({mode:snapshot.mode,inputAssetId:snapshot.inputAsset?.id??null});assertModeProfile(snapshot.mode,snapshot.modelProfile);
    if(snapshot.modelProfile===H3_PROFILE_ID)assertInputBinding(snapshot.inputAsset);
  }else if(snapshot.inputAsset||snapshot.mode)throw new Error('Legacy workflow snapshots cannot introduce media bindings');
  const checked = validateWorkflowGraph(snapshot.graph, { objects, models, modelProfile:snapshot.modelProfile, enforceRuntimeQualification,assetBinding:snapshot.inputAsset??null });
  if (checked.sha256 !== snapshot.sha256) throw new Error('Workflow snapshot is not in canonical stored form');
  const legacyMoss = snapshot.modelProfile === MOSS_PROFILE && snapshot.schemaVersion === 1;
  const expectedRoles = legacyMoss ? Object.fromEntries(Object.keys(WORKFLOW_ROLES).map(role=>[role, checked.roles[role]])) : checked.roles;
  if (hashJson(snapshot.roles) !== hashJson(expectedRoles)
      || (snapshot.schemaVersion === 2 && snapshot.modelProfile !== MOSS_PROFILE)
      || (snapshot.schemaVersion === 2 && !snapshot.output)
      || (snapshot.output && hashJson(snapshot.output) !== hashJson(checked.output))) throw new Error('Workflow snapshot roles or output mismatch');
  return checked;
}

function validateMossGraph(input,{objects,models,normalize=true,enforceRuntimeQualification=true,assetBinding=null}) {
  jsonValue(input);
  if(!isRecord(input)||JSON.stringify(input).length>MAX_GRAPH_BYTES)throw new Error('Workflow must be a bounded API graph');
  const graph=structuredClone(input);
  const ids=Object.keys(graph),byType=new Map(MOSS_TYPES.map(type=>[type,[]]));
  if(ids.length<9||ids.length>14)throw new Error('MOSS graph exceeds the bounded image path');
  for(const [id,node]of Object.entries(graph)){
    if(!MOSS_NODE_ID.test(id)||!isRecord(node)||!isRecord(node.inputs)||Object.keys(node).some(k=>!['class_type','inputs','_meta'].includes(k)))throw new Error('Malformed MOSS node or ID');
    if(!byType.has(node.class_type))throw new Error(`Node type is not permitted: ${node.class_type}`);
    byType.get(node.class_type).push(id);
    const schema=objects?.[node.class_type];
    if(!schema||schema.api_node===true||schema.dev_only===true||(schema.output_node===true&&node.class_type!=='SaveImage'))throw new Error('MOSS node unavailable or contains an unapproved side effect');
    delete node._meta;
  }
  for(const [type,[min,max]]of Object.entries(MOSS_COUNTS))if(byType.get(type).length<min||byType.get(type).length>max)throw new Error(`MOSS node count is outside the permitted range: ${type}`);
  const one=type=>byType.get(type)[0];
  const roles={text:null,negativeText:null,negativeZeroOut:one('ConditioningZeroOut')??null,sampler:one('KSampler'),
    latent:one('EmptyFlux2LatentImage')??one('VAEEncode'),save:one('SaveImage'),decode:one('VAEDecode'),vae:one('VAELoader'),
    diffusion:one('UNETLoader'),clip:one('CLIPLoader'),slg:one('SkipLayerGuidanceDiTSimple')??null,postprocess:[]};
  if(byType.get('EmptyFlux2LatentImage').length+byType.get('VAEEncode').length!==1)throw new Error('MOSS needs exactly one empty or image-encoded latent');
  if(one('VAEEncode')){
    assertInputBinding(assetBinding);roles.inputImage=one('LoadImage');
    if(!roles.inputImage||graph[roles.inputImage].inputs.image!==assetBinding.comfyInputName)throw new Error('MOSS input must use its owned immutable asset');
    const pixels=graph[roles.latent].inputs.pixels;
    if(!Array.isArray(pixels)||graph[pixels[0]]?.class_type!=='ImageScale')throw new Error('MOSS image input requires explicit resize dimensions');
    roles.inputScale=pixels[0];
    assertLink(pixels,roles.inputScale,0,'input encode pixels');
    assertLink(graph[roles.inputScale].inputs.image,roles.inputImage,0,'input image resize');
    assertLink(graph[roles.latent].inputs.vae,roles.vae,0,'input image VAE');
  }else if(assetBinding||one('LoadImage'))throw new Error('t2i cannot silently consume an input image');
  if(normalize)graph[roles.save].inputs.filename_prefix=PREFIX;
  const dependencies=new Map(ids.map(id=>[id,[]]));
  for(const [id,node]of Object.entries(graph)){
    const schema=objects[node.class_type];
    const {required,optional}=inputDefinitions(schema,node);
    for(const name of Object.keys(required))if(!own(node.inputs,name))throw new Error(`Required MOSS input missing: ${id}.${name}`);
    for(const [name,value]of Object.entries(node.inputs)){
      const definition=required[name]??optional[name];if(!definition)throw new Error(`Unexpected MOSS input: ${id}.${name}`);
      if(Array.isArray(value)){
        if(value.length!==2||typeof value[0]!=='string'||!Number.isSafeInteger(value[1])||value[1]<0||!graph[value[0]])throw new Error('Malformed MOSS link');
        const type=definition[0];
        if(typeof type!=='string'||['STRING','INT','FLOAT','BOOLEAN','COMBO'].includes(type)||objects[graph[value[0]].class_type]?.output?.[value[1]]!==type)throw new Error('MOSS link type mismatch');
        dependencies.get(id).push(value[0]);
      }else if(id===roles.inputImage&&name==='image'){
        // ComfyUI lists root input files in this dropdown, while LoadImage also
        // accepts managed subfolders. The exact immutable binding was verified
        // above; do not mistake an incomplete picker listing for a path check.
        if(value!==assetBinding?.comfyInputName)throw new Error('MOSS input differs from its owned immutable asset');
      }else validateLiteral(value,definition,`${id}.${name}`);
    }
  }
  const visiting=new Set(),visited=new Set();
  const visit=id=>{
    if(visiting.has(id))throw new Error('Workflow contains a cycle');
    if(visited.has(id))return;
    visiting.add(id);for(const source of dependencies.get(id))visit(source);visiting.delete(id);visited.add(id);
  };
  for(const id of ids)visit(id);
  visited.clear();visit(roles.save);
  if(visited.size!==ids.length)throw new Error('Workflow contains nodes unreachable from the save output; remove bypassed nodes');
  const latent=graph[roles.inputScale??roles.latent].inputs,sampler=graph[roles.sampler].inputs;
  roles.text=sampler.positive[0];
  if(graph[roles.text].class_type!=='CLIPTextEncode')throw new Error('Positive conditioning requires CLIPTextEncode');
  assertLink(sampler.positive,roles.text,0,'positive conditioning');
  for(const id of byType.get('CLIPTextEncode'))assertLink(graph[id].inputs.clip,roles.clip,0,'text encoder');
  if(roles.negativeZeroOut){
    if(byType.get('CLIPTextEncode').length!==1)throw new Error('Zero-out conditioning uses the single positive text encoder');
    assertLink(sampler.negative,roles.negativeZeroOut,0,'negative zero-out');
    assertLink(graph[roles.negativeZeroOut].inputs.conditioning,roles.text,0,'zero-out source');
  }else{
    roles.negativeText=sampler.negative[0];
    if(graph[roles.negativeText].class_type!=='CLIPTextEncode'||roles.negativeText===roles.text)throw new Error('Negative conditioning requires a separate CLIPTextEncode or ConditioningZeroOut');
    assertLink(sampler.negative,roles.negativeText,0,'negative conditioning');
  }
  assertLink(sampler.model,roles.slg??roles.diffusion,0,'sampler model');
  if(roles.slg)assertLink(graph[roles.slg].inputs.model,roles.diffusion,0,'SLG model');
  assertLink(sampler.latent_image,roles.latent,0,'latent size');
  assertLink(graph[roles.decode].inputs.samples,roles.sampler,0,'decode sampler');
  assertLink(graph[roles.decode].inputs.vae,roles.vae,0,'decode VAE');
  let image=graph[roles.save].inputs.images;
  while(graph[image[0]].class_type==='ImageScale'){
    assertLink(image,image[0],0,'scaled image');
    roles.postprocess.unshift(image[0]);image=graph[image[0]].inputs.image;
  }
  assertLink(image,roles.decode,0,'decoded image');
  const boundedDimensions=inputs=>[inputs.width,inputs.height].every(n=>Number.isSafeInteger(n)&&n>=512&&n<=1536&&n%32===0)&&inputs.width*inputs.height<=1_500_000;
  if(!boundedDimensions(latent)||(!roles.inputScale&&latent.batch_size!==1))throw new Error('Unqualified dimensions or batch size');
  if(roles.inputScale&&(graph[roles.inputScale].inputs.crop!=='disabled'||sampler.denoise<=0||sampler.denoise>=1))throw new Error('Image editing requires explicit input dimensions and denoise strictly between 0 and 1');
  if(roles.postprocess.length>2)throw new Error('At most two post-decode resize nodes are permitted');
  for(const id of roles.postprocess)if(!boundedDimensions(graph[id].inputs))throw new Error('ImageScale dimensions exceed the bounded image profile');
  if(!Number.isSafeInteger(sampler.seed)||sampler.seed<0||sampler.steps<1||sampler.steps>40||sampler.cfg>10||sampler.denoise<0||sampler.denoise>1)throw new Error('Sampler exceeds bounded generation profile');
  // Observed: ZeroOut + CFG 2.5 at 768x1024 stalled on the 12 GiB host.
  // The batching/memory explanation remains unproven. Block this combination
  // for new work while retaining structural access to historical evidence.
  if(enforceRuntimeQualification&&roles.negativeZeroOut&&sampler.cfg>1)throw new Error('ConditioningZeroOut with CFG > 1 is not qualified on this 12 GiB profile after a stalled run; use a separate CLIPTextEncode (empty negative text is allowed) or CFG 1. The cause is not established.');
  if(graph[roles.clip].inputs.type!=='moss_image'||graph[roles.clip].inputs.device!=='default'||graph[roles.diffusion].inputs.weight_dtype!=='default')throw new Error('MOSS loader settings differ from the approved model profile');
  if(!Array.isArray(models)||models.length!==3)throw new Error('Qualified model inventory is required');
  if(new Set(models.map(model=>model.role)).size!==3)throw new Error('Qualified model inventory must identify three distinct models');
  for(const model of models){const id={vae:roles.vae,diffusion:roles.diffusion,text_encoder:roles.clip}[model.role];if(!id||graph[id].class_type!==model.nodeType||normalizeName(graph[id].inputs[model.input])!==normalizeName(model.name))throw new Error('Model is outside the qualified profile');}
  if(roles.slg){const slg=graph[roles.slg].inputs;if(slg.double_layers!==''||slg.single_layers!=='22'||slg.start_percent<0||slg.end_percent>1||slg.start_percent>slg.end_percent)throw new Error('SLG settings exceed the MOSS profile');}
  const output=roles.postprocess.length?graph[roles.postprocess.at(-1)].inputs:latent;
  return {graph,roles,modelProfile:MOSS_PROFILE,sha256:workflowGraphHash(graph),nodeCount:ids.length,output:{width:output.width,height:output.height,batch:1,mime:'image/png'}};
}

async function safeDirectory(target, create) {
  const absolute = path.resolve(target), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const piece of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, piece);
    let stat;
    try { stat = await lstat(current); } catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      try { await mkdir(current); } catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
      stat = await lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Workflow storage path contains a link or non-directory');
  }
  const resolved = await realpath(absolute);
  if (path.relative(absolute, resolved) !== '') throw new Error('Workflow storage resolves outside its configured directory');
  return resolved;
}

function compactDefinition(definition) {
  const [type, options = {}] = definition;
  const result = { type: Array.isArray(type) ? 'COMBO' : type };
  if (Array.isArray(type)) result.choices = [...type];
  else if (type === 'COMBO') result.choices = [...(options.options ?? [])];
  for (const key of ['min', 'max', 'step', 'default']) if (options[key] !== undefined) result[key] = options[key];
  return result;
}

export class WorkflowRegistry {
  constructor({ root, directory, adapter,assets=null,comfyUserDirectory=null,comfyModelDirectory=null } = {}) {
    if (typeof root !== 'string' || !root || !adapter?.request || !adapter?.profile) throw new TypeError('WorkflowRegistry needs a workspace root and ComfyAdapter');
    this.root = path.resolve(root);
    if (directory !== undefined && !path.isAbsolute(directory)) throw new TypeError('Workflow storage must be absolute');
    this.directory = directory ?? path.join(this.root, 'workflows', 'drafts');
    this.adapter = adapter;
    this.comfyUserDirectory = comfyUserDirectory;
    this.comfyModelDirectory = comfyModelDirectory;
    this.assets=assets;
    this.profileId=adapter.modelProfile??PROFILE;
    this.profiles=adapter.profiles??{[this.profileId]:{graph:adapter.profile}};
    this.models = qualifiedWorkflowModels(adapter.profile,this.profileId);
  }

  profile(id=this.profileId){
    if(!Object.hasOwn(MODEL_PROFILES,id)||!Object.hasOwn(this.profiles,id))throw new Error('Model profile is not configured');
    const graph=this.profiles[id].graph;
    return {id,graph,models:qualifiedWorkflowModels(graph,id),types:id===MOSS_PROFILE||MOSS_OFFICIAL_IDS.includes(id)?MOSS_TYPES:id===UPSCALE_PROFILE?UPSCALE_NODE_TYPES:id===RESIZE_PROFILE?UPSCALE_NODE_TYPES.slice(0,3):WORKFLOW_NODE_TYPES};
  }

  async installed() {
    const objects = await this.adapter.request('/object_info');
    if (!isRecord(objects)) throw new Error('Installed node schemas are unavailable');
    // The adapter reuses this exact local discovery for synchronous buildPrompt validation.
    this.adapter.workflowObjects = objects;
    return objects;
  }

  async library(filters) {
    return comfyWorkflowLibrary({ ...filters, userDirectory: this.comfyUserDirectory, modelDirectory: this.comfyModelDirectory, installed: () => this.installed(),
      catalog: objects => this.discoverCapabilities(objects).capabilities });
  }

  discoverCapabilities(objects,{includeCatalogCandidates=false}={}) {
    const qualified = includeCatalogCandidates ? null : this.qualifiedCatalogProfiles?.() ?? new Set();
    const availableModels=profile=>profile.models.map(model => {
      const schema = objects[model.nodeType];
      const choices = comboChoices(schema?.input?.required?.[model.input]);
      return { ...model, available: schema?.api_node !== true && schema?.dev_only !== true
        && Array.isArray(choices) && choices.some(name => normalizeName(name) === normalizeName(model.name)) };
    });
    const runtimeAvailable=profile=>availableModels(profile).every(model=>model.available)&&([UPSCALE_PROFILE,RESIZE_PROFILE].includes(profile.id)?profile.types:Object.values(profile.graph).map(node=>node.class_type)).every(type=>objects[type]&&!objects[type].api_node&&!objects[type].dev_only);
    const modelProfiles=Object.keys(this.profiles).filter(id=>!RETIRED_VIDEO_PROFILES.includes(id))
      .filter(id=>!catalogProfile(id)||qualified===null||qualified.has(id)).map(id=>this.profile(id)).filter(runtimeAvailable)
      .map(item=>({id:item.id,...MODEL_PROFILES[item.id],available:true,workflowEditsRequireRuntimeValidation:true,ledger:profileLedger(item.id)}));
    const availableIds=new Set(modelProfiles.map(item=>item.id));
    const availableNode=type=>objects[type]&&!objects[type].api_node&&!objects[type].dev_only;
    const capabilities=[{mode:'t2i',modelProfile:PROFILE},{mode:'t2i',modelProfile:MOSS_PROFILE},{mode:'i2i',modelProfile:MOSS_PROFILE,inputRequired:true},{mode:'edit',modelProfile:MOSS_PROFILE,inputRequired:true,identityPreservationGuaranteed:false},{mode:'upscale',modelProfile:UPSCALE_PROFILE,inputRequired:true,ai:true},{mode:'upscale',modelProfile:RESIZE_PROFILE,inputRequired:true,ai:false}].filter(item=>availableIds.has(item.modelProfile)&&(!['i2i','edit'].includes(item.mode)||['LoadImage','ImageScale','VAEEncode'].every(availableNode)));
    for(const id of availableIds){
      const fixed=catalogProfile(id);if(!fixed)continue;
      const profile=this.profile(id),mapped=structuredClone(profile.graph);
      for(const node of Object.values(mapped))for(const model of catalogModels({node})){
        const options=comboChoices(objects[model.nodeType]?.input?.required?.[model.input]);
        node.inputs[model.input]=options?.find(value=>normalizeName(value)===normalizeName(model.name))??model.name;
      }
      try{validateCatalogSchemas(mapped,objects);capabilities.push({modelProfile:id,mode:fixed.mode,inputRequired:fixed.inputs>0,qualification:'fixed-catalog-template',runtimeTested:qualified?.has(id)===true});}catch{}
    }
    const exampleBinding={id:'11111111-1111-4111-8111-111111111111',purpose:'input',sha256:'a'.repeat(64),width:768,height:1024,comfyInputName:`controller-assets/${'a'.repeat(24)}/11111111-1111-4111-8111-111111111111-${'a'.repeat(64)}.png`};
    for(const id of MOSS_OFFICIAL_IDS.filter(id=>availableIds.has(id)))for(const candidateMode of (id===MOSS_OFFICIAL_IDS[0]?['t2i','layout','edit','depth']:['t2i','layout'])){
      const sample={modelProfile:id,mode:candidateMode,prompt:'schema check',negativePrompt:'',seed:'1',width:768,height:1024,...(candidateMode==='layout'?{layoutBoxes:[{x:0,y:0,width:100,height:100,kind:'object',description:'item'}]}:{}),...(['edit','depth'].includes(candidateMode)?{inputAssets:[{role:'source',binding:exampleBinding}]}:{})};
      const inspected=inspectMossOfficialSchemas(buildMossOfficialGraph(sample).graph,objects);
      if(inspected.ready)capabilities.push({modelProfile:id,mode:candidateMode,inputRequired:['edit','depth'].includes(candidateMode),qualification:'runtime-validation-required',runtimeTested:false});
    }
    const sampleOwner='schema-check',sampleHash=createHash('sha256').update(sampleOwner).digest('hex').slice(0,24),qwenSample={...exampleBinding,comfyInputName:exampleBinding.comfyInputName.replace('a'.repeat(24),sampleHash)};
    for(const id of QWEN21_OFFICIAL_IDS.filter(id=>availableIds.has(id)))for(const candidateMode of ['t2i','edit','background-removal']){
      const options={variant:id===QWEN21_PROFILES.base?'base':'turbo',mode:candidateMode,prompt:'schema check',seed:'1',width:768,height:1024,sessionId:sampleOwner,inputAssets:candidateMode==='t2i'?[]:[qwenSample]};
      try{const sample=buildQwen21Graph(options);validateQwen21Graph(sample.graph,{options,objects});capabilities.push({modelProfile:id,mode:candidateMode,inputRequired:candidateMode!=='t2i',qualification:'runtime-validation-required',runtimeTested:false});}catch{}
    }
    return {modelProfiles,availableIds,capabilities,availableModels,runtimeAvailable};
  }

  async catalog({modelProfile=this.profileId,mode=([UPSCALE_PROFILE,RESIZE_PROFILE].includes(modelProfile)?'upscale':[VIDEO_PROFILE_ID,H3_PROFILE_ID].includes(modelProfile)?'video':'t2i'),inputAssetId=null,sessionId=null,includeCatalogCandidates=false}={}, installedObjects) {
    if(typeof modelProfile!=='string'||!/^[-a-zA-Z0-9_.]{1,100}$/.test(modelProfile)){const error=new Error('Invalid requested model profile');error.status=400;throw error;}
    const objects = installedObjects ?? await this.installed();
    const {modelProfiles,availableIds,capabilities,availableModels,runtimeAvailable}=this.discoverCapabilities(objects,{includeCatalogCandidates});
    // No selected profile is silently substituted. An explicit name that is
    // absent from the live set may be uninstalled, unsupported or temporarily
    // unavailable; we do not infer which. No graph or model choices leak as
    // usable for such a request.
    const modeAvailable=capabilities.some(item=>item.modelProfile===modelProfile&&item.mode===mode);
    if(!modeAvailable)return {modelProfile:null,requestedProfile:modelProfile,requestedProfileStatus:availableIds.has(modelProfile)?'mode-unavailable':'unavailable',mode,inputAssetId:null,
      assetLimits:{purpose:'input is wired to ComfyUI; reference is for core understanding only'},capabilities,modelProfiles,coreModelLedger:coreModelLedger(),models:[],templates:[],nodeSchemas:{},limits:null,
      validationScope:'The requested profile and operation are not available together. Check installed assets, nodes and controller registration.'};
    assertModeProfile(mode,modelProfile);
    if(catalogProfile(modelProfile))return {modelProfile,mode,capabilities,modelProfiles,models:availableModels(this.profile(modelProfile)),templates:[],
      nodeSchemas:{},limits:catalogLimits(modelProfile),assetLimits:{purpose:'Ordered owned input assets; import control maps as input assets.'},
      validationScope:'Prepared catalog workflow. Current GPU capacity is checked separately.'};
    if(QWEN21_OFFICIAL_IDS.includes(modelProfile)){
      const names=objects.TextEncodeQwenImage21?.input?.required?.images?.[1]?.template?.names;
      let nativeInputs=0;if(Array.isArray(names))while(nativeInputs<QWEN21_MAX_INPUTS&&names.includes(`image_${nativeInputs+1}`))nativeInputs++;
      return {modelProfile,mode,capabilities,modelProfiles,models:availableModels(this.profile(modelProfile)),templates:[],nodeSchemas:{},limits:{dimensionMultiple:32,minDimension:32,maxDimension:4096,maxPixels:8388608,maxGeneratorInputs:nativeInputs,officialUiTemplateInputs:10,nativeNodeInputs:nativeInputs,batch:1},assetLimits:{purpose:'Ordered owned inputAssetIds only; referenceAssetIds are observation only'},validationScope:'Official UI templates expose 10 inputs. Inputs 11–16 are a Controller-built extension using the installed native node; all paths require actual GPU capacity and runtime validation. Prompt enhancement is a separate optional stage.'};
    }
    if(MOSS_OFFICIAL_IDS.includes(modelProfile))return {modelProfile,mode,capabilities,modelProfiles,models:availableModels(this.profile(modelProfile)),templates:[],nodeSchemas:{},limits:{dimensionMultiple:16,minDimension:256,maxDimension:4096,maxPixels:4194304,batch:1},assetLimits:{purpose:'Explicit owned inputAssetIds only; referenceAssetIds are observation only'},validationScope:'Node and model schema checks only. Runtime, GPU capacity, DSH delivery and image quality require validation.'};
    const inputAsset=inputAssetId?await this.assets?.binding(inputAssetId,sessionId,'input'):null;
    if(inputAssetId&&!inputAsset)throw new Error('Input asset storage is unavailable');
    const selected=this.profile(modelProfile),moss=modelProfile===MOSS_PROFILE;
    const models=availableModels(selected);
    const nodeSchemas = {};
    for (const type of selected.types) {
      const schema = objects[type];
      if (!schema || schema.api_node === true || schema.dev_only === true) continue;
      const { required, optional } = inputDefinitions(schema, { class_type: type });
      const compact = { required: {}, optional: {}, outputs: schema.output ?? [], outputNode: schema.output_node === true };
      for (const [category, definitions] of Object.entries({ required, optional })) {
        for (const [name, definition] of Object.entries(definitions)) {
          compact[category][name] = compactDefinition(definition);
          const matchingModels = models.filter(item => item.nodeType === type && item.input === name);
          if (matchingModels.length) compact[category][name].choices = matchingModels.filter(model=>model.available).map(model=>model.name);
        }
      }
      if (type === 'CLIPLoaderGGUF') compact.required.type.choices = ['qwen_image'];
      if(type==='CLIPLoader'&&moss) {compact.required.type.choices=['moss_image'];if(compact.optional.device)compact.optional.device.choices=['default'];if(compact.required.device)compact.required.device.choices=['default'];}
      if(type==='UNETLoader')compact.required.weight_dtype.choices=['default'];
      if (type === 'PathchSageAttentionKJ') {
        compact.required.sage_attention.choices = ['disabled'];
        if (compact.optional.allow_compile) compact.optional.allow_compile.const = false;
      }
      if (type === 'SaveImageAdvanced') {
        compact.required['format.bit_depth'].choices = ['8-bit'];
        compact.required['format.input_color_space'].choices = ['sRGB'];
        compact.required.filename_prefix.const = PREFIX;
      }
      if(type==='SaveImage')compact.required.filename_prefix.const=PREFIX;
      if(type==='LoadImage')compact.required.image.choices=inputAsset?[inputAsset.comfyInputName]:[];
      if(type==='SkipLayerGuidanceDiTSimple'){compact.required.double_layers.const='';compact.required.single_layers.const='22';}
      if(type==='ImageScale')for(const name of ['width','height'])Object.assign(compact.required[name],[UPSCALE_PROFILE,RESIZE_PROFILE].includes(modelProfile)?{min:64,max:4096,step:1}:{min:512,max:1536,step:32});
      if (type === 'EmptyLatentImage'||type==='EmptyFlux2LatentImage') {
        for (const name of ['width', 'height']) Object.assign(compact.required[name], { min: 512, max: 1536, step: 32 });
        compact.required.batch_size.const = 1;
      }
      if (type === 'KSampler') {
        compact.required.steps.max = modelProfile===VIDEO_PROFILE_ID?30:40;
        compact.required.cfg.max = 10;
        compact.required.seed.max = Number.MAX_SAFE_INTEGER;
      }
      if (type === 'SpectrumQwenImage21') {
        for (const [name, max] of Object.entries({ history_points: 8, chebyshev_degree: 4, max_consecutive_forecasts: 8,
          warmup_steps: 40, tail_actual_steps: 40, window_size: 8 })) compact.required[name].max = max;
        compact.required.debug.const = false;
      }
      nodeSchemas[type] = { ...compact, ledger: nodeLedger(type,schema) };
    }
    let templateGraph=structuredClone(selected.graph),templateChecked=null;
    const needsInput=['i2i','edit','upscale'].includes(mode)||modelProfile===H3_PROFILE_ID;
    if(!needsInput||inputAsset){
      if(moss&&mode!=='t2i')templateGraph=mossInputTemplate(selected.graph,mode,inputAsset);
      else if([UPSCALE_PROFILE,RESIZE_PROFILE].includes(modelProfile))templateGraph=upscaleTemplate(modelProfile,inputAsset);
      if(mode!=='t2i')try{templateChecked=validateWorkflowGraph(templateGraph,{objects,models,modelProfile,assetBinding:inputAsset});}catch{}
    }
    const templateStatus={inputRequired:needsInput,inputProvided:Boolean(inputAsset),
      omittedReason:needsInput&&!inputAsset?'input_asset_required':null,
      profileAvailable:runtimeAvailable(selected),
      ...(needsInput&&!inputAsset?{note:'Templates are omitted because a generator input image has not been supplied. This does not mean a template is absent or that model files are available; check profileAvailable and models separately.'}:{})};
    return {modelProfile,mode,inputAssetId,templateStatus,assetLimits:{purpose:'input is wired to ComfyUI; reference is for core understanding only'},capabilities,modelProfiles,
    coreModelLedger:coreModelLedger(), models, templates: needsInput&&!inputAsset?[]:[{ id: modelProfile,mode,inputAssetId,inputAsset, available: models.every(model=>model.available)&&Object.values(templateGraph).every(node => nodeSchemas[node.class_type])&&(mode==='t2i'||Boolean(templateChecked)),...(modelProfile===H3_PROFILE_ID?{qualification:'runtime-validation-required',runtimeTested:false}:{}),
      sha256: workflowGraphHash(templateGraph), graph: templateGraph, roles: templateChecked?.roles??(moss
        ? {text:'1',negativeText:'2',negativeZeroOut:null,sampler:'3',latent:'14',save:'15',decode:'4',vae:'6',diffusion:'7',clip:'108',slg:null,postprocess:[]}
        : { ...WORKFLOW_ROLES }) }],
    nodeSchemas, limits: { singleOutput: moss?'one SaveImage node':'one qualified output', roleIds: modelProfile!==PROFILE?null:{ ...WORKFLOW_ROLES }, maxNodes: moss?14:16, maxSteps:modelProfile===H3_PROFILE_ID?25:modelProfile===VIDEO_PROFILE_ID?30:40, maxPixels:[UPSCALE_PROFILE,RESIZE_PROFILE].includes(modelProfile)?8_388_608:[VIDEO_PROFILE_ID,H3_PROFILE_ID].includes(modelProfile)?500000:1_500_000,
      dimensionMultiple:[UPSCALE_PROFILE,RESIZE_PROFILE].includes(modelProfile)?1:32,minDimension:[UPSCALE_PROFILE,RESIZE_PROFILE].includes(modelProfile)?64:[VIDEO_PROFILE_ID,H3_PROFILE_ID].includes(modelProfile)?256:512,maxDimension:[UPSCALE_PROFILE,RESIZE_PROFILE].includes(modelProfile)?4096:modelProfile===H3_PROFILE_ID?1024:modelProfile===VIDEO_PROFILE_ID?832:1536,batch:1,externalNodes:false,resizeNodes:moss||[UPSCALE_PROFILE,RESIZE_PROFILE].includes(modelProfile),
      ...(modelProfile===VIDEO_PROFILE_ID?{minFrames:17,maxFrames:49,frameMultiplePlusOne:4,minFps:8,maxFps:24,defaultWidth:512,defaultHeight:288,defaultFrames:33,defaultFps:16,defaultSteps:20}:{}),
      ...(modelProfile===H3_PROFILE_ID?{videoMode:'ref2va',inputRequired:true,audio:true,minFrames:124,maxFrames:362,frameMultiple:17,frameRemainder:5,minFps:24,maxFps:24,defaultWidth:864,defaultHeight:480,defaultFrames:124,defaultFps:24,minSteps:20,defaultSteps:20}:{}),
      ...(modelProfile===UPSCALE_PROFILE?{aiUpscale:true,maxInputPixels:1_500_000,maxInputDimension:1536}:modelProfile===RESIZE_PROFILE?{aiUpscale:false}:{}),
      permittedModelChanges: false, optionalAttention: false, compiler: false, spectrumHistoryPointsMax: 8,
      ...(moss?{nodeIdPattern:MOSS_NODE_ID.source,nodeCounts:structuredClone(MOSS_COUNTS),
        negativePromptModes:['separate CLIPTextEncode (empty negative text is allowed)','ConditioningZeroOut of the positive CLIPTextEncode; render negativePrompt must be empty and sampler CFG must be <= 1'],
        zeroOutQualification:{maxCfg:1,appliesTo:'all permitted dimensions, SLG choices and render overrides on this 12 GiB profile',
          reason:'A live ConditioningZeroOut + CFG 2.5 run at 768x1024 stalled; the cause is not established.',
          alternatives:['Separate CLIPTextEncode for negative conditioning, including empty text','CFG 1 with ConditioningZeroOut; runtime validation is still required'],
          historicalReadAllowed:true},
        resize:{node:'ImageScale',maxNodes:2,position:'VAEDecode -> ImageScale (0..2) -> SaveImage',explicitDimensions:true,minDimension:512,maxDimension:1536,dimensionMultiple:32,maxPixels:1_500_000,renderDimensionsApplyTo:'latent only; final output uses the last ImageScale dimensions'},
        topology:['One CLIPLoader feeds all CLIPTextEncode nodes; separate positive and negative encoders, or one positive encoder plus ConditioningZeroOut.',
          'One UNETLoader -> optional SkipLayerGuidanceDiTSimple -> KSampler; either EmptyFlux2LatentImage or owned LoadImage -> ImageScale -> VAEEncode -> KSampler.',
          'KSampler + VAELoader -> VAEDecode -> optional ImageScale chain -> one SaveImage. All nodes must be reachable from that SaveImage; no cycles or disconnected nodes.'],
        roles:'Derived from typed connections; no fixed node IDs. Save prefix is replaced by controller ownership.'}:{} ) },
    validationScope: 'Static installed-schema, model, topology and bounds checks; edited graph performance and image quality are not certified.' };
  }

  async saveDraft({ productionId, graph, modelProfile = this.profileId, rationale,mode='t2i',inputAssetId=null,sessionId=null,official,inputRoles,inputAssetIds,briefInputIds,beforeWrite=async()=>{} } = {}) {
    if(typeof beforeWrite!=='function')throw new TypeError('Workflow admission callback must be a function');
    if (typeof productionId !== 'string' || !UUID.test(productionId)) throw new Error('productionId must be a canonical UUID');
    assertActiveProfile(modelProfile);
    const selected=this.profile(modelProfile);
    if(catalogProfile(modelProfile)){
      const reject=message=>{const e=new Error(message);e.status=400;throw e;};
      if(graph!==undefined||!isRecord(official)||Object.keys(official).some(k=>!['prompt','negativePrompt','seed','width','height','steps','frames','fps'].includes(k)))reject('Catalog workflows accept only exposed settings');
      if(typeof rationale!=='string'||!rationale.trim()||rationale.length>8000)reject('A bounded workflow rationale is required');
      const ids=briefInputIds??[];
      if(inputAssetIds!==undefined&&JSON.stringify(inputAssetIds)!==JSON.stringify(ids))reject('Ordered inputs differ from the brief');
      const inputAssets=[];
      for(const id of ids){const asset=await this.assets.binding(id,sessionId,'input');await this.assets.verifyBinding(asset,sessionId);assertInputBinding(asset);inputAssets.push(asset);}
      const request={...official,modelProfile,mode,inputAssets};
      const objects=await this.installed();
      let built;try{built=buildCatalogGraph(request,{installed:objects});validateCatalogSchemas(built.graph,objects);}catch(e){reject(e.message);}
      Object.assign(request,built.parameters);
      const snapshot={schemaVersion:6,id:randomUUID(),productionId,createdAt:new Date().toISOString(),rationale:rationale.trim(),modelProfile,mode,inputAssetIds:ids,
        request,graph:built.graph,output:built.output,sha256:workflowGraphHash(built.graph),validation:{kind:'static',runtimeTested:false}};
      await beforeWrite(snapshot);
      const directory=await safeDirectory(this.directory,true),target=path.join(directory,`${snapshot.id}.json`);
      const temporary=path.join(directory,`${snapshot.id}.${randomUUID()}.partial`),handle=await open(temporary,'wx',0o600);
      try{await handle.writeFile(JSON.stringify(snapshot,null,2)+'\n','utf8');await handle.sync();}finally{await handle.close();}
      try{try{await lstat(target);throw new Error('Draft identity already exists');}catch(error){if(error.code!=='ENOENT')throw error;}await rename(temporary,target);}
      catch(error){await unlink(temporary).catch(()=>{});throw error;}
      return structuredClone(snapshot);
    }
    if(QWEN21_OFFICIAL_IDS.includes(modelProfile)){
      const reject=message=>{const error=new Error(message);error.status=400;throw error;};
      if(graph!==undefined||!isRecord(official)||Object.keys(official).some(k=>!['prompt','negativePrompt','seed','width','height','steps','cfg','precision','encoder','vae','turboLora','editResolution','customSize','cacheDevice','cacheDtype'].includes(k)))reject('Official Qwen workflow accepts only bounded declarative options');
      if(typeof rationale!=='string'||!rationale.trim()||rationale.length>8000)reject('A bounded workflow rationale is required');
      if(!Array.isArray(inputAssetIds??[])||!Array.isArray(briefInputIds??[])||JSON.stringify(inputAssetIds??[])!==JSON.stringify(briefInputIds??[]))reject('Ordered inputs differ from the production brief');
      assertModeProfile(mode,modelProfile);
      const inputs=await resolveQwen21OwnedInputs(this.assets,sessionId,inputAssetIds??[],briefInputIds??[]);
      const options={...official,variant:modelProfile===QWEN21_PROFILES.base?'base':'turbo',mode,sessionId,inputAssets:inputs};
      let built;try{built=buildQwen21Graph(options);}catch(error){reject(error.message);}
      if(built.output.width*built.output.height>8388608)reject('Output exceeds the controller PNG collection limit');
      if((options.negativePrompt??'').trim()&&!built.negativePromptEffective)reject('Qwen CFG 1 does not apply negative conditioning; explicitly choose another supported CFG or leave negativePrompt empty');
      const objects=await this.installed();let checked;try{checked=validateQwen21Graph(built.graph,{options,objects});}catch(error){const rejected=new Error(`Qwen workflow schema validation failed: ${error.message}`);rejected.status=400;throw rejected;}
      const snapshot={schemaVersion:5,id:randomUUID(),productionId,createdAt:new Date().toISOString(),rationale:rationale.trim(),modelProfile,mode,inputAssetIds:inputs.map(x=>x.id),request:options,graph:checked.graph,output:checked.output,sha256:workflowGraphHash(checked.graph),negativePromptEffective:checked.negativePromptEffective,validation:{kind:'static',runtimeTested:false}};
      const bytes=JSON.stringify(snapshot,null,2)+'\n';if(Buffer.byteLength(bytes)>MAX_DRAFT_BYTES)throw new Error('Draft size limit exceeded');
      await beforeWrite(snapshot);
      const directory=await safeDirectory(this.directory,true),target=path.join(directory,`${snapshot.id}.json`),temporary=path.join(directory,`${snapshot.id}.${randomUUID()}.partial`),handle=await open(temporary,'wx',0o600);
      try{await handle.writeFile(bytes,'utf8');await handle.sync();}finally{await handle.close();}
      try{try{await lstat(target);throw new Error('Draft identity already exists');}catch(error){if(error.code!=='ENOENT')throw error;}await rename(temporary,target);}catch(error){await unlink(temporary).catch(()=>{});throw error;}
      return structuredClone(snapshot);
    }
    if(MOSS_OFFICIAL_IDS.includes(modelProfile)){
      if(graph!==undefined||!official||typeof official!=='object'||Array.isArray(official)||Object.hasOwn(official,'inputAssets')||official.promptEnhancer===true)throw new Error('Official workflow requires declarative options; prompt enhancement is not yet qualified');
      if(typeof rationale!=='string'||!rationale.trim()||rationale.length>8000)throw new Error('A bounded workflow rationale is required');
      const inputAssets=await resolveMossOwnedInputs(this.assets,sessionId,inputRoles??[],briefInputIds??[]);
      const request={...official,modelProfile,mode,inputAssets};
      const checked=buildMossOfficialGraph(request),objects=await this.installed(),inspection=inspectMossOfficialSchemas(checked.graph,objects);
      if(!inspection.ready){const rejected=new Error(`Workflow schema validation failed: ${JSON.stringify(inspection)}`);rejected.status=400;throw rejected;}
      const snapshot={schemaVersion:4,id:randomUUID(),productionId,createdAt:new Date().toISOString(),rationale:rationale.trim(),modelProfile,mode,inputAssetIds:inputAssets.map(item=>item.binding.id),request,graph:checked.graph,output:checked.output,sha256:workflowGraphHash(checked.graph),validation:{kind:'static',runtimeTested:false}};
      const bytes=JSON.stringify(snapshot,null,2)+'\n';if(Buffer.byteLength(bytes)>MAX_DRAFT_BYTES)throw new Error('Draft size limit exceeded');
      await beforeWrite(snapshot);
      const directory=await safeDirectory(this.directory,true),target=path.join(directory,`${snapshot.id}.json`),temporary=path.join(directory,`${snapshot.id}.${randomUUID()}.partial`),handle=await open(temporary,'wx',0o600);
      try{await handle.writeFile(bytes,'utf8');await handle.sync();}finally{await handle.close();}
      try{try{await lstat(target);throw new Error('Draft identity already exists');}catch(error){if(error.code!=='ENOENT')throw error;}await rename(temporary,target);}catch(error){await unlink(temporary).catch(()=>{});throw error;}
      return structuredClone(snapshot);
    }
    mediaIntent({mode,inputAssetId});assertModeProfile(mode,modelProfile);
    const inputAsset=inputAssetId?await this.assets?.binding(inputAssetId,sessionId,'input'):null;
    if(inputAssetId&&!inputAsset)throw new Error('Input asset storage is unavailable');
    if(modelProfile===H3_PROFILE_ID)assertInputBinding(inputAsset);
    if (typeof rationale !== 'string' || !rationale.trim() || rationale.length > 8000) throw new Error('A bounded workflow rationale is required');
    const objects = await this.installed();
    let checked;
    try { checked = validateWorkflowGraph(graph, { objects, models: selected.models,modelProfile,assetBinding:inputAsset }); }
    catch(error) {
      // Graph validation precedes workflow snapshot creation and production
      // binding. Earlier asset binding may already have copied an owned input
      // into the ComfyUI input cache; rejection does not mean zero side effects.
      const rejected=new Error(`Workflow validation failed: ${error.message}`);rejected.status=400;throw rejected;
    }
    const snapshot = { schemaVersion: mode!=='t2i'?3:modelProfile===MOSS_PROFILE?2:1,...(mode!=='t2i'?{mode,inputAsset}:{}), id: randomUUID(), productionId, createdAt: new Date().toISOString(),
      rationale: rationale.trim(), ...checked, validation: { kind: 'static', runtimeTested: false,
        installedSchemaSha256: hashJson(Object.fromEntries(selected.types.filter(type => objects[type]).map(type => [type, objects[type]]))) } };
    const bytes = JSON.stringify(snapshot, null, 2) + '\n';
    if (Buffer.byteLength(bytes) > MAX_DRAFT_BYTES) throw new Error('Draft size limit exceeded');
    await beforeWrite(snapshot);
    const directory = await safeDirectory(this.directory, true);
    const target = path.join(directory, `${snapshot.id}.json`);
    const temporary = path.join(directory, `${snapshot.id}.${randomUUID()}.partial`);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    try {
      try { await lstat(target); throw new Error('Draft identity already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await rename(temporary, target);
    } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    return structuredClone(snapshot);
  }

  async get(id) {
    if (typeof id !== 'string' || !UUID.test(id)) throw new Error('Draft ID must be a canonical UUID');
    const directory = await safeDirectory(this.directory, false);
    const filename = path.join(directory, `${id}.json`);
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DRAFT_BYTES) throw new Error('Unsafe or oversized workflow draft');
    const snapshot = JSON.parse(await readFile(filename, 'utf8'));
    if (snapshot.id !== id || ![1,2,3,4,5,6].includes(snapshot.schemaVersion) || !UUID.test(snapshot.productionId ?? '')) throw new Error('Draft identity mismatch');
    if(snapshot.schemaVersion===6){
      const {request,mode,modelProfile}=snapshot;
      if(!catalogProfile(modelProfile)||request?.modelProfile!==modelProfile||request?.mode!==mode||
        workflowGraphHash(snapshot.graph)!==snapshot.sha256||JSON.stringify(snapshot.inputAssetIds)!==JSON.stringify(request.inputAssets?.map(asset=>asset.id)))throw new Error('Catalog snapshot identity mismatch');
      const checked=validateCatalogGraph(snapshot.graph,request,{installed:await this.installed()});
      if(workflowGraphHash(checked.output)!==workflowGraphHash(snapshot.output))throw new Error('Catalog output mismatch');
      return structuredClone(snapshot);
    }
    if(snapshot.schemaVersion===5){
      if(!QWEN21_OFFICIAL_IDS.includes(snapshot.modelProfile)||snapshot.request?.variant!==(snapshot.modelProfile===QWEN21_PROFILES.base?'base':'turbo')||snapshot.request?.mode!==snapshot.mode||workflowGraphHash(snapshot.graph)!==snapshot.sha256||JSON.stringify(snapshot.inputAssetIds)!==JSON.stringify(snapshot.request?.inputAssets?.map(x=>x.id)))throw new Error('Official Qwen workflow identity mismatch');
      const objects=await this.installed(),checked=validateQwen21Graph(snapshot.graph,{options:snapshot.request,objects});if(workflowGraphHash(checked.output)!==workflowGraphHash(snapshot.output)||checked.negativePromptEffective!==snapshot.negativePromptEffective||checked.output.width*checked.output.height>8388608)throw new Error('Official Qwen workflow output mismatch');
      return structuredClone(snapshot);
    }
    if(snapshot.schemaVersion===4){
      if(!MOSS_OFFICIAL_IDS.includes(snapshot.modelProfile)||snapshot.request?.modelProfile!==snapshot.modelProfile||snapshot.request?.mode!==snapshot.mode||workflowGraphHash(snapshot.graph)!==snapshot.sha256||JSON.stringify(snapshot.inputAssetIds)!==JSON.stringify(snapshot.request?.inputAssets?.map(x=>x.binding.id)))throw new Error('Official workflow contract mismatch');
      const checked=validateMossOfficialGraph(snapshot.graph,snapshot.request);if(workflowGraphHash(checked.output)!==workflowGraphHash(snapshot.output))throw new Error('Official workflow output mismatch');
      const objects=await this.installed(),inspection=inspectMossOfficialSchemas(snapshot.graph,objects);if(!inspection.ready)throw new Error(`Official workflow schema unavailable: ${JSON.stringify(inspection)}`);
      return structuredClone(snapshot);
    }
    if(RETIRED_VIDEO_PROFILES.includes(snapshot.modelProfile)) {
      if(!/^[0-9a-f]{64}$/.test(snapshot.sha256??'')||workflowGraphHash(snapshot.graph)!==snapshot.sha256)throw new Error('Historical workflow hash mismatch');
      // Viewing stored history does not depend on retired model files, live
      // nodes, or runtime qualification and does not authorize execution.
      return {...structuredClone(snapshot),historicalReadOnly:true};
    }
    const objects = await this.installed();
    // Opening an existing record does not authorize another generation. New
    // drafts and adapter preflight/buildPrompt enforce current qualification.
    validateWorkflowSnapshot(snapshot, { objects, models: this.profile(snapshot.modelProfile).models, enforceRuntimeQualification:false });
    return structuredClone(snapshot);
  }
}
