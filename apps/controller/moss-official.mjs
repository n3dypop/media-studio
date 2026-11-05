// Fixed API graph builders for the native ComfyUI MOSS family.  This module is
// not a Controller registration and does not submit or validate a GPU run.
// Each input binding MUST have been resolved and reverified by AssetStore for
// the owning DSH session before invoking it; referenceAssetIds (observation
// only) are never implicitly converted into generator inputs.
import {isDeepStrictEqual} from 'node:util';
import {assertInputBinding} from './media-modes.mjs';

export const MOSS_OFFICIAL_PROFILES=Object.freeze({
  'moss-image-sft-official-v1':Object.freeze({label:'MOSS-Image SFT',diffusion:'moss_image_sft_int8_convrot.safetensors'}),
  'moss-image-base-official-v1':Object.freeze({label:'MOSS-Image Base',diffusion:'moss_image_base_int8_convrot.safetensors'}),
});
export const MOSS_OFFICIAL_MODES=Object.freeze(['t2i','layout','edit','depth']);
const ENCODER='qwen3.5_9b_w4a8_gptq.safetensors',DEPTH_ENCODER='qwen3.5_9b_int8_convrot.safetensors',VAE='flux2-vae_small.safetensors';
const EDIT_LORA='moss_image_edit_lora_rank_64_bf16.safetensors',DEPTH_LORA='moss_image_color_depth_control.safetensors',MOGE='moge_3_vitg_fp16.safetensors';
const MAX_PIXELS=4_194_304;
const prefix=/^controller\/(?:template|[a-f0-9-]{36}\/[a-f0-9-]{36})\/image$/;
const fail=message=>{throw new Error(message);};
const text=(value,name,max=6000,empty=false)=>{if(typeof value!=='string'||(!empty&&!value.trim())||value.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))fail(`Invalid ${name}`);return value;};
const bool=(v,name)=>{if(typeof v!=='boolean')fail(`Invalid ${name}`);return v;};
const number=(v,name,min,max)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)fail(`Invalid ${name}`);return v;};
const integer=(v,name,min,max)=>{number(v,name,min,max);if(!Number.isSafeInteger(v))fail(`Invalid ${name}`);return v;};
const node=(class_type,inputs)=>({class_type,inputs});

/** Resolve explicitly selected generator inputs against the owning session.
 * Both the immutable source and the copied Comfy input are reverified; an
 * observation-only reference can never be promoted implicitly. The caller
 * must compare ids against the production brief before passing them here. */
export async function resolveMossOwnedInputs(assets,session,inputRoles,briefInputIds){
  if(!assets||typeof session!=='string'||!session.trim()||!Array.isArray(inputRoles)||!Array.isArray(briefInputIds)||inputRoles.length!==briefInputIds.length||inputRoles.length>6)fail('Invalid production input contract');
  const resolved=[];
  for(let i=0;i<inputRoles.length;i++){
    const item=inputRoles[i];
    if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(k=>!['id','role'].includes(k))||item.id!==briefInputIds[i])fail('Ordered input ids differ from the production brief');
    const binding=await assets.binding(item.id,session,'input');
    await assets.verifyBinding(binding,session);
    resolved.push({role:item.role,binding});
  }
  return resolved;
}

function bindings(value,mode,enhancer){
  if(!Array.isArray(value)||value.length>6)fail('Invalid inputAssets');
  const seen=new Set(),roles=new Map();
  for(const item of value){
    if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(k=>!['role','binding'].includes(k))||!['source','edit-reference','depth-map','color-map','enhancer-reference'].includes(item.role))fail('Invalid input role');
    assertInputBinding(item.binding);
    if(seen.has(item.binding.id))fail('Each generator input must be a distinct owned asset');seen.add(item.binding.id);
    const list=roles.get(item.role)??[];list.push(item.binding);roles.set(item.role,list);
  }
  if([...roles].some(([role,items])=>items.length>(role==='edit-reference'?3:1)))fail('Duplicate input role');
  if(mode==='edit'&&((roles.get('source')?.length??0)!==1||[...roles.keys()].some(k=>!['source','edit-reference'].includes(k))))fail('Edit requires one source and up to three additional generator-input references');
  if(mode==='edit'&&value[0]?.role!=='source')fail('The source must be the first edit input; remaining inputs retain their declared order');
  if(mode==='depth'&&((roles.has('source')&&roles.has('depth-map'))||(!roles.has('source')&&!roles.has('depth-map')&&!roles.has('color-map'))||[...roles.keys()].some(k=>!['source','depth-map','color-map'].includes(k))))fail('Control requires a color map, depth map, or source; source and depth map are mutually exclusive');
  if(['t2i','layout'].includes(mode)&&[...roles.keys()].some(k=>k!=='enhancer-reference'))fail('Text and layout accept only an explicitly bound enhancer reference');
  if(roles.has('enhancer-reference')&&!enhancer)fail('An enhancer reference requires the prompt enhancer');
  return roles;
}
function boxList(value,width,height){
  if(!Array.isArray(value)||value.length<1||value.length>24)fail('Layout requires 1 to 24 explicit boxes');
  return value.map(box=>{
    if(!box||typeof box!=='object'||Array.isArray(box)||Object.keys(box).some(k=>!['x','y','width','height','kind','description','text','palette'].includes(k))||!['object','text','character'].includes(box.kind))fail('Invalid layout kind');
    for(const key of ['x','y','width','height'])integer(box[key],`box.${key}`,key==='width'||key==='height'?1:0,key==='x'||key==='width'?width:height);
    if(box.x+box.width>width||box.y+box.height>height)fail('Layout box exceeds the canvas');
    const desc=text(box.description,'box.description',1000),display=box.kind==='text'?text(box.text,'box.text',500):'';
    if(box.kind!=='text'&&box.text!==undefined)fail('Only a text box can contain rendered text');
    const palette=box.palette??[];if(!Array.isArray(palette)||palette.length>5||palette.some(color=>typeof color!=='string'||!/^#[a-f0-9]{6}$/i.test(color)))fail('Invalid box palette');
    return {x:box.x,y:box.y,width:box.width,height:box.height,metadata:{type:box.kind==='text'?'text':'obj',text:display,desc,palette:[...palette]}};
  });
}
function validEncodedBoxes(inputs){
  try{
    const {width,height,bboxes}=inputs;
    if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||typeof bboxes!=='string'||bboxes.length>50000)return false;
    const boxes=JSON.parse(bboxes);if(!Array.isArray(boxes)||JSON.stringify(boxes)!==bboxes)return false;
    const request=boxes.map(box=>{
      if(!box||typeof box!=='object'||Array.isArray(box)||Object.keys(box).some(k=>!['x','y','width','height','metadata'].includes(k)))throw Error('invalid box');
      const m=box.metadata;if(!m||typeof m!=='object'||Array.isArray(m)||Object.keys(m).some(k=>!['type','text','desc','palette'].includes(k))||!['text','obj'].includes(m.type)||typeof m.text!=='string'||(m.type==='obj'&&m.text!==''))throw Error('invalid metadata');
      return {x:box.x,y:box.y,width:box.width,height:box.height,kind:m.type==='text'?'text':'object',description:m.desc,...(m.type==='text'?{text:m.text}:{}),palette:m.palette};
    });
    return isDeepStrictEqual(boxList(request,width,height),boxes);
  }catch{return false;}
}

/** Construct a graph solely from a declarative request. Array order is the
 * generator-input order; no raw path, node graph, URL or observation-only
 * reference is accepted. Caller must persist the validated request and hashes. */
export function buildMossOfficialGraph(request,{outputPrefix='controller/template/image'}={}){
  if(!request||typeof request!=='object'||Array.isArray(request))fail('Invalid request');
  const allowed=new Set(['modelProfile','precision','mode','prompt','negativePrompt','width','height','seed','steps','cfg','sampler','scheduler','skipLayerGuidance','promptEnhancer','enhancerSeed','layoutBoxes','controlStrength','controlStart','controlEnd','geometryOutput','inputAssets']);
  if(Object.keys(request).some(k=>!allowed.has(k)))fail('Unexpected request field');
  const profile=MOSS_OFFICIAL_PROFILES[request.modelProfile];if(!profile)fail('Unknown MOSS model profile');
  const precision=request.precision??'int8';if(!['int8','bf16'].includes(precision))fail('Unsupported MOSS precision');
  const mode=request.mode??'t2i';if(!MOSS_OFFICIAL_MODES.includes(mode))fail('Unsupported MOSS official mode');
  if(['depth','edit'].includes(mode)&&request.modelProfile!=='moss-image-sft-official-v1')fail('Official edit and depth workflows are qualified for SFT only');
  const prompt=text(request.prompt,'prompt'),negative=text(request.negativePrompt??'','negativePrompt',3000,true);
  const width=integer(request.width??1024,'width',256,4096),height=integer(request.height??1024,'height',256,4096);
  if(width%16||height%16||width*height>MAX_PIXELS)fail('MOSS canvas must be 16-pixel aligned and no larger than 4,194,304 pixels');
  if(typeof request.seed!=='string'||!/^(0|[1-9]\d{0,15})$/.test(request.seed)||BigInt(request.seed)>BigInt(Number.MAX_SAFE_INTEGER))fail('Invalid seed');
  const seed=Number(request.seed),steps=integer(request.steps??(mode==='edit'?30:25),'steps',1,10000),cfg=number(request.cfg??(mode==='edit'?4:mode==='depth'?3:2.5),'cfg',0,100);
  const sampler=request.sampler??(mode==='edit'?'euler':'er_sde'),scheduler=request.scheduler??(mode==='edit'?'normal':'simple');
  if(!['euler','er_sde'].includes(sampler)||!['normal','simple'].includes(scheduler))fail('The fixed official builder supports its documented sampler and scheduler choices');
  if(mode==='depth'&&sampler!=='er_sde')fail('The official depth graph requires its ER-SDE sampler');
  const slg=bool(request.skipLayerGuidance??(mode==='edit'||mode==='depth'||mode==='layout'||request.modelProfile==='moss-image-base-official-v1'),'skipLayerGuidance');
  const enhancer=bool(request.promptEnhancer??false,'promptEnhancer');
  if(enhancer&&!['t2i','layout'].includes(mode))fail('Prompt enhancer is only supported for text and layout');
  if(!prefix.test(outputPrefix))fail('Invalid controller-owned output prefix');
  const roles=bindings(request.inputAssets??[],mode,enhancer),graph={};
  if(mode==='depth')for(const [role,list] of roles){const asset=list[0];if(asset.width*height!==asset.height*width)fail(`Control input ${role} aspect ratio differs from the requested canvas; supply a matching asset or agree to a resize first`);}
  graph.clip=node('CLIPLoader',{clip_name:mode==='depth'?DEPTH_ENCODER:ENCODER,type:'moss_image',device:'default'});
  graph.unet=node('UNETLoader',{unet_name:precision==='bf16'?profile.diffusion.replace('_int8_convrot.safetensors','_bf16.safetensors'):profile.diffusion,weight_dtype:'default'});
  graph.vae=node('VAELoader',{vae_name:VAE});
  let model=['unet',0],positiveText=prompt;
  if(mode==='layout'){
    const boxes=boxList(request.layoutBoxes,width,height);
    // Comfy's prompt validator treats every raw array as a link, including a
    // list of two box objects. Its __value__ wrapper mutates the submitted
    // graph during validation, breaking our exact history-hash contract. The
    // native node explicitly accepts JSON via bboxes; null is its empty editor
    // state, so the freshly supplied incoming boxes take priority unchanged.
    graph.boxes=node('CreateBoundingBoxes',{width,height,editor_state:null,bboxes:JSON.stringify(boxes)});
    const characters=request.layoutBoxes.map((b,i)=>b.kind==='character'?String(i+1):null).filter(Boolean).join(', ');
    graph.layout=node('MOSSImageLayoutPrompt',{prompt,element:['boxes',2],width,height,character_boxes:characters});positiveText=['layout',0];
  }else if(request.layoutBoxes!==undefined)fail('Layout boxes require layout mode');
  if(enhancer){
    if(request.enhancerSeed===undefined||typeof request.enhancerSeed!=='string'||!/^(0|[1-9]\d{0,15})$/.test(request.enhancerSeed)||BigInt(request.enhancerSeed)>BigInt(Number.MAX_SAFE_INTEGER))fail('An explicit prompt enhancer seed is required');
    const enhancerInputs={clip:['clip',0],prompt:positiveText,max_length:4096,sampling_mode:'on','sampling_mode.temperature':0.7,'sampling_mode.top_k':64,'sampling_mode.top_p':0.95,'sampling_mode.min_p':0.05,'sampling_mode.repetition_penalty':1,'sampling_mode.seed':Number(request.enhancerSeed)};
    if(roles.has('enhancer-reference')){graph.enhancerImage=node('LoadImage',{image:roles.get('enhancer-reference')[0].comfyInputName});enhancerInputs.image=['enhancerImage',0];}
    graph.enhance=node('TextGenerate',enhancerInputs);positiveText=['enhance',0];
  }else if(request.enhancerSeed!==undefined)fail('An enhancer seed requires prompt enhancer');
  if(mode==='edit'){
    graph.lora=node('LoraLoaderModelOnly',{model,lora_name:EDIT_LORA,strength_model:1});model=['lora',0];
    const all=[roles.get('source')[0],...(roles.get('edit-reference')??[])];const imageInputs={};
    all.forEach((asset,i)=>{const id=`image${i}`,scaled=`scaled${i}`;graph[id]=node('LoadImage',{image:asset.comfyInputName});graph[scaled]=node('ImageScaleToTotalPixels',{image:[id,0],upscale_method:'lanczos',megapixels:1,resolution_steps:16});imageInputs[`images.image_${i}`]=[scaled,0];});
    const args={clip:['clip',0],vae:['vae',0],edit_format:'Moss-Image-Edit',image_strength:1,...imageInputs};
    graph.positive=node('TextEncodeMOSSImageEdit',{...args,prompt});graph.negative=node('TextEncodeMOSSImageEdit',{...args,prompt:negative});
  }else{graph.positive=node('CLIPTextEncode',{clip:['clip',0],text:positiveText});graph.negative=node('CLIPTextEncode',{clip:['clip',0],text:negative});}
  if(mode==='depth'){
    graph.lora=node('LoraLoaderModelOnly',{model,lora_name:DEPTH_LORA,strength_model:1});
    graph.tsr=node('TemporalScoreRescaling',{model:['lora',0],tsr_k:0.95,tsr_sigma:1});
    graph.flow=node('ModelSamplingAuraFlow',{model:['tsr',0],shift:5,sampling:'flow'});model=['flow',0];
  }
  if(slg){graph.slg=node('SkipLayerGuidanceDiTSimple',{model,double_layers:'',single_layers:mode==='depth'?'24':'22',start_percent:0,end_percent:mode==='t2i'||mode==='layout'?0.5:1});model=['slg',0];}
  let positive=['positive',0],negativeLink=['negative',0];
  if(mode==='depth'){
    let depth;
    if(roles.has('depth-map')){if(request.geometryOutput!==undefined)fail('Geometry output requires a source image');graph.depthInput=node('LoadImage',{image:roles.get('depth-map')[0].comfyInputName});graph.depthScale=node('ImageScale',{image:['depthInput',0],upscale_method:'lanczos',width,height,crop:'disabled'});depth=['depthScale',0];}
    else if(roles.has('source')){graph.source=node('LoadImage',{image:roles.get('source')[0].comfyInputName});graph.sourceScale=node('ImageScale',{image:['source',0],upscale_method:'lanczos',width,height,crop:'disabled'});graph.moge=node('LoadMoGeModel',{model_name:MOGE});graph.geometry=node('MoGeInference',{moge_model:['moge',0],image:['sourceScale',0],resolution_level:9,fov_x_degrees:0,batch_size:4,force_projection:true,apply_mask:true,refine_steps:3});const output=request.geometryOutput??'depth';if(!['depth','mask'].includes(output))fail('Geometry output must be depth or mask');graph.geometryRender=node('MoGeRender',{moge_geometry:['geometry',0],output});depth=['geometryRender',0];}
    else if(request.geometryOutput!==undefined)fail('Geometry output requires a source image');
    const control={positive,negative:negativeLink,vae:['vae',0],strength:number(request.controlStrength??1,'controlStrength',0,10),start_percent:number(request.controlStart??0,'controlStart',0,1),end_percent:number(request.controlEnd??0.6,'controlEnd',0,1),...(depth?{depth_map:depth}:{})};
    if(control.start_percent>control.end_percent)fail('Control range is reversed');
    if(roles.has('color-map')){graph.colorInput=node('LoadImage',{image:roles.get('color-map')[0].comfyInputName});graph.colorScale=node('ImageScale',{image:['colorInput',0],upscale_method:'nearest-exact',width,height,crop:'disabled'});control.color_map=['colorScale',0];}
    graph.control=node('MOSSImageControl',control);positive=['control',0];negativeLink=['control',1];
  }else if(['controlStrength','controlStart','controlEnd','geometryOutput'].some(k=>request[k]!==undefined))fail('Control settings require depth mode');
  graph.latent=node(mode==='depth'?'EmptyLatentImage':'EmptyFlux2LatentImage',{width,height,batch_size:1});
  if(mode==='depth'){
    graph.samplerKind=node('SamplerER_SDE',{solver_type:'ER-SDE',max_stage:3,eta:1,s_noise:1.05});graph.schedule=node('BasicScheduler',{model,scheduler,steps,denoise:1});
    graph.sampler=node('SamplerCustom',{model,add_noise:true,noise_seed:seed,cfg,positive,negative:negativeLink,sampler:['samplerKind',0],sigmas:['schedule',0],latent_image:['latent',0]});
  }else graph.sampler=node('KSampler',{model,positive,negative:negativeLink,latent_image:['latent',0],seed,steps,cfg,sampler_name:sampler,scheduler,denoise:1});
  graph.decode=node('VAEDecode',{samples:['sampler',0],vae:['vae',0]});graph.save=node('SaveImage',{images:['decode',0],filename_prefix:outputPrefix});
  return {graph,output:{width,height,batch:1,mime:'image/png'},modelProfile:request.modelProfile,precision,mode,inputAssets:structuredClone(request.inputAssets??[]),
    warnings:mode==='layout'&&enhancer?['The prompt enhancer may rewrite or discard the requested layout.']:[],
    scope:'Static graph construction only; not an executable qualification or ownership check.'};
}

/** Only a graph produced from the stored request is accepted; no post-save
 * node, file path, model or connection can be silently substituted. */
export function validateMossOfficialGraph(graph,request,options){
  const expected=buildMossOfficialGraph(request,options);
  if(!isDeepStrictEqual(graph,expected.graph))fail('MOSS official graph differs from its fixed declarative contract');
  return expected;
}

/** Cross-check a fixed graph against the ComfyUI schemas that were actually
 * discovered. This does not submit /prompt, run code or prove VRAM sufficiency. */
export function inspectMossOfficialSchemas(graph,objects){
  if(!objects||typeof objects!=='object'||Array.isArray(objects))fail('Installed schemas unavailable');
  const missing=[],unsafe=[],invalid=[];
  for(const [id,n] of Object.entries(graph)){
    const schema=objects[n.class_type];if(!schema){missing.push(n.class_type);continue;}
    // CreateBoundingBoxes is flagged as an output node because it returns UI
    // coordinates. Its implementation writes a preview only when a background
    // image is connected; the fixed builder never allows a background and
    // supplies only a JSON-encoded literal, never a node or remote API.
    const localBoxes=n.class_type==='CreateBoundingBoxes'&&!Object.hasOwn(n.inputs,'background')&&!Object.hasOwn(n.inputs,'last_incoming')&&n.inputs.editor_state===null&&validEncodedBoxes(n.inputs);
    if(schema.api_node===true||schema.dev_only===true||(schema.output_node===true&&n.class_type!=='SaveImage'&&!localBoxes)){unsafe.push(n.class_type);continue;}
    const required=schema.input?.required??{},optional=schema.input?.optional??{},all={...required,...optional};
    for(const [name,definition] of Object.entries(required)){
      if(definition?.[0]==='COMFY_AUTOGROW_V3'){
        const template=definition[1]?.template,prefix=template?.prefix,min=template?.min??0;
        if(typeof prefix!=='string'||Object.keys(n.inputs).filter(k=>k.startsWith(`${name}.${prefix}`)).length<min)invalid.push(`${id}.${name}:missing-dynamic-input`);
      }else if(!Object.hasOwn(n.inputs,name))invalid.push(`${id}.${name}:missing`);
    }
    for(const [key,value] of Object.entries(n.inputs)){
      let definition=all[key];
      if(!definition&&key.includes('.')){
        const [group,field]=key.split('.',2),parent=all[group];
        if(parent?.[0]==='COMFY_AUTOGROW_V3')definition=Object.values(parent[1]?.template?.input?.required??{})[0];
        else if(parent?.[0]==='COMFY_DYNAMICCOMBO_V3'){
          const option=parent[1]?.options?.find(x=>x.key===n.inputs[group]);definition=option?.inputs?.required?.[field]??option?.inputs?.optional?.[field];
        }
      }
      if(!definition){invalid.push(`${id}.${key}:unknown`);continue;}
      const kind=definition[0],options=definition[1]??{},isLink=Array.isArray(value)&&value.length===2&&typeof value[0]==='string'&&Number.isSafeInteger(value[1]);
      if(isLink){if(!graph[value[0]]||objects[graph[value[0]].class_type]?.output?.[value[1]]!==kind)invalid.push(`${id}.${key}:type`);continue;}
      // Comfy's validate_inputs interprets *every* array as a connection,
      // even when it is malformed or contains literal objects.
      if(Array.isArray(value)){invalid.push(`${id}.${key}:invalid-link`);continue;}
      if(n.class_type==='LoadImage'&&key==='image')continue; // caller already verifies the immutable input binding
      const choices=Array.isArray(kind)?kind:kind==='COMBO'?options.options:null;
      if(choices&&!choices.includes(value))invalid.push(`${id}.${key}:choice`);
      else if(kind==='COMFY_DYNAMICCOMBO_V3'&&!options.options?.some(x=>x.key===value))invalid.push(`${id}.${key}:choice`);
      else if(['INT','FLOAT'].includes(kind)&&(typeof value!=='number'||!Number.isFinite(value)||(kind==='INT'&&!Number.isSafeInteger(value))||(options.min!==undefined&&value<options.min)||(options.max!==undefined&&value>options.max)))invalid.push(`${id}.${key}:bounds`);
      else if(kind==='STRING'&&typeof value!=='string')invalid.push(`${id}.${key}:string`);
      else if(kind==='BOOLEAN'&&typeof value!=='boolean')invalid.push(`${id}.${key}:boolean`);
    }
  }
  return {ready:missing.length===0&&unsafe.length===0&&invalid.length===0,missing:[...new Set(missing)],unsafe:[...new Set(unsafe)],invalid};
}
