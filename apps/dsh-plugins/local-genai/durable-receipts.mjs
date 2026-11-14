// Evidence checks for the durable-mutation integration under development.
// These functions are read-only and are not by themselves permission to clear
// a pending journal entry: delivery must also be bound and durably confirmed.
import {createHash} from 'node:crypto';
import {preparedWorkflowVersions,preparedParameters} from '../../controller/media-modes.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const digest=value=>sha(JSON.stringify(value));
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const hash=/^[a-f0-9]{64}$/;
const id=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const canonicalTime=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const fail=()=>{throw new Error('Controller receipt does not prove the owned request; leave it unresolved.');};
function base(intent,operation,sessionId){
  if(!intent||intent.operation!==operation||intent.sessionId!==sessionId||typeof sessionId!=='string'||!sessionId||!id.test(intent.requestId??'')||!hash.test(intent.inputHash??''))fail();
}
function ownedProduction(p,sessionId){
  if(!p||!id.test(p.id??'')||p.sessionId!==sessionId||!Number.isSafeInteger(p.revision)||p.revision<0||!p.brief||!hash.test(p.briefHash??'')||digest(p.brief)!==p.briefHash)fail();
}
function ownedWorkflow(w,p){
  if(!w||!id.test(w.id??'')||w.productionId!==p.id||!hash.test(w.sha256??'')||!w.graph||digest(stable(w.graph))!==w.sha256||w.modelProfile!==p.brief.modelProfile||(w.mode??'t2i')!==(p.brief.mode??'t2i'))fail();
}
// A read endpoint must itself authenticate and validate this persisted
// cancellation receipt against the event ledger in one DB snapshot. A bare
// current revision or cancel flag is not evidence of the intervening change.
function revisionAfterOnlyCancellation(p,expected,receipt){
  if(p.revision===expected&&p.cancelRequested===false)return true;
  return Boolean(p.cancelRequested===true&&p.revision===expected+1&&receipt&&receipt.sessionId===p.sessionId&&receipt.productionId===p.id&&id.test(receipt.requestId??'')&&['cancel','cancel-owned'].includes(receipt.operation)&&hash.test(receipt.payloadHash??'')&&receipt.disposition==='accepted'&&receipt.previousRevision===expected&&receipt.productionRevision===expected+1&&typeof receipt.acceptedAt==='string'&&typeof receipt.cancelRequestedAt==='string'&&receipt.cancelRequestedAt===p.cancelRequestedAt);
}
function resultProof(value){return {outcome:'applied',receiptHash:digest(value)};}

// A route-specific Controller transaction must have fenced the exact request
// before this common rejected-before-admission receipt may be used.
export function verifyAdmissionRejection(intent,sessionId,value){
  if(!['create','asset-import','render','prepared-render','cancel','evaluate','iteration','feedback'].includes(intent?.operation)&&!/^(moss|qwen)-pe-(start|decision|reconcile)$/.test(intent?.operation??''))fail();base(intent,intent.operation,sessionId);const r=value?.receipt;
  if(!value||Object.keys(value).join(',')!=='receipt'||!r||Object.keys(r).sort().join(',')!=='httpStatus,operation,payloadHash,reason,recordedAt,requestId,sessionId,state,targetId'||r.operation!==intent.operation||r.sessionId!==sessionId||r.requestId!==intent.requestId||r.targetId!==intent.targetId||r.payloadHash!==intent.inputHash||r.state!=='rejected'||r.reason!=='rejected-before-admission'||!Number.isInteger(r.httpStatus)||r.httpStatus<400||r.httpStatus>499||!canonicalTime(r.recordedAt))fail();
  return {outcome:'rejected',receiptHash:digest(value)};
}

// A create correlation hash must be derived before sending from the same
// canonical brief contract as Controller, with an explicitly specified model.
export function verifyCreateReceipt(intent,sessionId,value){
  base(intent,'create',sessionId);
  const rows=value?.productions;if(!Array.isArray(rows)||rows.length!==1||!hash.test(intent.correlationHash??''))fail();
  const p=rows[0];ownedProduction(p,sessionId);
  if(intent.targetId!==null||p.requestId!==intent.requestId||p.briefHash!==intent.correlationHash||!revisionAfterOnlyCancellation(p,0,value.cancellationReceipt)||p.workflowId!==null||p.latestRunId!==null||!Array.isArray(p.attempts)||p.attempts.length!==0)fail();
  return resultProof(value);
}

// Controller's workflow-by-request endpoint supplies the durable payload and
// snapshot hashes from its transaction and the saved workflow snapshot.
export function verifyWorkflowReceipt(intent,sessionId,value){
  base(intent,'workflow-draft',sessionId);
  const status=value?.receipt;
  if(['rejected','abandoned'].includes(status?.state)){
    if(status.operation!=='workflow-draft'||status.sessionId!==sessionId||status.requestId!==intent.requestId||status.productionId!==intent.targetId||status.payloadHash!==intent.inputHash||!Number.isSafeInteger(status.expectedRevision)||status.expectedRevision<0||intent.correlationHash!==digest({expectedRevision:status.expectedRevision})||typeof status.recordedAt!=='string'||status.inputCacheMayExist!==true||status.state==='rejected'&&(status.reason!=='rejected-before-workflow-write'||!Number.isInteger(status.httpStatus)||status.httpStatus<400||status.httpStatus>499)||status.state==='abandoned'&&(status.reason!=='fenced-against-binding'||status.workflowFileMayExist!==true))fail();
    return {outcome:'rejected',receiptHash:digest(value)};
  }
  const p=value?.production,r=value?.receipt,w=value?.workflow;ownedProduction(p,sessionId);ownedWorkflow(w,p);
  if(!id.test(intent.targetId??'')||p.id!==intent.targetId||r?.requestId!==intent.requestId||r.productionId!==p.id||r.payloadHash!==intent.inputHash||!Number.isSafeInteger(r.expectedRevision)||r.expectedRevision<0||!revisionAfterOnlyCancellation(p,r.expectedRevision+1,value.cancellationReceipt)||p.workflowId!==w.id||p.workflowSha256!==w.sha256||r.workflowId!==w.id||r.workflowHash!==w.sha256||r.snapshotHash!==digest(w))fail();
  return resultProof(value);
}

// Prepared renders accept exactly three fields. Reconstruct their original
// serialized request from the independently saved run; never trust a guessed
// workflow or a merely matching request ID.
export function verifyPreparedRenderReceipt(intent,sessionId,value){
  base(intent,'prepared-render',sessionId);
  const p=value?.production,r=value?.run,s=r?.spec,w=s?.workflow,req=w?.request,out=w?.output;ownedProduction(p,sessionId);ownedWorkflow(w,p);
  const unchanged=p.cancelRequested===false&&r?.cancelRequested===false&&p.revision===r.productionRevision;
  // Cancellation increments the owning production once; a run that had
  // already terminated need not itself have a cancel flag. This observes
  // identity only and never claims process exit, cleanup or GPU release.
  const cancellationObserved=p.cancelRequested===true&&typeof r?.cancelRequested==='boolean'&&revisionAfterOnlyCancellation(p,r.productionRevision,value.cancellationReceipt);
  if(!id.test(intent.targetId??'')||p.id!==intent.targetId||!id.test(r?.id??'')||r.sessionId!==sessionId||r.productionId!==p.id||r.requestId!==intent.requestId||!Number.isSafeInteger(r.productionRevision)||r.productionRevision<1||!(unchanged||cancellationObserved)||p.latestRunId!==r.id||!Array.isArray(p.attempts)||p.attempts.at(-1)!==r.id||p.attempts.filter(id=>id===r.id).length!==1||s.assetSessionId!==sessionId||s.briefHash!==p.briefHash||s.enhancer!==false||s.modelProfile!==p.brief.modelProfile||!preparedWorkflowVersions.includes(w.schemaVersion)||p.workflowId!==w.id||p.workflowSha256!==w.sha256||!hash.test(r.specHash??'')||digest(s)!==r.specHash)fail();
  if(!req||!out||Object.entries(preparedParameters(w)).some(([key,value])=>s[key]!==value)||s.mode!==(p.brief.mode??'t2i')||s.inputAssetId!==(p.brief.inputAssetId??null)||JSON.stringify(s.invariants)!==JSON.stringify(p.brief.invariants)||JSON.stringify(w.inputAssetIds)!==JSON.stringify(p.brief.inputAssetIds??(p.brief.inputAssetId?[p.brief.inputAssetId]:[]))||!Array.isArray(s.referenceAssets)||JSON.stringify(s.referenceAssets.map(x=>x.id))!==JSON.stringify(p.brief.referenceAssetIds??[]))fail();
  if(digest({workflowId:w.id,expectedRevision:r.productionRevision-1,requestId:intent.requestId})!==intent.inputHash)fail();
  return resultProof(value);
}

// Legacy render inputs are captured in a Controller transaction receipt. The
// Controller independently verifies original and enhanced spec events.
export function verifyLegacyRenderReceipt(intent,sessionId,value){
  base(intent,'render',sessionId);
  const p=value?.production,run=value?.run,r=value?.receipt,s=run?.spec,w=s?.workflow,effective=run?.effectiveSpec??s;ownedProduction(p,sessionId);
  if(!w||!id.test(w.id??'')||w.productionId!==p.id||w.modelProfile!==p.brief.modelProfile||!w.graph||!hash.test(w.sha256??'')||digest(stable(w.graph))!==w.sha256)fail();
  if(intent.targetId!==p.id||!id.test(run?.id??'')||run.sessionId!==sessionId||run.productionId!==p.id||run.requestId!==intent.requestId||r?.requestId!==intent.requestId||r.sessionId!==sessionId||r.productionId!==p.id||r.runId!==run.id||r.payloadHash!==intent.inputHash||!hash.test(r.originalSpecHash??'')||digest(s)!==r.originalSpecHash||!Number.isSafeInteger(r.expectedRevision)||r.productionRevision!==r.expectedRevision+1||run.productionRevision!==r.productionRevision||!revisionAfterOnlyCancellation(p,r.productionRevision,value.cancellationReceipt)||p.latestRunId!==run.id||!Array.isArray(p.attempts)||p.attempts.at(-1)!==run.id||p.attempts.filter(x=>x===run.id).length!==1||p.workflowId!==w.id||p.workflowSha256!==w.sha256||r.workflowId!==w.id||r.workflowHash!==w.sha256||s.briefHash!==p.briefHash||s.assetSessionId!==sessionId||!hash.test(run.specHash??'')||digest(effective)!==run.specHash)fail();
  const effectivePresent=Object.hasOwn(run,'effectiveSpec');if(r.effectiveSpecPresent!==effectivePresent||r.effectiveSpecHash!==(effectivePresent?run.specHash:null))fail();
  if(s.enhancer===true&&!effectivePresent&&(run.phase==='completed'||run.promptId!=null))fail();
  if(effectivePresent){const fixed=x=>Object.fromEntries(Object.entries(x).filter(([key])=>!['prompt','negativePrompt'].includes(key)));if(s.enhancer!==true||digest(fixed(s))!==digest(fixed(effective))||!id.test(run.enhancerStartIntent?.id??'')||run.enhancerStartIntent.id!==run.enhancerCleanup?.intentId||run.enhancerCleanup.confirmed!==true||run.enhancerCleanup.childExited!==true||run.enhancement?.childExited!==true||run.enhancement.cleanupConfirmed!==true)fail();}
  return resultProof(value);
}

// Evaluation/iteration receipts are saved with the result in the same
// Controller transaction. The read endpoint independently checks its event,
// run and image binding. A missing receipt is never proof of non-execution.
export function verifyActionReceipt(intent,sessionId,value){
  if(!['evaluate','iteration','feedback'].includes(intent?.operation))fail();
  base(intent,intent.operation,sessionId);
  const p=value?.production,r=value?.receipt,item=intent.operation==='evaluate'?value?.evaluation:intent.operation==='iteration'?value?.plan:value?.feedback,items=intent.operation==='evaluate'?p?.evaluations:intent.operation==='iteration'?p?.iterationPlans:p?.feedbackRequests;
  ownedProduction(p,sessionId);
  if(!id.test(intent.targetId??'')||p.id!==intent.targetId||r?.requestId!==intent.requestId||r.operation!==intent.operation||r.productionId!==p.id||r.sessionId!==sessionId||r.payloadHash!==intent.inputHash||!Number.isSafeInteger(r.expectedRevision)||r.expectedRevision<0||r.productionRevision!==r.expectedRevision+1||!revisionAfterOnlyCancellation(p,r.productionRevision,value.cancellationReceipt)||!id.test(item?.id??'')||item.id!==r.resultId||!hash.test(r.resultHash??'')||digest(item)!==r.resultHash||!Array.isArray(items)||items.filter(x=>x?.id===item.id).length!==1)fail();
  const saved=items.find(x=>x?.id===item.id),immutable=intent.operation==='feedback'?Object.fromEntries(Object.entries(saved).filter(([key])=>key!=='resultRunId')):saved;
  if(digest(immutable)!==r.resultHash)fail();
  return resultProof(value);
}

// A search proposal is an approval request, never an authorization to send.
// The Controller's read-only endpoint verifies its saved record and receipt.
export function verifySearchReceipt(intent,sessionId,value){
  base(intent,'search-proposal',sessionId);
  const p=value?.proposal,r=value?.receipt;
  if(intent.targetId===null&&r?.state==='rejected'&&r.operation==='search-proposal'&&r.reason==='rejected-before-admission'&&r.requestId===intent.requestId&&r.sessionId===sessionId&&r.payloadHash===intent.inputHash&&Number.isInteger(r.httpStatus)&&r.httpStatus>=400&&r.httpStatus<500&&canonicalTime(r.recordedAt)&&p===undefined)return {outcome:'rejected',receiptHash:digest(value)};
  if(intent.targetId===null&&r?.state==='abandoned'&&r.requestId===intent.requestId&&r.sessionId===sessionId&&r.payloadHash===intent.inputHash&&id.test(r.proposalId??'')&&hash.test(r.proposalHash??'')&&typeof r.createdAt==='string'&&p===undefined)return {outcome:'rejected',receiptHash:digest(value)};
  if(intent.targetId!==null||r?.state!=='committed'||r.requestId!==intent.requestId||r.sessionId!==sessionId||r.payloadHash!==intent.inputHash||!id.test(r.proposalId??'')||!hash.test(r.proposalHash??'')||p?.id!==r.proposalId||p.sessionId!==sessionId||p.requestId!==intent.requestId||p.requestPayloadHash!==intent.inputHash||p.proposalHash!==r.proposalHash||!['queries','pages'].includes(p.kind))fail();
  const normalized=p.kind==='pages'?{kind:'pages',productionId:p.productionId,sessionId:p.sessionId,sourceProposalId:p.sourceProposalId,urls:p.urls,engine:p.engine,purpose:p.purpose}:{kind:'queries',productionId:p.productionId,sessionId:p.sessionId,queries:p.queries,engine:p.engine,purpose:p.purpose};
  if(digest(normalized)!==r.proposalHash)fail();
  return resultProof(value);
}

// PE receipts prove acceptance of a specific request only. In particular a
// reconcile receipt does not establish recovery, termination or GPU release.
export function verifyPeReceipt(intent,sessionId,value){
  const match=/^(moss|qwen)-pe-(start|decision|reconcile)$/.exec(intent?.operation??'');if(!match)fail();
  const [,family,action]=match;base(intent,intent.operation,sessionId);
  const p=value?.production,run=value?.run,r=value?.receipt;ownedProduction(p,sessionId);
  if(!id.test(run?.id??'')||run.sessionId!==sessionId||run.productionId!==p.id||run.kind!==family+'-pe'||!run.spec||run.spec.task!==family+'-pe'||run.spec.productionId!==p.id||run.spec.briefHash!==p.briefHash||digest(run.spec)!==run.specHash||!Array.isArray(p.promptEnhancements)||p.promptEnhancements.filter(x=>x===run.id).length!==1||r?.requestId!==intent.requestId||r.sessionId!==sessionId||r.productionId!==p.id||r.runId!==run.id||r.family!==family||r.payloadHash!==intent.inputHash)fail();
  if(action==='start'){
    if(intent.targetId!==p.id||run.requestId!==intent.requestId||!Number.isSafeInteger(r.expectedRevision)||r.productionRevision!==r.expectedRevision+1||run.productionRevision!==r.productionRevision||!revisionAfterOnlyCancellation(p,r.productionRevision,value.cancellationReceipt))fail();
  }else if(action==='decision'){
    const decision=run[family==='moss'?'mossPeDecision':'qwenPeDecision'];
    if(intent.targetId!==run.id||!Number.isSafeInteger(r.expectedRevision)||r.productionRevision!==r.expectedRevision+1||!revisionAfterOnlyCancellation(p,r.productionRevision,value.cancellationReceipt)||!id.test(decision?.id??'')||r.decisionId!==decision.id||!hash.test(r.decisionHash??'')||digest(decision)!==r.decisionHash)fail();
  }else if(intent.targetId!==run.id||r.operation!=='reconcile'||typeof r.acceptedAt!=='string')fail();
  return resultProof(value);
}

// An asset receipt is meaningful only after Controller has re-read and checked
// the owned original and canonical files. The correlation hash contains only
// the requested role and original image hash, never the image bytes.
export function verifyAssetReceipt(intent,sessionId,value){
  base(intent,'asset-import',sessionId);
  const r=value?.receipt,a=value?.asset;
  if(intent.targetId===null&&['rejected','abandoned'].includes(r?.state)&&r.requestId===intent.requestId&&r.sessionId===sessionId&&r.payloadHash===intent.inputHash&&id.test(r.assetId??'')&&hash.test(r.originalSha256??'')&&['input','reference'].some(purpose=>intent.correlationHash===digest({purpose,originalSha256:r.originalSha256}))&&(r.state!=='abandoned'||typeof r.createdAt==='string')&&a===undefined)return {outcome:'rejected',receiptHash:digest(value)};
  if(intent.targetId!==null||!hash.test(intent.correlationHash??'')||r?.state!=='committed'||r.requestId!==intent.requestId||r.sessionId!==sessionId||r.payloadHash!==intent.inputHash||!id.test(r.assetId??'')||!a||a.id!==r.assetId||!['input','reference'].includes(a.purpose)||a.mime!=='image/png'||!hash.test(a.originalSha256??'')||!hash.test(a.sha256??'')||a.originalSha256!==r.originalSha256||a.sha256!==r.canonicalSha256||r.metadataHash!==digest(a)||intent.correlationHash!==digest({purpose:a.purpose,originalSha256:a.originalSha256})||!Number.isSafeInteger(a.width)||!Number.isSafeInteger(a.height)||a.width<16||a.height<16||a.width>4096||a.height>4096||a.width*a.height>12000000)fail();
  return resultProof(value);
}

// This verifies a durable cancellation *request*, not job termination,
// prompt cancellation, cleanup, GPU release or availability of the core.
export function verifyCancelReceipt(intent,sessionId,value){
  base(intent,'cancel',sessionId);
  const p=value?.production,r=value?.receipt;ownedProduction(p,sessionId);
  if(!id.test(intent.targetId??'')||p.id!==intent.targetId||r?.requestId!==intent.requestId||r.sessionId!==sessionId||r.productionId!==p.id||r.operation!=='cancel'||r.payloadHash!==intent.inputHash||!Number.isSafeInteger(r.previousRevision)||r.previousRevision<0||!Number.isSafeInteger(r.productionRevision)||r.productionRevision<r.previousRevision||r.productionRevision>r.previousRevision+1||p.revision<r.productionRevision||!['accepted','already-requested','already-completed'].includes(r.disposition)||typeof r.acceptedAt!=='string'||(r.disposition==='accepted'&&r.productionRevision!==r.previousRevision+1)||(r.disposition!=='accepted'&&r.productionRevision!==r.previousRevision)||(['accepted','already-requested'].includes(r.disposition)&&(p.cancelRequested!==true||typeof r.cancelRequestedAt!=='string'||r.cancelRequestedAt!==p.cancelRequestedAt))||(r.disposition==='already-completed'&&p.cancelRequested!==false))fail();
  return resultProof(value);
}
