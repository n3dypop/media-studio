export const UPSCALE_PROFILE='realesrgan-x4plus-v1';
export const RESIZE_PROFILE='image-scale-v1';
export const VIDEO_PROFILE_ID='wan22-ti2v-5b-v1';
export const H3_PROFILE_ID='minimax-h3-ref2va-v1';
// Historical IDs are retained solely to read existing production records.
// Adding a future video profile requires an explicit new integration.
export const RETIRED_VIDEO_PROFILES=Object.freeze([VIDEO_PROFILE_ID,H3_PROFILE_ID]);
export function assertActiveProfile(modelProfile) {
  if(RETIRED_VIDEO_PROFILES.includes(modelProfile)) {
    const error=new Error('指定モデルはこの環境から撤去されました。動画生成には別途モデルの導入と検証が必要です。');
    error.status=409; throw error;
  }
}
export const MOSS_OFFICIAL_IDS=Object.freeze(['moss-image-sft-official-v1','moss-image-base-official-v1']);
export const QWEN21_OFFICIAL_IDS=Object.freeze(['qwen-image-2.1-base-v1','qwen-image-2.1-turbo-v1']);
// The packaged official UI workflow exposes 10 image sockets. The installed
// native TextEncodeQwenImage21 schema exposes up to 16; 11–16 are an explicit
// Controller-built node extension, subject to live schema and resource checks.
export const QWEN21_MAX_INPUTS=16;
export const MEDIA_MODES=Object.freeze(['t2i','i2i','edit','background-removal','layout','depth','upscale','video']);
export const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail=message=>{const error=new Error(message);error.status=400;throw error;};
export function mediaIntent(input={},defaultMode='t2i') {
  const mode=input.mode??defaultMode,inputAssetId=input.inputAssetId??null,referenceAssetIds=input.referenceAssetIds??[];
  if(!MEDIA_MODES.includes(mode)||!Array.isArray(referenceAssetIds)||referenceAssetIds.length>8||referenceAssetIds.some(id=>!UUID.test(id))||new Set(referenceAssetIds).size!==referenceAssetIds.length)fail('制作モードまたは参照画像IDが不正です。');
  if(inputAssetId!==null&&!UUID.test(inputAssetId))fail('入力画像IDが不正です。');
  const moss=MOSS_OFFICIAL_IDS.includes(input.modelProfile),qwen=QWEN21_OFFICIAL_IDS.includes(input.modelProfile),ids=input.inputAssetIds;
  if(ids!==undefined&&(!(moss||qwen)||!Array.isArray(ids)||ids.length>(qwen?QWEN21_MAX_INPUTS:6)||ids.some(id=>!UUID.test(id))||new Set(ids).size!==ids.length))fail('生成入力画像の順序付きIDが不正です。');
  if(ids!==undefined&&inputAssetId!==null&&ids[0]!==inputAssetId)fail('単一入力と順序付き入力が一致しません。');
  const inputIds=ids??(inputAssetId?[inputAssetId]:[]);
  if(['i2i','edit','background-removal','upscale','depth'].includes(mode)&&inputIds.length===0)fail('この制作モードにはinput用途の画像が必要です。');
  if(mode==='t2i'&&inputIds.length&&!moss)fail('t2iでは画像をlatentへ入力しません。参照用途を使用するかi2iを選択してください。');
  if(referenceAssetIds.some(id=>inputIds.includes(id)))fail('同じ登録画像を入力と参照の両方に指定できません。用途を明示して別登録してください。');
  return {mode,inputAssetId,referenceAssetIds:[...referenceAssetIds],...(ids!==undefined?{inputAssetIds:[...ids]}:{})};
}
export function assertModeProfile(mode,modelProfile) {
  if(mode==='upscale'&&![UPSCALE_PROFILE,RESIZE_PROFILE].includes(modelProfile))fail('拡大はAIアップスケールまたは通常リサイズのモデルプロファイルを指定してください。');
  if(mode==='video'&&![VIDEO_PROFILE_ID,H3_PROFILE_ID].includes(modelProfile))fail('動画に対応したモデルプロファイルが必要です。');
  if(['i2i','edit'].includes(mode)&&modelProfile!=='moss-image-sft-int8-v1'&&!(mode==='edit'&&[...MOSS_OFFICIAL_IDS,...QWEN21_OFFICIAL_IDS].includes(modelProfile)))fail('画像入力・編集は対応する画像プロファイルを指定してください。');
  if(mode==='background-removal'&&!QWEN21_OFFICIAL_IDS.includes(modelProfile))fail('背景削除には対応するQwen公式プロファイルが必要です。');
  if(QWEN21_OFFICIAL_IDS.includes(modelProfile)&&!['t2i','edit','background-removal'].includes(mode))fail('Qwen公式プロファイルと制作モードが一致しません。');
  if(['layout','depth'].includes(mode)&&!MOSS_OFFICIAL_IDS.includes(modelProfile))fail('指定した制作モードに対応するモデルプロファイルが必要です。');
  if(MOSS_OFFICIAL_IDS.includes(modelProfile)&&!['t2i','layout','edit','depth'].includes(mode))fail('MOSS公式プロファイルと制作モードが一致しません。');
  if(!['upscale','video'].includes(mode)&&[UPSCALE_PROFILE,RESIZE_PROFILE,VIDEO_PROFILE_ID,H3_PROFILE_ID].includes(modelProfile))fail('モデルと制作モードが一致しません。');
}
export function assertInputBinding(binding) {
  if(!binding||!UUID.test(binding.id??'')||binding.purpose!=='input'||!/^[a-f0-9]{64}$/.test(binding.sha256??'')||![binding.width,binding.height].every(n=>Number.isSafeInteger(n)&&n>=16&&n<=4096)||binding.width*binding.height>12_000_000||typeof binding.comfyInputName!=='string'||!new RegExp(`^controller-assets/[a-f0-9]{24}/${binding.id}-${binding.sha256}\\.png$`).test(binding.comfyInputName))throw new Error('An immutable owned input asset binding is required');
  return binding;
}
export const comboChoices=definition=>Array.isArray(definition?.[0])?definition[0]:definition?.[0]==='COMBO'?definition[1]?.options:null;

export function mossInputTemplate(base,mode,binding) {
  if(mode==='t2i')return structuredClone(base);
  if(!['i2i','edit'].includes(mode))throw new Error('Unsupported MOSS image mode');
  assertInputBinding(binding);const graph=structuredClone(base),latent=Object.keys(graph).find(id=>graph[id].class_type==='EmptyFlux2LatentImage');
  if(!latent)throw new Error('MOSS template lacks its latent source');
  graph.inputImage={class_type:'LoadImage',inputs:{image:binding.comfyInputName}};
  graph.inputScale={class_type:'ImageScale',inputs:{image:['inputImage',0],upscale_method:'lanczos',width:768,height:1024,crop:'disabled'}};
  graph[latent]={class_type:'VAEEncode',inputs:{pixels:['inputScale',0],vae:['6',0]}};
  graph['3'].inputs.denoise=0.65;return graph;
}
