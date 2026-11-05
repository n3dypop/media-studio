// A DSH-facing, closed-vocabulary projection of controller preflight records.
// Never forward exception strings, paths, asset names, prompt contents or graph.
const ACTIONS=Object.freeze({
  COMFY_QUEUE_BUSY:'Wait until the other ComfyUI job is finished and inspect the recorded run; do not stop unrelated work.',
  NODE_MISSING:'Ask the user or maintenance agent to inspect the installed workflow nodes and their compatibility.',
  NODE_UNSAFE:'Ask the maintenance agent to inspect the workflow; external and development-only nodes are not authorized.',
  MODEL_UNAVAILABLE:'Ask the user or maintenance agent to inspect the specified model installation and registration; do not substitute another model.',
  WORKFLOW_PARAMETER_MISMATCH:'Compare the named field in the saved draft and render request; create or select a corrected draft before another run.',
  WORKFLOW_CONTRACT_MISMATCH:'Inspect the fixed workflow, production mode and owned input bindings; do not replace or guess them.',
  WORKFLOW_SCHEMA_MISMATCH:'Ask the maintenance agent to inspect the workflow against the current installed ComfyUI node schemas.',
  WORKFLOW_VALIDATION_FAILED:'Inspect the workflow with the maintenance agent; no specific missing model or node has been established.',
  ASSET_VERIFICATION_FAILED:'Inspect ownership and integrity of the registered generator input; do not substitute a reference or local path.',
  COMFY_STATE_UNAVAILABLE:'Inspect the local ComfyUI connection and state; no model or node failure has been established.',
  RESOURCE_OBSERVATION_UNAVAILABLE:'Inspect GPU resource observation; no model or node failure has been established.',
  PROFILE_UNAVAILABLE:'Ask the maintenance agent to inspect the selected model profile registration.',
  SERVER_IDENTITY_UNAVAILABLE:'Inspect ComfyUI server identity; do not send a job until the controller can verify it.',
  PREFLIGHT_UNAVAILABLE:'Ask the maintenance agent to inspect the preflight; the cause is not established.',
});
const FIELDS=new Set(['prompt','negativePrompt','width','height','seed','steps','mode','modelProfile','inputAssets','output']);
const ROLES=new Set(['diffusion','text_encoder','vae','lora','geometry_estimator']);
export function dshPreflightDiagnostic(record){
  if(!record||record.version!==1||!['initial','after-core-release'].includes(record.stage)||!Array.isArray(record.issues)||record.issues.length>20)return null;
  const issues=[];for(const issue of record.issues){if(!issue||!Object.hasOwn(ACTIONS,issue.code))continue;const item={code:issue.code,action:ACTIONS[issue.code]};if(FIELDS.has(issue.field))item.field=issue.field;if(ROLES.has(issue.role))item.role=issue.role;if(Number.isSafeInteger(issue.count)&&issue.count>=0&&issue.count<=1000)item.count=issue.count;issues.push(item);}
  return issues.length?{version:1,stage:record.stage,issues,note:'Only classified, bounded evidence is shown. Do not infer missing models, retry automatically, or claim a job ran.'}:null;
}
