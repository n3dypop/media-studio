// Deliberately closed vocabulary: never persist arbitrary exception text,
// prompt values, asset names, paths, model filenames or graph data here.
const CODES=new Set(['COMFY_QUEUE_BUSY','NODE_MISSING','NODE_UNSAFE','MODEL_UNAVAILABLE','WORKFLOW_PARAMETER_MISMATCH','WORKFLOW_CONTRACT_MISMATCH','WORKFLOW_SCHEMA_MISMATCH','WORKFLOW_VALIDATION_FAILED','ASSET_VERIFICATION_FAILED','COMFY_STATE_UNAVAILABLE','RESOURCE_OBSERVATION_UNAVAILABLE','PROFILE_UNAVAILABLE','SERVER_IDENTITY_UNAVAILABLE','PREFLIGHT_UNAVAILABLE']);
const FIELDS=new Set(['prompt','negativePrompt','width','height','seed','steps','mode','modelProfile','inputAssets','output']);
const ROLES=new Set(['diffusion','text_encoder','vae','lora','geometry_estimator']);
const STAGES=new Set(['initial','after-core-release']);
export function safePreflightIssue(input){
  if(!input||!CODES.has(input.code))return null;
  const issue={code:input.code};
  if(FIELDS.has(input.field))issue.field=input.field;
  if(ROLES.has(input.role))issue.role=input.role;
  if(Number.isSafeInteger(input.count)&&input.count>=0&&input.count<=1000)issue.count=input.count;
  return issue;
}
export function preflightDiagnostic({stage='initial',result=null,error=null}={}){
  const issues=[];
  if(result?.queueEmpty===false)issues.push({code:'COMFY_QUEUE_BUSY'});
  for(const item of Array.isArray(result?.diagnostics)?result.diagnostics:[]){const safe=safePreflightIssue(item);if(safe)issues.push(safe);}
  if(error){const safe=safePreflightIssue({code:error.preflightCode,field:error.preflightField,role:error.preflightRole});issues.push(safe??{code:'PREFLIGHT_UNAVAILABLE'});}
  if(!issues.length)issues.push({code:'PREFLIGHT_UNAVAILABLE'});
  const unique=[...new Map(issues.map(item=>[JSON.stringify(item),item])).values()].slice(0,20);
  return {version:1,stage:STAGES.has(stage)?stage:'initial',issues:unique};
}
const messages={COMFY_QUEUE_BUSY:'ComfyUIに別の処理があります。',NODE_MISSING:'必要なノードを確認できません。',NODE_UNSAFE:'許可されないノードが含まれています。',MODEL_UNAVAILABLE:'必要なモデルを確認できません。',WORKFLOW_PARAMETER_MISMATCH:'制作の生成設定とワークフローの設定が一致しません。',WORKFLOW_CONTRACT_MISMATCH:'ワークフローと制作の紐付けが一致しません。',WORKFLOW_SCHEMA_MISMATCH:'ワークフローと現在のノード仕様が一致しません。',WORKFLOW_VALIDATION_FAILED:'ワークフローの検証を完了できません。',ASSET_VERIFICATION_FAILED:'制作に紐付く入力画像を検証できません。',COMFY_STATE_UNAVAILABLE:'ComfyUIの状態を確認できません。',RESOURCE_OBSERVATION_UNAVAILABLE:'GPU資源の観測値を確認できません。',PROFILE_UNAVAILABLE:'指定されたモデル構成を確認できません。',SERVER_IDENTITY_UNAVAILABLE:'ComfyUIのプロセスを照合できません。',PREFLIGHT_UNAVAILABLE:'実行前の検証を完了できません。'};
export function preflightSummary(diagnostic){return [...new Set((diagnostic?.issues??[]).map(issue=>messages[issue.code]).filter(Boolean))].join(' ')||messages.PREFLIGHT_UNAVAILABLE;}
export function makePreflightError(code,field){const error=new Error('Preflight check failed');error.preflightCode=code;if(field)error.preflightField=field;return error;}
