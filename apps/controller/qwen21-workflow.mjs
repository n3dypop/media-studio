// Qwen-Image-2.1 official-template adaptation, not a registered capability.
// Caller must bind assets to the current session and perform GPU admission.
import {createHash} from 'node:crypto';
import {assertInputBinding,comboChoices,QWEN21_MAX_INPUTS} from './media-modes.mjs';

export const QWEN21_PROFILES=Object.freeze({base:'qwen-image-2.1-base-v1',turbo:'qwen-image-2.1-turbo-v1'});
export const QWEN21_MODELS=Object.freeze({
  base:Object.freeze({int8:'qwen_image_2.1_int8_convrot.safetensors',bf16:'qwen_image_2.1_bf16.safetensors'}),
  turbo:Object.freeze({int8:'qwen_image_2.1_turbo_int8_convrot.safetensors',bf16:'qwen_image_2.1_turbo_bf16.safetensors'}),
  encoder:Object.freeze({int8:'qwen3vl_8b_int8_convrot.safetensors',bf16:'qwen3vl_8b_bf16.safetensors'}),
  vae:Object.freeze({official:'qwen_image_2.1_vae_bf16.safetensors',textureFix:'texture_fix_vae_for_qwen_image_2.1_bf16.safetensors'}),
  enhancer:Object.freeze({t2i:'qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors',edit:'qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors'}),
  turboLora:'qwen_image_2.1_turbo_lora_avg_rank_178_bf16.safetensors',
});
export const QWEN21_TURBO_SIGMAS='1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0';
const SCHEMA_ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail=message=>{throw new Error(message);};
const node=(class_type,inputs)=>({class_type,inputs});
export async function resolveQwen21OwnedInputs(assets,session,ids,briefIds){
  if(!assets||typeof session!=='string'||!session.trim()||!Array.isArray(ids)||!Array.isArray(briefIds)||ids.length>QWEN21_MAX_INPUTS||JSON.stringify(ids)!==JSON.stringify(briefIds))fail('Ordered inputs differ from the production brief');
  const resolved=[];
  for(const id of ids){const binding=await assets.binding(id,session,'input');await assets.verifyBinding(binding,session);resolved.push(binding);}
  return ownedInputs(resolved,resolved.length?'edit':'t2i',session);
}
const choice=(table,key,label)=>Object.hasOwn(table,key)?table[key]:fail(`Unsupported ${label}`);
const validText=(text,name,max=6000)=>{if(typeof text!=='string'||!text.trim()||text.length>max)fail(`Invalid ${name}`);return text;};
const dimensions=(width,height)=>{
  if(![width,height].every(n=>Number.isSafeInteger(n)&&n>=32&&n<=4096&&n%32===0)||width*height>4096**2)fail('Invalid Qwen output dimensions');
  return {width,height};
};
// Python's round() uses ties-to-even; Comfy's TextEncodeQwenImage21 does too.
const roundEven=n=>{const floor=Math.floor(n),fraction=n-floor;return fraction===0.5?(floor%2===0?floor:floor+1):Math.round(n);};
export function qwen21EditDimensions(binding,resolution){
  assertInputBinding(binding);
  if(!Number.isSafeInteger(resolution)||resolution<0||resolution>4096||resolution%32)fail('Invalid edit resolution');
  const ratio=binding.width/binding.height;
  const width=Math.max(32,roundEven((resolution?Math.sqrt(resolution*resolution*ratio):binding.width)/32)*32);
  const height=Math.max(32,roundEven((resolution?Math.sqrt(resolution*resolution/ratio):binding.height)/32)*32);
  return dimensions(width,height);
}
function ownedInputs(inputs,mode,sessionId){
  if(!Array.isArray(inputs)||inputs.length>QWEN21_MAX_INPUTS||(mode==='t2i'&&inputs.length)||(mode!=='t2i'&&!inputs.length))fail('Qwen mode requires zero or 1–16 ordered generator input images');
  if(inputs.length&&(typeof sessionId!=='string'||!sessionId.trim()||sessionId.length>160))fail('A generator input session is required');
  const ownerKey=inputs.length?createHash('sha256').update(sessionId).digest('hex').slice(0,24):null;
  const seen=new Set();
  for(const item of inputs){assertInputBinding(item);if(!SCHEMA_ID.test(item.id)||seen.has(item.id)||!item.comfyInputName.startsWith(`controller-assets/${ownerKey}/`))fail('Repeated, unowned or invalid generator input');seen.add(item.id);}
  return inputs;
}
function addInputs(graph,inputs){
  inputs.forEach((asset,i)=>{
    const load=`input_${i+1}`,rgba=`rgba_${i+1}`;
    graph[load]=node('LoadImage',{image:asset.comfyInputName});
    // LoadImage separates alpha into its MASK output; rejoin so transparent
    // source material reaches the Qwen VAE instead of being silently flattened.
    graph[rgba]=node('JoinImageWithAlpha',{image:[load,0],alpha:[load,1]});
  });
}
function generationOptions(options){
  if(!options||typeof options!=='object'||Array.isArray(options))fail('Qwen options are required');
  const variant=options.variant??'base',precision=options.precision??'int8',encoder=options.encoder??'int8',vae=options.vae??'official',mode=options.mode??'t2i';
  if(!['base','turbo'].includes(variant)||!['t2i','edit','background-removal'].includes(mode))fail('Unsupported Qwen variant or mode');
  const model=choice(QWEN21_MODELS[variant],precision,'diffusion precision'),clip=choice(QWEN21_MODELS.encoder,encoder,'encoder precision'),vaeName=choice(QWEN21_MODELS.vae,vae,'VAE');
  const inputs=ownedInputs(options.inputAssets??[],mode,options.sessionId);
  const prompt=validText(options.prompt,'prompt'),negativePrompt=options.negativePrompt??'';
  if(typeof negativePrompt!=='string'||negativePrompt.length>3000)fail('Invalid negative prompt');
  const seed=options.seed??'42';if(typeof seed!=='string'||!/^(0|[1-9][0-9]{0,15})$/.test(seed)||BigInt(seed)>BigInt(Number.MAX_SAFE_INTEGER))fail('Invalid seed');
  const cfg=options.cfg??1;if(typeof cfg!=='number'||!Number.isFinite(cfg)||cfg<0||cfg>100)fail('Invalid guidance');
  const steps=options.steps??(variant==='turbo'?8:25);
  if(!Number.isSafeInteger(steps)||steps<1||steps>10000||(variant==='turbo'&&steps!==8))fail('Turbo requires its fixed 8-step schedule');
  const turboLora=options.turboLora??false;if(typeof turboLora!=='boolean'||turboLora&&(variant!=='base'||steps!==8))fail('Official Turbo LoRA requires base variant and eight steps');
  // The official edit/background-removal subgraph exposes 0 at top level,
  // overriding the internal encoder widget's 1024 default.
  const editResolution=options.editResolution??0;
  if(!Number.isSafeInteger(editResolution)||editResolution<0||editResolution>4096||editResolution%32)fail('Invalid edit resolution');
  const customSize=options.customSize??(mode==='t2i');if(typeof customSize!=='boolean'||mode==='t2i'&&!customSize)fail('Invalid canvas selection');
  const output=customSize?dimensions(options.width??1024,options.height??1024):qwen21EditDimensions(inputs[0],editResolution);
  const cacheDevice=options.cacheDevice??'auto',cacheDtype=options.cacheDtype??'default';
  if(!['auto','cpu','gpu','off'].includes(cacheDevice)||!['default','int8','int4'].includes(cacheDtype))fail('Invalid cache configuration');
  const prefix=options.filenamePrefix??'controller/template/image';
  if(typeof prefix!=='string'||!/^controller\/[A-Za-z0-9_/-]{1,220}$/.test(prefix)||prefix.includes('..'))fail('Unsafe output prefix');
  return {variant,precision,encoder,vae,mode,model,clip,vaeName,inputs,prompt,negativePrompt,seed,cfg,steps,turboLora,editResolution,customSize,output,cacheDevice,cacheDtype,prefix};
}
export function buildQwen21Graph(options){
  const s=generationOptions(options),g={};addInputs(g,s.inputs);
  g.diffusion=node('UNETLoader',{unet_name:s.model,weight_dtype:'default'});
  g.clip=node('CLIPLoader',{clip_name:s.clip,type:'qwen_image',device:'default'});
  g.vae=node('VAELoader',{vae_name:s.vaeName});
  let model=['diffusion',0];
  if(s.turboLora){g.lora=node('LoraLoaderModelOnly',{model,lora_name:QWEN21_MODELS.turboLora,strength_model:1});model=['lora',0];}
  g.cache=node('QwenImage21Cache',{model,device:s.cacheDevice,dtype:s.cacheDtype});
  const encode={clip:['clip',0],vae:['vae',0],prompt:s.prompt,negative_prompt:s.negativePrompt,resolution:s.editResolution};
  s.inputs.forEach((_,i)=>{encode[`images.image_${i+1}`]=[`rgba_${i+1}`,0];});
  g.encode=node('TextEncodeQwenImage21',encode);
  let latent=['encode',2];
  if(s.customSize){g.latent=node('EmptyLatentImage',{width:s.output.width,height:s.output.height,batch_size:1});latent=['latent',0];}
  if(s.variant==='base')g.sampler=node('KSampler',{model:['cache',0],positive:['encode',0],negative:['encode',1],latent_image:latent,seed:Number(s.seed),steps:s.steps,cfg:s.cfg,sampler_name:'euler',scheduler:'simple',denoise:1});
  else{
    g.noise=node('RandomNoise',{noise_seed:Number(s.seed)});
    g.guider=node('CFGGuider',{model:['cache',0],positive:['encode',0],negative:['encode',1],cfg:s.cfg});
    g.samplerSelect=node('KSamplerSelect',{sampler_name:'euler'});
    g.sigmas=node('ManualSigmas',{sigmas:QWEN21_TURBO_SIGMAS});
    g.sampler=node('SamplerCustomAdvanced',{noise:['noise',0],guider:['guider',0],sampler:['samplerSelect',0],sigmas:['sigmas',0],latent_image:latent});
  }
  g.decode=node('VAEDecode',{samples:['sampler',0],vae:['vae',0]});
  g.save=node('SaveImageAdvanced',{images:['decode',0],filename_prefix:s.prefix,format:'png','format.bit_depth':'8-bit','format.input_color_space':'sRGB'});
  return {graph:g,roles:{text:'encode',sampler:'sampler',latent:s.customSize?'latent':'encode',save:'save'},output:{...s.output,batch:1,mime:'image/png',alpha:'supported-unverified'},inputAssets:s.inputs.map(x=>({id:x.id,sha256:x.sha256})),negativePromptEffective:s.cfg!==1,steps:s.steps,modelProfile:QWEN21_PROFILES[s.variant]};
}
// Do not let non-JSON values, cycles, or object-prototype properties disappear
// during canonicalization of an untrusted graph.
function canonical(x,seen=new Set(),depth=0){
  if(depth>32)fail('Qwen graph exceeds maximum nesting');
  if(x===null||typeof x==='string'||typeof x==='boolean')return x;
  if(typeof x==='number'&&Number.isFinite(x))return x;
  if(typeof x!=='object'||seen.has(x))fail('Qwen graph contains non-JSON or cyclic values');
  if(!Array.isArray(x)&&Object.getPrototypeOf(x)!==Object.prototype&&Object.getPrototypeOf(x)!==null)fail('Qwen graph object has an unsafe prototype');
  seen.add(x);
  let result;
  if(Array.isArray(x))result=x.map(value=>canonical(value,seen,depth+1));
  else{
    const entries=Object.entries(x).sort(([a],[b])=>a.localeCompare(b));
    if(entries.some(([key])=>['__proto__','constructor','prototype'].includes(key)))fail('Qwen graph contains an unsafe property');
    result=Object.fromEntries(entries.map(([key,value])=>[key,canonical(value,seen,depth+1)]));
  }
  seen.delete(x);return result;
}
export function qwen21GraphHash(graph){return createHash('sha256').update(JSON.stringify(canonical(graph))).digest('hex');}
const OUTPUTS={UNETLoader:['MODEL'],CLIPLoader:['CLIP'],VAELoader:['VAE'],LoraLoaderModelOnly:['MODEL'],LoadImage:['IMAGE','MASK'],JoinImageWithAlpha:['IMAGE'],QwenImage21Cache:['MODEL'],TextEncodeQwenImage21:['CONDITIONING','CONDITIONING','LATENT'],EmptyLatentImage:['LATENT'],KSampler:['LATENT'],RandomNoise:['NOISE'],CFGGuider:['GUIDER'],KSamplerSelect:['SAMPLER'],ManualSigmas:['SIGMAS'],SamplerCustomAdvanced:['LATENT','LATENT'],VAEDecode:['IMAGE'],SaveImageAdvanced:['IMAGE']};
export function validateQwen21Graph(graph,{options,objects,modelsInstalled=true}={}){
  const expected=buildQwen21Graph(options);
  if(qwen21GraphHash(graph)!==qwen21GraphHash(expected.graph))fail('Qwen graph differs from its immutable generation contract');
  for(const value of Object.values(graph)){
    const schema=objects?.[value.class_type];
    if(!schema||schema.api_node||schema.dev_only||(schema.output_node&&value.class_type!=='SaveImageAdvanced')||!Array.isArray(schema.output)||OUTPUTS[value.class_type]?.some((type,i)=>schema.output[i]!==type))fail(`Unavailable, changed or unsafe node: ${value.class_type}`);
    const required=schema.input?.required??{},optional=schema.input?.optional??{};
    for(const name of Object.keys(value.inputs)){
      if(name.startsWith('images.image_')&&value.class_type==='TextEncodeQwenImage21')continue;
      if(name.startsWith('format.')&&value.class_type==='SaveImageAdvanced')continue;
      if(!Object.hasOwn(required,name)&&!Object.hasOwn(optional,name))fail(`Unsupported node input: ${value.class_type}.${name}`);
    }
    for(const name of Object.keys(required))if(name!=='images'&&!Object.hasOwn(value.inputs,name))fail(`Missing node input: ${value.class_type}.${name}`);
  }
  if(modelsInstalled){
    for(const [id,input] of [['diffusion','unet_name'],['clip','clip_name'],['vae','vae_name'],...(graph.lora?[['lora','lora_name']]:[])]){
      const item=graph[id],schema=objects[item.class_type];if(!comboChoices(schema.input?.required?.[input])?.includes(item.inputs[input]))fail(`Model unavailable: ${id}`);
    }
  }
  const names=objects.TextEncodeQwenImage21?.input?.required?.images?.[1]?.template?.names;
  if(!Array.isArray(names)||expected.inputAssets.some((_,i)=>!names.includes(`image_${i+1}`)))fail('Qwen ordered image schema differs');
  const png=objects.SaveImageAdvanced?.input?.required?.format?.[1]?.options?.find(item=>item.key==='png');
  if(!comboChoices(png?.inputs?.required?.bit_depth)?.includes('8-bit')||!comboChoices(png?.inputs?.required?.input_color_space)?.includes('sRGB'))fail('Qwen PNG output schema differs');
  return {...expected,sha256:qwen21GraphHash(graph),validation:'static-only'};
}

// A prompt enhancer must be a separate managed step. The caller has to capture
// PreviewAny's actual text, validate a nonempty rewrite and record it before
// submitting the image job; this builder does not claim that integration exists.
export function buildQwen21EnhancerGraph({mode,prompt,systemPrompt,inputAssets=[],sessionId,seed='42',thinking=false,maxLength}={}){
  if(!['t2i','edit'].includes(mode))fail('Unsupported prompt enhancer mode');
  validText(prompt,'prompt');validText(systemPrompt,'system prompt',30000);
  const inputs=ownedInputs(inputAssets,mode,sessionId),budget=maxLength??(thinking?(mode==='t2i'?16256:24000):4096);
  if(typeof thinking!=='boolean'||!Number.isSafeInteger(budget)||budget<1||budget>32768||typeof seed!=='string'||!/^(0|[1-9][0-9]{0,15})$/.test(seed)||BigInt(seed)>BigInt(Number.MAX_SAFE_INTEGER))fail('Invalid prompt enhancer options');
  const g={};addInputs(g,inputs);
  g.clip=node('CLIPLoader',{clip_name:QWEN21_MODELS.enhancer[mode],type:mode==='t2i'?'stable_diffusion':'qwen_image',device:'default'});
  g.system=node('PrimitiveStringMultiline',{value:systemPrompt});
  const args={clip:['clip',0],prompt,max_length:budget,sampling_mode:'on','sampling_mode.temperature':1,'sampling_mode.top_k':20,'sampling_mode.top_p':0.95,'sampling_mode.min_p':0,'sampling_mode.repetition_penalty':1,'sampling_mode.seed':Number(seed),'sampling_mode.presence_penalty':mode==='t2i'?1.5:0,thinking,use_default_template:true,system_prompt:['system',0]};
  // The official edit template's batch starts at image0, not image1.
  if(inputs.length){g.batch=node('BatchImagesNode',Object.fromEntries(inputs.map((_,i)=>[`images.image${i}`,[`rgba_${i+1}`,0]])));args.image=['batch',0];}
  g.enhance=node('TextGenerate',args);g.preview=node('PreviewAny',{source:['enhance',0]});
  return {graph:g,outputNode:'preview',inputAssets:inputs.map(x=>({id:x.id,sha256:x.sha256})),requiresNonemptyOutputCheck:true,validation:'not-integrated'};
}
