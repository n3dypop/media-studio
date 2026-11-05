import {UPSCALE_PROFILE,RESIZE_PROFILE,assertInputBinding,comboChoices} from './media-modes.mjs';
export const UPSCALE_NODE_TYPES=['LoadImage','ImageScale','SaveImage','UpscaleModelLoader','ImageUpscaleWithModel'];
export function upscaleModels(graph,profile) {
  if(profile===RESIZE_PROFILE)return [];
  const loader=Object.values(graph).find(node=>node.class_type==='UpscaleModelLoader');
  if(!loader||loader.inputs?.model_name!=='RealESRGAN_x4plus.pth')throw new Error('The approved RealESRGAN model is required');
  return [{role:'upscale',nodeType:'UpscaleModelLoader',input:'model_name',name:loader.inputs.model_name,qualification:'runtime-validation-required'}];
}
export function upscaleTemplate(profile,binding) {
  assertInputBinding(binding);
  const graph={inputImage:{class_type:'LoadImage',inputs:{image:binding.comfyInputName}},resize:{class_type:'ImageScale',inputs:{image:['inputImage',0],upscale_method:'lanczos',width:1024,height:1024,crop:'disabled'}},save:{class_type:'SaveImage',inputs:{images:['resize',0],filename_prefix:'controller/template/image'}}};
  if(profile===UPSCALE_PROFILE){graph.upscaleModel={class_type:'UpscaleModelLoader',inputs:{model_name:'RealESRGAN_x4plus.pth'}};graph.upscale={class_type:'ImageUpscaleWithModel',inputs:{upscale_model:['upscaleModel',0],image:['inputImage',0]}};graph.resize.inputs.image=['upscale',0];}
  else if(profile!==RESIZE_PROFILE)throw new Error('Unknown image enlargement profile');
  return graph;
}
export function validateUpscaleGraph(input,{objects,modelProfile,assetBinding,normalize=true,hash}) {
  assertInputBinding(assetBinding);const graph=structuredClone(input),types=modelProfile===UPSCALE_PROFILE?UPSCALE_NODE_TYPES:UPSCALE_NODE_TYPES.slice(0,3);
  if(!graph||Object.keys(graph).length!==types.length)throw new Error('Unexpected upscale graph size');
  const byType=new Map();
  for(const [id,node]of Object.entries(graph)) {
    if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)||!types.includes(node?.class_type)||byType.has(node.class_type)||!node.inputs||Object.keys(node).some(k=>!['class_type','inputs','_meta'].includes(k)))throw new Error('Unsupported upscale node');
    const schema=objects?.[node.class_type];if(!schema||schema.api_node||schema.dev_only||(schema.output_node&&node.class_type!=='SaveImage'))throw new Error('Upscale node unavailable or unsafe');
    byType.set(node.class_type,id);delete node._meta;
  }
  const load=byType.get('LoadImage'),resize=byType.get('ImageScale'),save=byType.get('SaveImage'),model=byType.get('UpscaleModelLoader'),upscale=byType.get('ImageUpscaleWithModel');
  const exact=(id,expected)=>{if(JSON.stringify(Object.keys(graph[id].inputs).sort())!==JSON.stringify(Object.keys(expected).sort())||Object.entries(expected).some(([key,value])=>JSON.stringify(graph[id].inputs[key])!==JSON.stringify(value)))throw new Error('Unsupported upscale connection or input');};
  exact(load,{image:assetBinding.comfyInputName});
  if(model){exact(model,{model_name:'RealESRGAN_x4plus.pth'});exact(upscale,{upscale_model:[model,0],image:[load,0]});if(!comboChoices(objects.UpscaleModelLoader.input.required.model_name)?.includes('RealESRGAN_x4plus.pth'))throw new Error('RealESRGAN model is not installed');if(assetBinding.width*assetBinding.height>1_500_000||Math.max(assetBinding.width,assetBinding.height)>1536)throw new Error('AI upscale input exceeds its bounded resource profile');}
  const scale=graph[resize].inputs;
  exact(resize,{image:[upscale??load,0],upscale_method:scale.upscale_method,width:scale.width,height:scale.height,crop:'disabled'});
  if(!comboChoices(objects.ImageScale.input.required.upscale_method)?.includes(scale.upscale_method)||![scale.width,scale.height].every(n=>Number.isSafeInteger(n)&&n>=64&&n<=4096)||scale.width*scale.height>8_388_608)throw new Error('Image enlargement output exceeds bounds');
  if(normalize)graph[save].inputs.filename_prefix='controller/template/image';
  exact(save,{images:[resize,0],filename_prefix:graph[save].inputs.filename_prefix});
  if(typeof graph[save].inputs.filename_prefix!=='string'||graph[save].inputs.filename_prefix.length>240)throw new Error('Invalid save prefix');
  return {graph,roles:{load,resize,save},modelProfile,mode:'upscale',sha256:hash(graph),nodeCount:types.length,output:{width:scale.width,height:scale.height,batch:1,mime:'image/png'}};
}
