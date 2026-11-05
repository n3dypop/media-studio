import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, mkdir, realpath, readFile, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { qualifiedWorkflowModels, validateWorkflowSnapshot,validateWorkflowGraph,workflowGraphHash,WORKFLOW_ROLES,MODEL_PROFILES,MOSS_PROFILE } from './workflows.mjs';
import {MOSS_OFFICIAL_IDS,QWEN21_OFFICIAL_IDS} from './media-modes.mjs';
import {buildMossOfficialGraph,validateMossOfficialGraph,inspectMossOfficialSchemas} from './moss-official.mjs';
import {QWEN21_PROFILES,buildQwen21Graph,validateQwen21Graph} from './qwen21-workflow.mjs';
import {makePreflightError,safePreflightIssue} from './preflight-diagnostics.mjs';
import {UPSCALE_PROFILE,RESIZE_PROFILE,RETIRED_VIDEO_PROFILES,assertActiveProfile,assertModeProfile,comboChoices,mossInputTemplate} from './media-modes.mjs';
import {upscaleTemplate} from './upscale-workflow.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEFAULT_PROFILE = fileURLToPath(new URL('../../workflows/approved/qwen-photo-v1.json', import.meta.url));
const MiB = 1024 ** 2;
const MAX_RESPONSE = 64 * MiB;
const DEFAULT_MIN_FREE = 8 * 1024 ** 3;
const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const EXPECTED_NODES = {
  1: 'TextEncodeQwenImage21', 2: 'QwenImage21Cache', 3: 'KSampler',
  4: 'VAEDecode', 6: 'VAELoader', 7: 'UnetLoaderGGUF', 14: 'EmptyLatentImage',
  15: 'SaveImageAdvanced', 70: 'PathchSageAttentionKJ', 71: 'SpectrumQwenImage21',
  108: 'CLIPLoaderGGUF',
};
const MODEL_INPUTS = [['6', 'vae_name'], ['7', 'unet_name'], ['108', 'clip_name']];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const canonicalModel = value => String(value).replaceAll('\\', '/');

function assertId(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new TypeError(`${label} must be a canonical UUID`);
}

function assertController(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || /[\x00-\x1f]/.test(value)) {
    throw new TypeError('controllerId must be a nonempty identifier of at most 128 characters');
  }
}

function validateProfile(prompt,modelProfile='qwen-photo-v1') {
  if(QWEN21_OFFICIAL_IDS.includes(modelProfile)){qualifiedWorkflowModels(prompt,modelProfile);if(!prompt?.encode||prompt.encode.class_type!=='TextEncodeQwenImage21'||prompt.save?.class_type!=='SaveImageAdvanced')throw new Error('Invalid official Qwen native profile');return;}
  if([UPSCALE_PROFILE,RESIZE_PROFILE].includes(modelProfile)){qualifiedWorkflowModels(prompt,modelProfile);return;}
  if(modelProfile===MOSS_PROFILE||MOSS_OFFICIAL_IDS.includes(modelProfile)){
    const expected={'1':'CLIPTextEncode','2':'CLIPTextEncode','3':'KSampler','4':'VAEDecode','6':'VAELoader','7':'UNETLoader','14':'EmptyFlux2LatentImage','15':'SaveImage','108':'CLIPLoader'};
    if(!prompt||Object.keys(prompt).length!==9||Object.entries(expected).some(([id,type])=>prompt[id]?.class_type!==type||!prompt[id]?.inputs))throw new Error('The MOSS profile must contain its native generation nodes');
    if(prompt['108'].inputs.type!=='moss_image'||prompt['14'].inputs.batch_size!==1)throw new Error('Invalid MOSS model or batch');
    qualifiedWorkflowModels(prompt,modelProfile);return;
  }
  if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt)
      || Object.keys(prompt).length !== Object.keys(EXPECTED_NODES).length) {
    throw new Error('The approved Qwen profile must contain exactly the known generation nodes');
  }
  for (const [id, type] of Object.entries(EXPECTED_NODES)) {
    if (prompt[id]?.class_type !== type || !prompt[id]?.inputs) throw new Error(`Unsupported profile node ${id}`);
  }
  if (prompt['70'].inputs.sage_attention !== 'disabled' || prompt['70'].inputs.allow_compile !== false
      || prompt['14'].inputs.batch_size !== 1 || prompt['15'].inputs.format !== 'png'
      || prompt['15'].inputs['format.bit_depth'] !== '8-bit') {
    throw new Error('The approved profile must use batch 1, PNG 8-bit and disabled optional attention');
  }
  const links = {
    '1.clip': ['108', 0], '1.vae': ['6', 0], '2.model': ['70', 0],
    '3.model': ['71', 0], '3.positive': ['1', 0], '3.negative': ['1', 1],
    '3.latent_image': ['14', 0], '4.samples': ['3', 0], '4.vae': ['6', 0],
    '15.images': ['4', 0], '70.model': ['7', 0], '71.model': ['2', 0],
  };
  for (const [key, expected] of Object.entries(links)) {
    const [id, input] = key.split('.');
    if (JSON.stringify(prompt[id].inputs[input]) !== JSON.stringify(expected)) throw new Error(`Unexpected profile link ${key}`);
  }
}

function queueParts(queue) {
  if (!queue || !Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending)) {
    throw new Error('Malformed ComfyUI queue response');
  }
  for (const item of [...queue.queue_running, ...queue.queue_pending]) {
    if (!Array.isArray(item) || typeof item[1] !== 'string' || !item[2] || typeof item[2] !== 'object' || Array.isArray(item[2]) || !item[3] || typeof item[3] !== 'object' || Array.isArray(item[3])) {
      throw new Error('Malformed ComfyUI queue item');
    }
  }
  return { running: queue.queue_running, pending: queue.queue_pending };
}

function gpuEvidence(stats) {
  const device = stats?.devices?.find(d => d.type === 'cuda' || String(d.name).includes('cuda'));
  const values = [device?.vram_free, device?.torch_vram_free, device?.torch_vram_total];
  if (!device || values.some(v => !Number.isFinite(v) || v < 0)) throw new Error('CUDA memory evidence is unavailable');
  const driverFreeBytes = device.vram_free - device.torch_vram_free;
  if (driverFreeBytes < 0) throw new Error('Inconsistent CUDA memory evidence');
  return {
    observedAt: new Date().toISOString(), driverFreeBytes,
    torchReservedBytes: device.torch_vram_total, torchFreeBytes: device.torch_vram_free,
    vramFreeBytes: device.vram_free,
  };
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

// Bounded structural/decompression validation, not an image-quality evaluation.
function validatePng(bytes, expected) {
  if (bytes.length < 45 || bytes.length > MAX_RESPONSE || !bytes.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new Error('Output is not a bounded PNG');
  }
  let offset = 8;
  let header;
  let ended = false;
  const compressed = [];
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset);
    const end = offset + 12 + size;
    if (end > bytes.length) throw new Error('Truncated PNG chunk');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + size)) !== bytes.readUInt32BE(offset + 8 + size)) {
      throw new Error('PNG chunk checksum mismatch');
    }
    if (offset === 8 && (type !== 'IHDR' || size !== 13)) throw new Error('Invalid PNG header');
    if (type === 'IHDR') {
      if (header || size !== 13) throw new Error('Invalid duplicate PNG header');
      const data = bytes.subarray(offset + 8, offset + 8 + size);
      const width = data.readUInt32BE(0);
      const height = data.readUInt32BE(4);
      const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[data[9]];
      if (width < 1 || height < 1 || width > 4096 || height > 4096 || width * height > 8_388_608
          || data[8] !== 8 || !channels || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        throw new Error('Unsupported PNG size or encoding');
      }
      if (expected && (width !== expected.width || height !== expected.height)) throw new Error('Output dimensions differ from submitted workflow');
      header = { width, height, channels };
    } else if (type === 'IDAT') {
      compressed.push(bytes.subarray(offset + 8, offset + 8 + size));
    } else if (type === 'IEND') {
      if (size !== 0 || end !== bytes.length) throw new Error('Invalid PNG end');
      ended = true;
      break;
    }
    offset = end;
  }
  if (!header || !ended || compressed.length === 0) throw new Error('Incomplete PNG');
  const stride = header.width * header.channels + 1;
  const rawSize = stride * header.height;
  const pixels = inflateSync(Buffer.concat(compressed), { maxOutputLength: rawSize });
  if (pixels.length !== rawSize) throw new Error('PNG pixel data size mismatch');
  for (let row = 0; row < header.height; row++) {
    if (pixels[row * stride] > 4) throw new Error('Invalid PNG scanline filter');
  }
  if(expected?.alpha==='supported-unverified'){
    const hasAlphaChannel=header.channels===2||header.channels===4;let transparentPixelDetected=false;
    if(hasAlphaChannel){
      const rowBytes=header.width*header.channels,prev=Buffer.alloc(rowBytes),current=Buffer.alloc(rowBytes),bpp=header.channels;
      for(let row=0;row<header.height;row++){
        const start=row*stride,filter=pixels[start];
        for(let i=0;i<rowBytes;i++){
          const x=pixels[start+1+i],a=i>=bpp?current[i-bpp]:0,b=prev[i],c=i>=bpp?prev[i-bpp]:0;
          const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c),paeth=pa<=pb&&pa<=pc?a:pb<=pc?b:c;
          current[i]=(x+(filter===0?0:filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):paeth))&255;
        }
        for(let i=bpp-1;i<rowBytes;i+=bpp)if(current[i]!==255){transparentPixelDetected=true;break;}
        current.copy(prev);
      }
    }
    return {width:header.width,height:header.height,alpha:{hasAlphaChannel,transparentPixelDetected:hasAlphaChannel?transparentPixelDetected:null}};
  }
  return { width: header.width, height: header.height };
}

// Only called after the owned history graph and its immutable workflow contract
// were validated. These are values present in Comfy's recorded graph; they do
// not prove the numerical effect of a parameter during GPU execution.
function historyGraphEvidence(graph,extra,roles){
  const contract=extra?.workflow_contract,version=contract?.version;
  if(![2,3,4,5].includes(version))return null;
  const sampler=graph?.[roles?.sampler??'sampler'],inputs=sampler?.inputs??{},req=contract.request??{};
  const modelNode=version===4?graph.unet:version===5?graph.diffusion:Object.values(graph).find(node=>node?.class_type==='UNETLoader');
  const modelName=modelNode?.inputs?.unet_name;
  const seed=inputs.seed??inputs.noise_seed??graph.noise?.inputs?.noise_seed;
  const steps=inputs.steps??graph.schedule?.inputs?.steps??(version===5&&req.variant==='turbo'?8:null);
  const cfg=inputs.cfg??graph.guider?.inputs?.cfg;
  const samplerName=inputs.sampler_name??graph.samplerSelect?.inputs?.sampler_name;
  const scheduler=inputs.scheduler??graph.schedule?.inputs?.scheduler;
  const evidence={source:'comfyui-history-graph',graphSha256:workflowGraphHash(graph),note:'Values recorded in the verified ComfyUI history graph; not independent measurements of numerical GPU behavior.'};
  if(typeof extra.model_profile==='string'&&/^[A-Za-z0-9_.-]{1,100}$/.test(extra.model_profile))evidence.modelProfile=extra.model_profile;
  if(typeof modelName==='string'&&/^[A-Za-z0-9_.-]{1,200}$/.test(modelName))evidence.modelFile=modelName;
  if(Number.isSafeInteger(seed)&&seed>=0)evidence.seed=String(seed);
  if(Number.isSafeInteger(steps)&&steps>0&&steps<=10000)evidence.steps=steps;
  if(typeof cfg==='number'&&Number.isFinite(cfg)&&cfg>=0&&cfg<=100)evidence.cfg=cfg;
  if(typeof samplerName==='string'&&/^[A-Za-z0-9_.-]{1,80}$/.test(samplerName))evidence.sampler=samplerName;
  if(typeof scheduler==='string'&&/^[A-Za-z0-9_.-]{1,80}$/.test(scheduler))evidence.scheduler=scheduler;
  return evidence;
}

function below(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function ensureSafeDirectory(root, destination) {
  const target = path.resolve(destination);
  if (!below(root, target)) throw new Error('Artifact destination escapes outputRoot');
  // Reject existing symlink/junction components, including ancestors of outputRoot.
  const parsed = path.parse(target);
  let current = parsed.root;
  for (const segment of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try { stat = await lstat(current); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('Artifact path contains a non-directory or link');
    if (!stat) await mkdir(current);
  }
  const realRoot = await realpath(root);
  const realTarget = await realpath(target);
  if (!below(realRoot, realTarget)) throw new Error('Resolved artifact destination escapes outputRoot');
  return realTarget;
}

export class ComfyAdapter {
  constructor({ baseUrl = 'http://127.0.0.1:8189', outputRoot, profilePath = DEFAULT_PROFILE,modelProfile='qwen-photo-v1',profilePaths={},
    assets=null,timeoutMs = 10_000, releaseMinFreeBytes = DEFAULT_MIN_FREE, releaseTimeoutMs = 45_000,
    releasePollMs = 1_000 } = {}) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
      throw new Error('ComfyUI baseUrl must be a loopback HTTP origin');
    }
    if (typeof outputRoot !== 'string' || !outputRoot) throw new TypeError('outputRoot is required');
    for (const [name, value] of Object.entries({ timeoutMs, releaseTimeoutMs, releasePollMs })) {
      if (!Number.isFinite(value) || value < 1) throw new TypeError(`${name} must be positive`);
    }
    if (!Number.isFinite(releaseMinFreeBytes) || releaseMinFreeBytes < 0) throw new TypeError('Invalid release memory threshold');
    this.baseUrl = url.origin;
    this.assets=assets;
    this.outputRoot = path.resolve(outputRoot);
    this.timeoutMs = timeoutMs;
    this.releaseMinFreeBytes = releaseMinFreeBytes;
    this.releaseTimeoutMs = releaseTimeoutMs;
    this.releasePollMs = releasePollMs;
    if(!Object.hasOwn(MODEL_PROFILES,modelProfile))throw new Error('Unknown default image model');
    this.modelProfile=modelProfile;this.profiles={};
    for(const [id,filename]of Object.entries({...profilePaths,[modelProfile]:profilePath})){
      if(!Object.hasOwn(MODEL_PROFILES,id))throw new Error('Unknown configured image model');
      const absolute=path.resolve(filename),bytes=readFileSync(absolute),graph=JSON.parse(bytes.toString('utf8'));
      validateProfile(graph,id);this.profiles[id]={id,graph,path:absolute,sha256:sha256(bytes)};
    }
    const selected=this.profiles[modelProfile];
    this.profilePath=selected.path;this.profileSha256=selected.sha256;this.profile=selected.graph;
    this.known = new Map();
    this.sent = new Set();
  }

  selectProfile(spec={}) {
    const id=spec.modelProfile??spec.workflow?.modelProfile??this.modelProfile;
    if(spec.modelProfile&&spec.workflow&&spec.workflow.modelProfile!==spec.modelProfile)throw new Error('Workflow and requested model differ');
    if(!Object.hasOwn(this.profiles,id))throw new Error('Requested image model is not configured');
    return this.profiles[id];
  }

  async request(route, { method = 'GET', body, bytes = false, timeoutMs = this.timeoutMs } = {}) {
    const signal = AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs)));
    const response = await fetch(new URL(route, this.baseUrl), {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      signal, redirect: 'error',
    });
    const statedLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(statedLength) && statedLength > MAX_RESPONSE) {
      await response.body?.cancel();
      throw new Error('ComfyUI response exceeds size limit');
    }
    const chunks = [];
    let length = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > MAX_RESPONSE) throw new Error('ComfyUI response exceeds size limit');
        chunks.push(chunk);
      }
    }
    const data = Buffer.concat(chunks, length);
    let parsed;
    if (!bytes && data.length) {
      try { parsed = JSON.parse(data.toString('utf8')); }
      catch { throw new Error(`ComfyUI returned non-JSON (HTTP ${response.status})`); }
    }
    if (!response.ok) {
      const error = new Error(`ComfyUI HTTP ${response.status}`);
      error.status = response.status;
      error.response = parsed;
      throw error;
    }
    return bytes ? data : parsed ?? {};
  }

  async preflight(spec={}) {
    let selected;try{selected=this.selectProfile(spec);}catch{throw makePreflightError('PROFILE_UNAVAILABLE');}
    if(spec.inputAsset||spec.inputAssets?.length||spec.referenceAssets?.length){try{if(!this.assets||!spec.assetSessionId)throw Error();for(const binding of [spec.inputAsset,...(spec.inputAssets??[]),...(spec.referenceAssets??[])].filter(Boolean))await this.assets.verifyBinding(binding,spec.assetSessionId);}catch{throw makePreflightError('ASSET_VERIFICATION_FAILED');}}
    let queue,objects,stats;try{[queue,objects,stats]=await Promise.all([
      this.request('/queue'), this.request('/object_info'), this.request('/system_stats'),
    ]);}catch{throw makePreflightError('COMFY_STATE_UNAVAILABLE');}
    const { running, pending } = queueParts(queue);
    this.workflowObjects = objects;
    const missingNodes = [...new Set(Object.values(spec.workflow?.graph??selected.graph).map(n=>n.class_type))].filter(type => !objects[type]);
    // This check also covers the legacy no-draft profile, which cannot use
    // validateWorkflowSnapshot. It checks Comfy's declared flags, not the
    // implementation's provenance or whether any code makes network calls.
    const unsafeNodes = [...new Set(Object.values(spec.workflow?.graph??selected.graph).map(n=>n.class_type))]
      .filter(type => objects[type]?.api_node === true || objects[type]?.dev_only === true);
    // Official drafts may explicitly select a different precision/encoder
    // than the baseline profile (for example MOSS depth or Qwen BF16). Check
    // the actual immutable draft's loaders rather than a different template.
    const modelGraph=[...MOSS_OFFICIAL_IDS,...QWEN21_OFFICIAL_IDS].includes(selected.id)&&spec.workflow?.graph?spec.workflow.graph:selected.graph;
    const models = qualifiedWorkflowModels(modelGraph,selected.id).map(model => {
      const input=model.input,type=model.nodeType,desired=model.name;
      const declaration = objects[type]?.input?.required?.[input] ?? objects[type]?.input?.optional?.[input];
      const choices = comboChoices(declaration);
      return { type, input, name: desired,role:model.role,
        available: Array.isArray(choices) && choices.some(choice => canonicalModel(choice) === canonicalModel(desired)) };
    });
    const diagnostics=[];
    if(missingNodes.length)diagnostics.push({code:'NODE_MISSING',count:missingNodes.length});
    if(unsafeNodes.length)diagnostics.push({code:'NODE_UNSAFE',count:unsafeNodes.length});
    const rolesByType={UNETLoader:['unet_name','diffusion'],UnetLoaderGGUF:['unet_name','diffusion'],CLIPLoader:['clip_name','text_encoder'],CLIPLoaderGGUF:['clip_name','text_encoder'],VAELoader:['vae_name','vae'],LoraLoaderModelOnly:['lora_name','lora'],LoadMoGeModel:['model_name','geometry_estimator']};
    for(const node of Object.values(spec.workflow?.graph??selected.graph)){
      const meta=rolesByType[node.class_type],schema=objects[node.class_type];if(!meta||!schema)continue;
      const choices=comboChoices(schema.input?.required?.[meta[0]]??schema.input?.optional?.[meta[0]]),name=node.inputs?.[meta[0]];
      if(!Array.isArray(choices)||!choices.some(value=>canonicalModel(value)===canonicalModel(name)))diagnostics.push({code:'MODEL_UNAVAILABLE',role:meta[1]});
    }
    for(const model of models)if(!model.available)diagnostics.push({code:'MODEL_UNAVAILABLE',role:model.role});
    let workflowError=null;
    if(spec.workflow){
      try{
        if(QWEN21_OFFICIAL_IDS.includes(selected.id)){
          const w=spec.workflow,variant=selected.id===QWEN21_PROFILES.base?'base':'turbo';
          if(w.schemaVersion!==5||w.modelProfile!==selected.id||w.request?.variant!==variant||w.mode!==spec.mode||w.request?.mode!==spec.mode||w.request?.sessionId!==spec.assetSessionId||w.request?.filenamePrefix!==undefined||workflowGraphHash(w.graph)!==w.sha256)throw makePreflightError('WORKFLOW_CONTRACT_MISMATCH');
          const checked=validateQwen21Graph(w.graph,{options:w.request,objects});
          if(workflowGraphHash(checked.output)!==workflowGraphHash(w.output)||checked.output.width*checked.output.height>8388608)throw makePreflightError('WORKFLOW_CONTRACT_MISMATCH','output');
          if(workflowGraphHash(w.request.inputAssets)!==workflowGraphHash(spec.inputAssets??[]))throw makePreflightError('WORKFLOW_CONTRACT_MISMATCH','inputAssets');
          if((w.request.negativePrompt??'').trim()&&!checked.negativePromptEffective)throw makePreflightError('WORKFLOW_PARAMETER_MISMATCH','negativePrompt');
          for(const [field,value] of Object.entries({prompt:spec.prompt,negativePrompt:spec.negativePrompt??'',seed:spec.seed,steps:spec.steps}))if((w.request[field]??({negativePrompt:'',seed:'42',steps:variant==='turbo'?8:25}[field]))!==value)throw makePreflightError('WORKFLOW_PARAMETER_MISMATCH',field);
          if(checked.output.width!==spec.width)throw makePreflightError('WORKFLOW_PARAMETER_MISMATCH','width');if(checked.output.height!==spec.height)throw makePreflightError('WORKFLOW_PARAMETER_MISMATCH','height');
        }else if(MOSS_OFFICIAL_IDS.includes(selected.id)){
          const w=spec.workflow;if(w.schemaVersion!==4||w.modelProfile!==selected.id||w.request?.modelProfile!==selected.id||w.mode!==spec.mode||w.request?.mode!==spec.mode||w.request?.promptEnhancer===true||workflowGraphHash(w.graph)!==w.sha256)throw makePreflightError('WORKFLOW_CONTRACT_MISMATCH');
          const checked=validateMossOfficialGraph(w.graph,w.request),inspection=inspectMossOfficialSchemas(w.graph,objects);
          if(!inspection.ready)throw makePreflightError('WORKFLOW_SCHEMA_MISMATCH');
          if(workflowGraphHash(checked.output)!==workflowGraphHash(w.output))throw makePreflightError('WORKFLOW_CONTRACT_MISMATCH','output');
          if(workflowGraphHash(w.request.inputAssets.map(x=>x.binding))!==workflowGraphHash(spec.inputAssets??[]))throw makePreflightError('WORKFLOW_CONTRACT_MISMATCH','inputAssets');
          for(const [field,value] of Object.entries({prompt:spec.prompt,negativePrompt:spec.negativePrompt??'',width:spec.width,height:spec.height,seed:spec.seed,steps:spec.steps}))if((w.request[field]??({negativePrompt:'',width:1024,height:1024,steps:w.mode==='edit'?30:25}[field]))!==value)throw makePreflightError('WORKFLOW_PARAMETER_MISMATCH',field);
        }else{
          const checked=validateWorkflowSnapshot(spec.workflow,{objects,models:qualifiedWorkflowModels(selected.graph,selected.id)});
          if(workflowGraphHash(spec.workflow.inputAsset??null)!==workflowGraphHash(spec.inputAsset??null))throw makePreflightError('WORKFLOW_CONTRACT_MISMATCH','inputAssets');
          if(checked.roles.negativeZeroOut&&(spec.negativePrompt??'')!=='')throw makePreflightError('WORKFLOW_PARAMETER_MISMATCH','negativePrompt');
        }
      }catch(error){workflowError=error.message;diagnostics.push(safePreflightIssue({code:error.preflightCode,field:error.preflightField})??{code:'WORKFLOW_VALIDATION_FAILED'});}
    }
    if([...MOSS_OFFICIAL_IDS,...QWEN21_OFFICIAL_IDS].includes(selected.id)&&!spec.workflow&&spec.prompt!==undefined){workflowError='Official workflow snapshot is required';diagnostics.push({code:'WORKFLOW_CONTRACT_MISMATCH'});}
    let memory;try{memory=gpuEvidence(stats);}catch{throw makePreflightError('RESOURCE_OBSERVATION_UNAVAILABLE');}
    return {
      queueEmpty: running.length === 0 && pending.length === 0,
      ready: running.length === 0 && pending.length === 0 && missingNodes.length === 0 && unsafeNodes.length === 0 && models.every(model => model.available) && workflowError===null,
      diagnostics,details: { running: running.length, pending: pending.length, missingNodes, unsafeNodes, models, workflowError,
        profile: selected.id, profilePath: selected.path, profileSha256: selected.sha256,
        nodeCount: Object.keys(selected.graph).length, memory },
    };
  }

  buildPrompt(spec, { runId, promptId, controllerId }) {
    assertId(runId, 'runId');
    assertId(promptId, 'promptId');
    assertController(controllerId);
    if (!spec || typeof spec.prompt !== 'string' || !spec.prompt.trim() || spec.prompt.length > 32_768) throw new TypeError('A bounded nonempty prompt is required');
    const negativePrompt = spec.negativePrompt ?? '';
    if (typeof negativePrompt !== 'string' || negativePrompt.length > 32_768) throw new TypeError('Invalid negativePrompt');
    assertActiveProfile(spec.modelProfile??spec.workflow?.modelProfile);
    const seed = spec.seed ?? '42';
    if (typeof seed !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(seed) || BigInt(seed) > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError('seed must be a decimal string in 0..9007199254740991; larger uint64 seeds cannot be serialized exactly by this adapter');
    }
    const mode=spec.mode??spec.workflow?.mode??'t2i',video=mode==='video',upscale=mode==='upscale';
    const width = spec.width ?? (video?512:1376);
    const height = spec.height ?? (video?288:768);
    const steps = spec.steps ?? 25;
    if(QWEN21_OFFICIAL_IDS.includes(spec.modelProfile??spec.workflow?.modelProfile)){
      const selected=this.selectProfile(spec),w=spec.workflow,variant=selected.id===QWEN21_PROFILES.base?'base':'turbo';
      if(!this.workflowObjects||!w||w.schemaVersion!==5||w.modelProfile!==selected.id||w.request?.variant!==variant||w.mode!==mode||w.request?.mode!==mode||w.request?.sessionId!==spec.assetSessionId||w.request?.filenamePrefix!==undefined||workflowGraphHash(w.graph)!==w.sha256)throw new Error('Official Qwen workflow identity mismatch');
      const original=validateQwen21Graph(w.graph,{options:w.request,objects:this.workflowObjects});
      if(workflowGraphHash(original.output)!==workflowGraphHash(w.output)||workflowGraphHash(w.request.inputAssets)!==workflowGraphHash(spec.inputAssets??[])||original.output.width*original.output.height>8388608||((w.request.negativePrompt??'').trim()&&!original.negativePromptEffective))throw new Error('Official Qwen workflow input or output mismatch');
      for(const [field,value] of Object.entries({prompt:spec.prompt,negativePrompt,seed,steps}))if((w.request[field]??({negativePrompt:'',seed:'42',steps:variant==='turbo'?8:25}[field]))!==value)throw new Error(`Official Qwen workflow ${field} differs from render`);
      if(original.output.width!==width||original.output.height!==height)throw new Error('Official Qwen rendered canvas differs from workflow output');
      const outputPrefix=`controller/${runId}/${promptId}/image`,options={...w.request,filenamePrefix:outputPrefix},built=buildQwen21Graph(options),checked=validateQwen21Graph(built.graph,{options,objects:this.workflowObjects});
      const ownership={controller_id:controllerId,run_id:runId,prompt_id:promptId},contract={version:5,request:w.request,output:checked.output,graphSha256:workflowGraphHash(checked.graph)};
      const draft={id:w.id,sha256:w.sha256,model_profile:selected.id},extra_data={local_genai:ownership,model_profile:selected.id,workflow_contract:contract,workflow_draft:draft,extra_pnginfo:{local_genai:ownership,model_profile:selected.id,workflow_contract:contract,workflow_draft:draft}};
      this.known.set(promptId,{ownership,...checked.output});return {prompt:checked.graph,extra_data,client_id:promptId,prompt_id:promptId};
    }
    if(MOSS_OFFICIAL_IDS.includes(spec.modelProfile??spec.workflow?.modelProfile)){
      const selected=this.selectProfile(spec),w=spec.workflow;
      if(!this.workflowObjects||!w||w.schemaVersion!==4||w.modelProfile!==selected.id||w.request?.modelProfile!==selected.id||w.mode!==mode||w.request?.mode!==mode||w.request?.promptEnhancer===true||workflowGraphHash(w.graph)!==w.sha256)throw new Error('Official workflow identity mismatch');
      const original=validateMossOfficialGraph(w.graph,w.request);
      if(workflowGraphHash(original.output)!==workflowGraphHash(w.output)||workflowGraphHash(w.request.inputAssets.map(x=>x.binding))!==workflowGraphHash(spec.inputAssets??[]))throw new Error('Official workflow input or output mismatch');
      for(const [field,value] of Object.entries({prompt:spec.prompt,negativePrompt,width,height,seed,steps}))if((w.request[field]??({negativePrompt:'',width:1024,height:1024,steps:mode==='edit'?30:25}[field]))!==value)throw new Error(`Official workflow ${field} differs from render`);
      const outputPrefix=`controller/${runId}/${promptId}/image`,checked=buildMossOfficialGraph(w.request,{outputPrefix}),inspection=inspectMossOfficialSchemas(checked.graph,this.workflowObjects);
      if(!inspection.ready)throw new Error(`Official workflow schema unavailable: ${JSON.stringify(inspection)}`);
      const ownership={controller_id:controllerId,run_id:runId,prompt_id:promptId},contract={version:4,request:w.request,output:checked.output,graphSha256:workflowGraphHash(checked.graph)};
      const draft={id:w.id,sha256:w.sha256,model_profile:selected.id},extra_data={local_genai:ownership,model_profile:selected.id,workflow_contract:contract,workflow_draft:draft,extra_pnginfo:{local_genai:ownership,model_profile:selected.id,workflow_contract:contract,workflow_draft:draft}};
      this.known.set(promptId,{ownership,...checked.output});return {prompt:checked.graph,extra_data,client_id:promptId,prompt_id:promptId};
    }
    if (![width, height].every(n => Number.isInteger(n) && n >= (video?256:upscale?64:512) && n <= (video?832:upscale?4096:1536) && n % (upscale?1:32) === 0)
        || width * height > (video?500000:upscale?8388608:1500000)) throw new RangeError('Dimensions exceed the selected media profile');
    if (!Number.isInteger(steps) || steps < 1 || steps > (video?30:40)) throw new RangeError('steps exceed the selected media profile');
    let prompt, checked;
    const selected=this.selectProfile(spec);
    assertModeProfile(mode,selected.id);
    const models=qualifiedWorkflowModels(selected.graph,selected.id),assetBinding=spec.inputAsset??null;
    if(spec.workflow&&workflowGraphHash(spec.workflow.inputAsset??null)!==workflowGraphHash(assetBinding))throw new Error('Workflow input differs from immutable production input');
    if (spec.workflow !== undefined && spec.workflow !== null) {
      if (!this.workflowObjects) throw new Error('Workflow drafts require installed-schema discovery before buildPrompt');
      checked = validateWorkflowSnapshot(spec.workflow, { objects: this.workflowObjects,
        models: qualifiedWorkflowModels(selected.graph,selected.id) });
      prompt=checked.graph;
    } else if([UPSCALE_PROFILE,RESIZE_PROFILE].includes(selected.id)){
      prompt=upscaleTemplate(selected.id,assetBinding);checked=validateWorkflowGraph(prompt,{objects:this.workflowObjects,models,modelProfile:selected.id,assetBinding});
    } else if(selected.id===MOSS_PROFILE){
      if(!this.workflowObjects)throw new Error('Native model requires installed-schema discovery');
      checked=validateWorkflowGraph(mossInputTemplate(selected.graph,mode,assetBinding),{objects:this.workflowObjects,models,modelProfile:selected.id,assetBinding});
      prompt=checked.graph;
    }else prompt = structuredClone(selected.graph);
    const roles=checked?.roles??WORKFLOW_ROLES;
    if(upscale){Object.assign(prompt[roles.resize].inputs,{width,height});}
    else if(selected.id===MOSS_PROFILE){
      prompt[roles.text].inputs.text=spec.prompt;
      if(roles.negativeText)prompt[roles.negativeText].inputs.text=negativePrompt;
      else if(negativePrompt!=='')throw new Error('ConditioningZeroOut requires an empty negativePrompt; use a separate CLIPTextEncode to apply negative text');
    }else if(!video){prompt[roles.text].inputs.prompt = spec.prompt;prompt[roles.text].inputs.negative_prompt = negativePrompt;}
    if(!upscale){Object.assign(prompt[roles.sampler].inputs, { seed: Number(seed), steps });Object.assign(prompt[roles.inputScale??roles.latent].inputs, { width, height });}
    if(['i2i','edit'].includes(mode))prompt[roles.sampler].inputs.denoise=spec.denoise??0.65;
    prompt[roles.save].inputs.filename_prefix = `controller/${runId}/${promptId}/image`;
    // Verify and record the actual output size after request overrides. A resize path
    // intentionally keeps its own explicit size, independent of the latent dimensions.
    if(selected.id!== 'qwen-photo-v1')checked=validateWorkflowGraph(prompt,{objects:this.workflowObjects,models,modelProfile:selected.id,normalize:false,assetBinding});
    const ownership = { controller_id: controllerId, run_id: runId, prompt_id: promptId };
    const payload = {
      prompt, extra_data: { local_genai: ownership, extra_pnginfo: { local_genai: ownership } },
      client_id: promptId, prompt_id: promptId,
    };
    payload.extra_data.model_profile=selected.id;
    payload.extra_data.extra_pnginfo.model_profile=selected.id;
    if(selected.id!=='qwen-photo-v1'){
      payload.extra_data.workflow_contract={version:mode==='t2i'?2:3,...(mode!=='t2i'?{mode,inputAsset:assetBinding}:{}),roles:checked.roles,output:checked.output,graphSha256:checked.sha256};
      payload.extra_data.extra_pnginfo.workflow_contract=payload.extra_data.workflow_contract;
    }
    if (spec.workflow) {
      payload.extra_data.workflow_draft = { id: spec.workflow.id, sha256: spec.workflow.sha256, model_profile: spec.workflow.modelProfile };
      payload.extra_data.extra_pnginfo.workflow_draft = payload.extra_data.workflow_draft;
    }
    this.known.set(promptId, { ownership, ...(checked?.output??{width,height}) });
    return payload;
  }

  async submit(payload) {
    assertId(payload?.prompt_id, 'prompt_id');
    if (this.sent.has(payload.prompt_id)) {
      const error = new Error('Duplicate submit refused; reconcile the durable prompt ID instead');
      error.submissionUnknown = true;
      throw error;
    }
    // This process-local guard complements the controller's durable intent transaction.
    this.sent.add(payload.prompt_id);
    try {
      const result = await this.request('/prompt', { method: 'POST', body: payload });
      if (result.prompt_id !== payload.prompt_id || !result.node_errors || typeof result.node_errors !== 'object') {
        throw new Error('Unexpected submit response; reconcile the original prompt ID');
      }
      return { prompt_id: result.prompt_id, node_errors: result.node_errors };
    } catch (error) {
      const explicitValidation = error.status === 400 && typeof error.response?.error?.type === 'string'
        && error.response.node_errors && typeof error.response.node_errors === 'object' && !error.response.prompt_id;
      error.submissionUnknown = !explicitValidation;
      error.definitelyRejected = Boolean(explicitValidation);
      throw error;
    }
  }

  async inspect(promptId) {
    assertId(promptId, 'promptId');
    const [queue, histories] = await Promise.all([
      this.request('/queue'), this.request(`/history/${encodeURIComponent(promptId)}`),
    ]);
    if(!histories||typeof histories!=='object'||Array.isArray(histories))throw new Error('Malformed ComfyUI history response');
    if(Object.keys(histories).some(id=>id!==promptId)||(Object.hasOwn(histories,promptId)&&(!histories[promptId]||typeof histories[promptId]!=='object'||Array.isArray(histories[promptId]))))throw new Error('Unexpected ComfyUI history response');
    const { running, pending } = queueParts(queue);
    const matchingRunning=running.filter(item=>item[1]===promptId),matchingPending=pending.filter(item=>item[1]===promptId);
    if(running.length+pending.length!==matchingRunning.length+matchingPending.length)throw new Error('Unmanaged queue entry prevents safe observation');
    if(matchingRunning.length+matchingPending.length>1)throw new Error('Duplicate queue entries for prompt ID; ownership is ambiguous');
    const runningItem=matchingRunning[0],pendingItem=matchingPending[0];
    const history = histories[promptId] ?? null;
    if(history&&(!Array.isArray(history.prompt)||history.prompt[1]!==promptId||!history.prompt[2]||typeof history.prompt[2]!=='object'||Array.isArray(history.prompt[2])||!history.prompt[3]||typeof history.prompt[3]!=='object'||Array.isArray(history.prompt[3])))throw new Error('History prompt or ownership data is malformed');
    if(history&&(runningItem||pendingItem))throw new Error('Prompt ID exists in both queue and history; ownership is ambiguous');
    const extraData = runningItem?.[3] ?? pendingItem?.[3] ?? history?.prompt?.[3] ?? null;
    return { queued: Boolean(pendingItem), running: Boolean(runningItem), history, extraData,
      queueItem: runningItem ?? pendingItem ?? null };
  }

  async cancel(promptId) {
    assertId(promptId, 'promptId');
    // Ownership is checked by the controller using inspect's actual queue/history metadata.
    // The target route atomically verifies the running ID; never use global /interrupt.
    const result = await this.request(`/api/jobs/${encodeURIComponent(promptId)}/cancel`, { method: 'POST', body: {} });
    if (typeof result.cancelled !== 'boolean') throw new Error('Malformed targeted cancellation response');
    return result; // Dispatch acknowledgement only, not evidence of execution termination.
  }

  async collect(promptId, { runId, controllerId, destination, spec=null }) {
    assertId(promptId, 'promptId');
    assertId(runId, 'runId');
    assertController(controllerId);
    const { history } = await this.inspect(promptId);
    if (!history) return [];
    const metadata = history.prompt[3]?.local_genai;
    if (!metadata || metadata.controller_id !== controllerId || metadata.run_id !== runId || metadata.prompt_id !== promptId) {
      throw new Error('Refusing output without matching controller/run/prompt ownership');
    }
    const graph = history.prompt[2], extra=history.prompt[3];
    if(RETIRED_VIDEO_PROFILES.includes(extra?.model_profile))throw new Error('Retired video outputs cannot be newly collected; existing recorded artifacts remain readable.');
    let saveId='15',expected={ width: graph?.['14']?.inputs?.width, height: graph?.['14']?.inputs?.height },historyRoles=null;
    if(extra?.workflow_contract!==undefined){
      const contract=extra.workflow_contract;
      if(contract.graphSha256!==workflowGraphHash(graph))throw new Error('History workflow contract or graph hash mismatch');
      this.workflowObjects??=await this.request('/object_info');
      if(QWEN21_OFFICIAL_IDS.includes(extra.model_profile)&&contract.version===5){
        const variant=extra.model_profile===QWEN21_PROFILES.base?'base':'turbo';
        if(contract.request?.variant!==variant||contract.request?.filenamePrefix!==undefined)throw new Error('History official Qwen model contract mismatch');
        const options={...contract.request,filenamePrefix:`controller/${runId}/${promptId}/image`},checked=validateQwen21Graph(graph,{options,objects:this.workflowObjects,modelsInstalled:false});
        if(workflowGraphHash(contract.output)!==workflowGraphHash(checked.output)||checked.output.width*checked.output.height>8388608)throw new Error('History official Qwen output mismatch');saveId='save';expected=checked.output;historyRoles={sampler:'sampler'};
      }else if(MOSS_OFFICIAL_IDS.includes(extra.model_profile)&&contract.version===4){
        if(contract.request?.modelProfile!==extra.model_profile||contract.request?.promptEnhancer===true)throw new Error('History official model contract mismatch');
        const checked=validateMossOfficialGraph(graph,contract.request,{outputPrefix:`controller/${runId}/${promptId}/image`});
        if(workflowGraphHash(contract.output)!==workflowGraphHash(checked.output))throw new Error('History official output mismatch');saveId='save';expected=checked.output;historyRoles={sampler:'sampler'};
      }else{
        if(![MOSS_PROFILE,UPSCALE_PROFILE,RESIZE_PROFILE].includes(extra.model_profile)||![2,3].includes(contract?.version))throw new Error('Unsupported history workflow contract');
        const selected=this.selectProfile({modelProfile:extra.model_profile});
        const checked=validateWorkflowGraph(graph,{objects:this.workflowObjects,models:qualifiedWorkflowModels(selected.graph,selected.id),modelProfile:selected.id,normalize:false,enforceRuntimeQualification:false,assetBinding:contract.inputAsset??null});
        if(workflowGraphHash(contract.roles)!==workflowGraphHash(checked.roles)||workflowGraphHash(contract.output)!==workflowGraphHash(checked.output))throw new Error('History workflow roles or output mismatch');
        saveId=checked.roles.save;expected=checked.output;historyRoles=checked.roles;
      }
    }
    let verifiedHistoryEvidence=null;
    if(historyRoles&&spec){
      try {
        // Rebuild from the immutable persisted run, not from history's own
        // metadata. A changed graph, missing schemas or an unreproducible
        // enhancer result leaves history settings unconfirmed; the artifact
        // may still be saved under the independently checked ownership rules.
        const submitted=this.buildPrompt(spec,{runId,promptId,controllerId});
        if(workflowGraphHash(submitted.prompt)===workflowGraphHash(graph))verifiedHistoryEvidence=historyGraphEvidence(graph,extra,historyRoles);
      }catch{}
    }
    const save = graph?.[saveId];
    const expectedFolder = `controller/${runId}/${promptId}`;
    const pngSave=save?.class_type==='SaveImageAdvanced'&&save.inputs?.format==='png';
    const nativeMossSave=save?.class_type==='SaveImage'&&[MOSS_PROFILE,UPSCALE_PROFILE,RESIZE_PROFILE,...MOSS_OFFICIAL_IDS].includes(history.prompt[3]?.model_profile);
    if ((!pngSave&&!nativeMossSave)||save.inputs?.filename_prefix !== `${expectedFolder}/image`) throw new Error('Unexpected output node or prefix');
    if (![expected.width, expected.height].every(Number.isInteger)) throw new Error('History does not contain explicit image dimensions');
    const references = history.outputs?.[saveId]?.images ?? [];
    if (!Array.isArray(references) || references.length > 1) throw new Error('Unexpected output count for batch-1 profile');
    if (!references.length) return [];
    const directory = await ensureSafeDirectory(this.outputRoot, destination ?? path.join(this.outputRoot, runId));
    const artifacts = [];
    for (const reference of references) {
      const filename = reference?.filename;
      const subfolder = String(reference?.subfolder ?? '').replaceAll('\\', '/');
      if (reference?.type !== 'output' || typeof filename !== 'string' || !/^image_[A-Za-z0-9_-]+\.png$/.test(filename)
          || subfolder !== expectedFolder) throw new Error('Unsafe or unexpected output reference');
      const query = new URLSearchParams({ filename, subfolder, type: 'output' });
      const bytes = await this.request(`/view?${query}`, { bytes: true });
      const dimensions = validatePng(bytes, expected);
      const digest = sha256(bytes);
      const name = `${promptId}-${filename}`;
      const artifactPath = path.join(directory, name);
      try {
        const file = await open(artifactPath, 'wx', 0o600);
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const stat = await lstat(artifactPath);
        if (!stat.isFile() || stat.isSymbolicLink() || sha256(await readFile(artifactPath)) !== digest) {
          throw new Error('Existing artifact differs or is unsafe; refusing overwrite');
        }
      }
      artifacts.push({ name, path: artifactPath, sha256: digest, ...dimensions, mime: 'image/png',...(verifiedHistoryEvidence?{historyEvidence:verifiedHistoryEvidence}:{}) });
    }
    return artifacts;
  }

  async release({assertEpoch=async()=>{},minFreeBytes=this.releaseMinFreeBytes}={}) {
    if(!Number.isSafeInteger(minFreeBytes)||minFreeBytes<0)throw new TypeError('Invalid release memory threshold');
    const started = Date.now();
    const deadline = started + this.releaseTimeoutMs;
    const remaining = () => {
      const value = deadline - Date.now();
      if (value <= 0) throw new Error('Timed out waiting for ComfyUI memory release; retain GPU lease');
      return Math.min(this.timeoutMs, value);
    };
    const assertEmpty = async () => {
      await assertEpoch();
      const queue = queueParts(await this.request('/queue', { timeoutMs: remaining() }));
      if (queue.running.length || queue.pending.length) throw new Error('Refusing global free with a nonempty or foreign queue; retain GPU lease');
      await assertEpoch();
    };
    await assertEmpty();
    await this.request('/free', { method: 'POST', body: { unload_models: true, free_memory: true }, timeoutMs: remaining() });
    await assertEpoch();
    const samples = [];
    let stable = [];
    while (true) {
      await assertEmpty();
      const evidence = gpuEvidence(await this.request('/system_stats', { timeoutMs: remaining() }));
      samples.push(evidence);
      const sufficient = evidence.driverFreeBytes >= minFreeBytes && evidence.torchReservedBytes < 512 * MiB;
      if (!sufficient) stable = [];
      else {
        stable.push(evidence);
        if (stable.length > 3) stable.shift();
      }
      if (stable.length === 3
          && Math.max(...stable.map(v => v.driverFreeBytes)) - Math.min(...stable.map(v => v.driverFreeBytes)) <= 64 * MiB
          && Math.max(...stable.map(v => v.torchReservedBytes)) - Math.min(...stable.map(v => v.torchReservedBytes)) <= 8 * MiB) {
        return { released: true, ...evidence, elapsedMs: Date.now() - started, samples,
          minDriverFreeBytes: minFreeBytes, maxTorchReservedBytesExclusive: 512 * MiB };
      }
      await delay(Math.min(this.releasePollMs, remaining()));
    }
  }
}
