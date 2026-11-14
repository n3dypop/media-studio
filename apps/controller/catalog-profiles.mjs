// Local managed equivalents of the catalog templates. All node types,
// connections, model selectors and output paths are supplied here.
import {isDeepStrictEqual} from 'node:util';

const h3 = {family:'h3', inputs:1, steps:6};
const pruna = {family:'pruna', inputs:1, steps:8};
const fast = {family:'fast', steps:8};
const control = {family:'control', steps:20};
export const CATALOG_PROFILES = Object.freeze({
  'minimax-h3-image-t2i-v1': {...h3,label:'MiniMax H3 Image t2i',mode:'t2i',inputs:0},
  'minimax-h3-image-edit-v1': {...h3,label:'MiniMax H3 Image Edit',mode:'edit'},
  'p-h3-image-t2i-v1': {...pruna,label:'Pruna P-H3-Image t2i',mode:'t2i',inputs:0},
  'p-h3-image-edit-v1': {...pruna,label:'Pruna P-H3-Image Edit',mode:'edit'},
  'fasth3-v2-t2v-v1': {...fast,label:'FastVideo FastH3 t2v',mode:'t2v',inputs:0},
  'fasth3-v2-i2v-v1': {...fast,label:'FastVideo FastH3 i2v',mode:'i2v',inputs:2},
  'controlnet-sd15-pose-two-pass-v1': {...control,label:'SD 1.5 ControlNet Pose 2 Pass',mode:'pose',controls:['pose'],inputs:1,refine:true},
  'controlnet-sd15-depth-v1': {...control,label:'SD 1.5 ControlNet Depth',mode:'depth',controls:['depth'],inputs:1},
  'controlnet-sd15-depth-adapter-v1': {...control,label:'SD 1.5 Depth T2I Adapter',mode:'depth',controls:['adapter'],inputs:1},
  'controlnet-sd15-pose-scribble-v1': {...control,label:'SD 1.5 ControlNet Pose + Scribble',mode:'mixed-controlnet',controls:['pose','scribble'],inputs:2},
});

export const catalogProfile = id => Object.hasOwn(CATALOG_PROFILES,id) ? CATALOG_PROFILES[id] : null;
export const videoCatalogMode = mode => mode === 't2v' || mode === 'i2v';
export const CATALOG_INPUTS = Object.freeze({
  CheckpointLoaderSimple:['ckpt_name','checkpoint'], ControlNetLoader:['control_net_name','controlnet'],
  UNETLoader:['unet_name','diffusion'], CLIPLoader:['clip_name','text_encoder'], VAELoader:['vae_name','vae'],
});
const multiple = 32;
const limits = {dimensionMultiple:multiple,minDimension:256,maxDimension:2048,maxPixels:4_194_304,batch:1};
const videoLimits = {...limits,maxDimension:768,maxPixels:393_216,minFrames:22,maxFrames:124,frameStep:17,minFps:24,maxFps:24};
const controls={
  pose:['sd15/control_v11p_sd15_openpose_fp16.safetensors',0.9],
  depth:['sd15/control_v11f1p_sd15_depth_fp16.safetensors',0.9],
  adapter:['sd15/t2iadapter_depth_sd15v2.pth',1],
  scribble:['sd15/control_v11p_sd15_scribble_fp16.safetensors',0.75],
};
const models={
  h3:['minimax-h3-image/minimax_h3_image_pruned_w4a8.safetensors','minimax-h3/qwen3vl_32b_minimax_h3_int8_convrot.safetensors','minimax-h3-image/minimax_h3_image_vae_fp16.safetensors'],
  pruna:['p-h3-image/p-h3-image_w4a8.safetensors','p-h3-image/p-h3-image_text_encoder_w4a8.safetensors','p-h3-image/p-h3-image_vae_int8_convrot.safetensors'],
  fast:['fastvideo-fasth3/fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors','minimax-h3/qwen3vl_32b_minimax_h3_int8_convrot.safetensors','minimax-h3/minimax_h3_video_vae_int8_convrot.safetensors'],
};
const fail = message => { throw new Error(message); };
const node = (class_type,inputs) => ({class_type,inputs});
const slot = (name,n=0) => [name,n];
const text = (v,max) => typeof v==='string' && v.length<=max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v);
const localName = value => String(value).replaceAll('\\','/');

export function catalogLimits(id) {
  const p = catalogProfile(id);
  return {...(p.family==='fast'?videoLimits:limits),...(p.refine?{dimensionMultiple:64}:{}),maxSteps:p.family==='control'?40:p.steps,
    minGeneratorInputs:p.mode==='i2v'?1:p.inputs,maxGeneratorInputs:p.inputs};
}

export function catalogDefaultGraph(id) {
  const p=catalogProfile(id);
  const inputAssets=Array.from({length:p.inputs},(_,i)=>({
    comfyInputName:`controller-assets/${'a'.repeat(24)}/11111111-1111-4111-8111-11111111111${i}-${'a'.repeat(64)}.png`,
  }));
  return buildCatalogGraph({modelProfile:id,mode:p.mode,prompt:'Catalog schema check',inputAssets}).graph;
}

export function buildCatalogGraph(request,{prefix='controller/template/image',installed}={}) {
  const {modelProfile, mode, width=512, height=512, prompt, negativePrompt='', seed='42', inputAssets=[]}=request;
  const p=catalogProfile(modelProfile);
  if(!p||mode!==p.mode)fail('Requested catalog profile and operation differ');
  if(!text(prompt,6000)||!prompt.trim()||!text(negativePrompt,3000))fail('Invalid prompt');
  if(negativePrompt && p.family!=='control')fail('This workflow does not use negative conditioning');
  if(typeof seed!=='string'||!/^(?:0|[1-9]\d{0,15})$/u.test(seed)||BigInt(seed)>BigInt(Number.MAX_SAFE_INTEGER))fail('Invalid seed');
  const steps=request.steps??p.steps, range=catalogLimits(modelProfile);
  if(!Number.isSafeInteger(steps)||steps<1||steps>range.maxSteps||(p.family!=='control'&&steps!==p.steps))fail('Unsupported step count');
  if(![width,height].every(n=>Number.isSafeInteger(n)&&n>=range.minDimension&&n<=range.maxDimension&&n%range.dimensionMultiple===0)||width*height>range.maxPixels)fail('Unsupported catalog canvas dimensions');
  if(!Array.isArray(inputAssets)||inputAssets.length<range.minGeneratorInputs||inputAssets.length>range.maxGeneratorInputs||
    !inputAssets.every(a=>/^controller-assets\/[a-f0-9]{24}\/[a-f0-9-]{36}-[a-f0-9]{64}\.png$/.test(a?.comfyInputName??'')))fail('Ordered owned generator inputs are required');
  const video=p.family==='fast',frames=request.frames??22,fps=request.fps??24;
  if(video&&(!Number.isSafeInteger(frames)||frames<range.minFrames||frames>range.maxFrames||(frames-5)%17||fps!==24))fail('Use 22–124 frames on the 17n+5 grid at 24 fps');
  if(!video&&(request.frames!==undefined||request.fps!==undefined))fail('Frame settings require a video workflow');
  if(!/^controller\/(?:template|[a-f0-9-]{36}\/[a-f0-9-]{36})\/(?:image|video)$/.test(prefix))fail('Invalid controller-owned prefix');
  const graph={},add=(name,type,inputs)=>{graph[name]=node(type,inputs);return slot(name);};
  const available=(type,input,name)=>{
    if(!installed)return name;
    const d=installed[type]?.input?.required?.[input];
    const choices=Array.isArray(d?.[0])?d[0]:d?.[1]?.options;
    return choices?.find(choice=>localName(choice)===name)??name;
  };
  const loader=(name,type,input,value,extra={})=>add(name,type,{[input]:available(type,input,value),...extra});
  const images=inputAssets.map((asset,i)=>add(`input${i+1}`,'LoadImage',{image:asset.comfyInputName}));
  let output={width,height};
  let samples, vae;
  if(p.family==='control'){
    const ckpt=loader('checkpoint','CheckpointLoaderSimple','ckpt_name','sd15/v1-5-pruned-emaonly-fp16.safetensors');
    const model=ckpt,clip=slot('checkpoint',1);
    vae=slot('checkpoint',2);
    const textPos=add('positive','CLIPTextEncode',{clip,text:prompt}),textNeg=add('negative','CLIPTextEncode',{clip,text:negativePrompt});
    let positive=textPos,negative=textNeg;
    for(const [i,kind] of p.controls.entries()){
      const [weight,strength]=controls[kind],id=`control${i+1}`;
      const control_net=loader(`${id}Weights`,'ControlNetLoader','control_net_name',weight);
      positive=add(id,'ControlNetApplyAdvanced',{positive,negative,control_net,image:images[i],strength,start_percent:0,end_percent:1,vae});
      negative=slot(id,1);
    }
    const latent_image=add('latent','EmptyLatentImage',{width,height,batch_size:1});
    const sampler={model,seed:Number(seed),steps,cfg:7,sampler_name:'euler',scheduler:'normal'};
    samples=add('sampler','KSampler',{...sampler,positive,negative,latent_image,denoise:1});
    if(p.refine){
      for(const key of ['width','height'])graph.latent.inputs[key]=Math.max(128,Math.round(graph.latent.inputs[key]*2/96)*32);
      const upscale=add('refineSize','LatentUpscale',{samples,upscale_method:'nearest-exact',width,height,crop:'disabled'});
      samples=add('refine','KSampler',{...sampler,steps:Math.max(1,Math.round(steps/2)),positive:textPos,negative:textNeg,latent_image:upscale,denoise:0.45});
    }
  }else{
    const [unetName,clipName,vaeName]=models[p.family];
    let model=loader('unet','UNETLoader','unet_name',unetName,{weight_dtype:'default'});
    const clip=loader('clip','CLIPLoader','clip_name',clipName,{type:'minimax',device:'default'});
    vae=loader('vae','VAELoader','vae_name',vaeName);
    const common={clip,vae,prompt,width,height};
    if(!video)for(const [i,image] of images.entries())common[`images.image_${i+1}`]=image;
    if(video){
      common.length=frames;
      if(images[0])common.first_frame=images[0];
      if(images[1])common.last_frame=images[1];
    }
    const conditioning=add('conditioning',video?'MiniMaxH3ImageToVideo':p.family==='pruna'?'PH3ImageConditioning':'MiniMaxH3ImageConditioning',common);
    const latent_image=slot('conditioning',1);
    if(p.family==='h3'){
      const negative=add('negative','ConditioningZeroOut',{conditioning});
      samples=add('sampler','KSampler',{model,positive:conditioning,negative,latent_image,seed:Number(seed),steps,cfg:1,sampler_name:'euler',scheduler:'simple',denoise:1});
    }else{
      model=add('shift','MiniMaxH3SigmaShift',{model,shift_video:video?10:1,shift_audio:video?3:1});
      const sigmas=video?add('schedule','BasicScheduler',{model,scheduler:'simple',steps,denoise:1})
        :add('schedule','ManualSigmas',{sigmas:'1.0, 0.984753, 0.967905, 0.951688, 0.925372, 0.881923, 0.810083, 0.528718, 0.0'});
      const noise=add('noise','RandomNoise',{noise_seed:Number(seed)}),guider=add('guider','BasicGuider',{model,conditioning});
      const sampler=add('samplerSelect','KSamplerSelect',{sampler_name:video?'res_multistep':'euler'});
      samples=add('sampler','SamplerCustomAdvanced',{noise,guider,sampler,sigmas,latent_image});
    }
  }
  const decoded=add('decode','VAEDecode',{samples,vae});
  if(video){
    const audioVae=loader('audioVae','VAELoader','vae_name','minimax-h3/minimax_h3_audio_vae_fp32.safetensors');
    const audio=add('audio','VAEDecodeAudio',{samples,vae:audioVae});
    const stream=add('video','CreateVideo',{images:decoded,audio,fps});
    add('save','SaveVideo',{video:stream,filename_prefix:prefix,format:'mp4','format.codec':'h264','format.codec.encoding':'auto'});
    output={...output,frames,fps,audio:true};
  }else add('save','SaveImage',{images:decoded,filename_prefix:prefix});
  return {graph,output,parameters:{prompt,negativePrompt,seed,width,height,steps,...(video?{frames,fps}:{})}};
}

export function catalogModels(graph) {
  return Object.values(graph).flatMap(({class_type:nodeType,inputs})=>{
    const loader=CATALOG_INPUTS[nodeType];
    if(!loader)return [];
    const [input,role]=loader;
    return [{role,nodeType,input,name:inputs[input]}];
  });
}

export function validateCatalogSchemas(graph,objects) {
  for(const {class_type,inputs} of Object.values(graph)){
    const schema=objects[class_type];
    if(!schema||schema.api_node||schema.dev_only)fail(`Unavailable local node: ${class_type}`);
    const required=schema.input?.required??{},optional=schema.input?.optional??{};
    for(const name of Object.keys(required))if(!Object.hasOwn(inputs,name))fail(`Missing required input: ${class_type}.${name}`);
    for(const [name,value] of Object.entries(inputs)){
      const [field,child]=name.split('.');
      const definition=required[field]??optional[field], kind=definition?.[0];
      if(child&&kind==='COMFY_DYNAMICCOMBO_V3')continue;
      const connection=Array.isArray(value);
      if(child&&kind==='COMFY_AUTOGROW_V3'){
        const t=definition[1].template;
        if(!connection||objects[graph[value[0]]?.class_type]?.output?.[value[1]]!=='IMAGE'||
          !(t.names?.includes(child)||child.startsWith(t.prefix??'images-missing')))fail(`Invalid image connection: ${class_type}.${name}`);
        continue;
      }
      const choices=Array.isArray(kind)?kind:kind==='COMBO'?definition[1].options:null;
      const range=definition?.[1]??{};
      if(!definition||(connection ? objects[graph[value[0]]?.class_type]?.output?.[value[1]]!==kind :
        choices ? !choices.includes(value) && !(class_type==='LoadImage'&&name==='image'&&value.startsWith('controller-assets/')) :
        kind==='STRING' ? typeof value!=='string' :
        ['INT','FLOAT'].includes(kind) ? typeof value!=='number'||!Number.isFinite(value)||kind==='INT'&&!Number.isSafeInteger(value)||
          range.min!==undefined&&value<range.min||range.max!==undefined&&value>range.max :
        kind==='COMFY_DYNAMICCOMBO_V3' ? !range.options?.some(option=>option.key===value) : true))fail(`Invalid installed input: ${class_type}.${name}`);
    }
  }
}

export function validateCatalogGraph(graph,request,options={}) {
  const expected=buildCatalogGraph(request,options);
  // Model lists on Windows use backslashes. Compare canonically when reading
  // previous drafts while still using the installed selector on submission.
  const canonical=input=>Object.fromEntries(Object.entries(input).map(([id,value])=>{
    const inputName=CATALOG_INPUTS[value.class_type]?.[0];
    return [id,inputName?{...value,inputs:{...value.inputs,[inputName]:localName(value.inputs[inputName])}}:value];
  }));
  if(!isDeepStrictEqual(canonical(graph),canonical(expected.graph)))fail('Catalog workflow differs from the approved graph');
  if(options.installed)validateCatalogSchemas(expected.graph,options.installed);
  return expected;
}
