// Minimal session-scoped projection; prompts, image metadata, and other
// conversations remain in the existing authenticated controller records.
const terminal=new Set(['completed','failed','cancelled']);
const safeString=(value,limit=120)=>typeof value==='string'&&value.length<=limit&&!/[\x00-\x1f]/.test(value)?value:null;
const date=value=>typeof value==='string'&&!Number.isNaN(Date.parse(value))?value:null;
function projectRun(run){
  if(!run)return null;
  return {id:safeString(run.id),phase:safeString(run.phase),createdAt:date(run.createdAt),updatedAt:date(run.updatedAt),
    queueState:['pending','running','checking'].includes(run.progress?.state)?run.progress.state:null,
    submittedAt:date(run.submittedAt),kind:['moss-pe','qwen-pe'].includes(run.kind)?run.kind:'generation'};
}
function productionPhase(p,run){
  if(p.cancelRequested&&(!run||terminal.has(run.phase)))return 'cancelled';
  if(!p.cancelRequested&&p.phase==='generating'&&run&&terminal.has(run.phase))return run.phase==='completed'?'awaiting_evaluation':'needs_user';
  return safeString(p.phase);
}
export async function monitorSnapshot({sessionId,store,productions,gate,inferenceScope,telemetry,progress,clock=()=>new Date()}={}){
  if(typeof sessionId!=='string'||!sessionId||!store||!productions)throw new TypeError('Session and stores required');
  const records=productions.list(sessionId).filter(p=>p.sessionId===sessionId),runs=store.list().filter(r=>r.sessionId===sessionId),byId=new Map(runs.map(r=>[r.id,r]));
  const jobs=records.map(p=>{const run=byId.get(p.latestRunId);return {
    id:safeString(p.id),phase:productionPhase(p,run),revision:p.revision,createdAt:date(p.createdAt),updatedAt:date(p.updatedAt),
    model:safeString(p.brief?.modelProfile),mode:safeString(p.brief?.mode),run:projectRun(run),
    attempts:Array.isArray(p.attempts)?p.attempts.length:0,evaluations:Array.isArray(p.evaluations)?p.evaluations.length:0,
    latestUserDecision:p.latestUserDecision&&run&&p.latestUserDecision.sourceRunId===run.id&&p.latestUserDecision.productionRevision===p.revision?{decision:safeString(p.latestUserDecision.decision),sourceRunId:safeString(p.latestUserDecision.sourceRunId),productionRevision:p.latestUserDecision.productionRevision,at:date(p.latestUserDecision.at),planningRequestId:safeString(p.latestUserDecision.planningRequestId),planningState:safeString(p.latestUserDecision.planningDelivery?.state)}:null,
    confirmation:(()=>{const e=p.evaluations?.find(e=>e.runId===p.latestRunId);return !p.cancelRequested&&['completed','needs_user'].includes(p.phase)&&run?.phase==='completed'&&e&&run.artifacts?.some(a=>a.sha256===e.artifactSha256)&&p.latestUserDecision?.sourceRunId!==run.id?{runId:run.id,artifactSha256:e.artifactSha256}:null;})(),
  };});
  for(const run of runs){
    if(!['moss-pe','qwen-pe'].includes(run.kind))continue;
    if(run.productionId&&!records.some(p=>p.id===run.productionId))continue;
    jobs.push({id:safeString(run.id),phase:safeString(run.phase),createdAt:date(run.createdAt),updatedAt:date(run.updatedAt),model:run.kind,mode:'prompt-enhancement',run:projectRun(run),attempts:1,evaluations:0});
  }
  jobs.sort((a,b)=>Date.parse(b.updatedAt??b.createdAt??0)-Date.parse(a.updatedAt??a.createdAt??0));
  const gateValue=gate?.status?.()??null;
  const lease=gateValue?{owner:safeString(gateValue.owner),blocked:gateValue.blocked===true,initialized:gateValue.initialized===true}:null;
  let resources=null;try{resources=typeof telemetry==='function'?await telemetry():null;}catch{}
  let nodeProgress=null;try{nodeProgress=await progress?.snapshot?.(sessionId)??null;}catch{}
  return {observedAt:clock().toISOString(),lease,resources,jobs:jobs.slice(0,30),
    conversationInference:inferenceScope?.sessionId===sessionId?{active:true,startedAt:date(inferenceScope.createdAt)}:{active:false,startedAt:null},
    nodeProgress};
}
