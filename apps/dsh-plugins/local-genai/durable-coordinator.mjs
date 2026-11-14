// Durable coordinator for local-genai; saved receipts and visible delivery
// are verified before an owned mutation is released.
import {createHash} from 'node:crypto';
import {performDurableMutation} from './durable-mutation.mjs';
import {verifyCreateReceipt,verifyWorkflowReceipt,verifyPreparedRenderReceipt,verifyLegacyRenderReceipt,verifyActionReceipt,verifyAssetReceipt,verifyCancelReceipt,verifySearchReceipt,verifyPeReceipt,verifyAdmissionRejection} from './durable-receipts.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const digest=value=>hash(JSON.stringify(value));
const verifiers={create:verifyCreateReceipt,'asset-import':verifyAssetReceipt,'workflow-draft':verifyWorkflowReceipt,'prepared-render':verifyPreparedRenderReceipt,render:verifyLegacyRenderReceipt,evaluate:verifyActionReceipt,iteration:verifyActionReceipt,feedback:verifyActionReceipt,'search-proposal':verifySearchReceipt,cancel:verifyCancelReceipt};
const reconcileNames={create:'local_production_reconcile_create','asset-import':'local_asset_reconcile','workflow-draft':'local_workflow_reconcile','prepared-render':'local_render_reconcile',render:'local_render_reconcile',evaluate:'local_production_action_reconcile',iteration:'local_production_action_reconcile',feedback:'local_production_action_reconcile','search-proposal':'local_search_reconcile',cancel:'local_cancel_reconcile'};
for(const family of ['moss','qwen'])for(const action of ['start','decision','reconcile']){verifiers[`${family}-pe-${action}`]=verifyPeReceipt;reconcileNames[`${family}-pe-${action}`]='local_pe_receipt_reconcile';}
// A default is read from a fresh Controller catalog and written into the
// request *before* it is hashed or sent. Later changes of the Controller
// default cannot silently change that original production. An explicit model
// is never replaced. Failure to identify an available default is not license
// to pick another catalog entry.
export function pinCreateModel(body,catalog){
  if(!body||typeof body!=='object'||Array.isArray(body)||!body.brief||typeof body.brief!=='object'||Array.isArray(body.brief))throw Error('Production request is incomplete');
  if(body.modelProfile!==undefined){if(typeof body.modelProfile!=='string'||!body.modelProfile||body.brief.modelProfile!==undefined&&body.brief.modelProfile!==body.modelProfile)throw Error('Explicit model identity differs');return body;}
  if(body.brief.modelProfile!==undefined)throw Error('Ambiguous model identity');
  const id=catalog?.modelProfile,mode=body.brief.mode??'t2i';
  if(typeof id!=='string'||!id||!Array.isArray(catalog.modelProfiles)||!catalog.modelProfiles.some(x=>x.id===id&&x.available===true)||!Array.isArray(catalog.capabilities)||!catalog.capabilities.some(x=>x.modelProfile===id&&x.mode===mode))throw Error('The current default model and requested mode could not be confirmed; do not select a replacement');
  return {...body,modelProfile:id};
}
function originalIdentity(session,callId,name){
  const entries=session.snapshotEvents().filter(x=>x.type==='tool/call'&&x.data?.callId===callId);
  if(entries.length!==1||entries[0].data.name!==name||!Number.isSafeInteger(entries[0].data.turn)||entries[0].data.turn<1||!Number.isSafeInteger(entries[0].data.step)||entries[0].data.step<1)throw Error('The current DSH call identity is missing or ambiguous');
  return entries[0].data;
}
function proofFor(intent,sessionId,proof){
  if((['create','asset-import','render','prepared-render','cancel','evaluate','iteration','feedback'].includes(intent.operation)||/^(moss|qwen)-pe-(start|decision|reconcile)$/.test(intent.operation))&&proof?.receipt?.state==='rejected'&&proof.receipt.operation===intent.operation)return verifyAdmissionRejection(intent,sessionId,proof);
  const verify=verifiers[intent.operation];if(!verify)throw Error('The operation has no supported durable receipt contract');
  return verify(intent,sessionId,proof);
}

// `readProof` must issue exactly one authorized read for the same request and
// production and return the unmodified Controller JSON. It must never submit or
// retry a mutation. An error after dispatch leaves the saved intent unresolved.
export async function runDurableOwnedMutation({journal,session,sessions,persistence,mapSessionId,currentCallId,toolName,operation,targetId=null,input,correlationHash=null,send,readProof,wireProof}){
  if(!verifiers[operation]||typeof send!=='function'||typeof readProof!=='function')throw Error('Unsupported or incomplete durable operation');
  if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.requestId!=='string')throw Error('A durable request identity is required');
  if(['create','asset-import'].includes(operation)&&(targetId!==null||typeof correlationHash!=='string'))throw Error('Create and asset import require their original correlation hash');
  if(operation==='search-proposal'&&targetId!==null)throw Error('Search proposal target must be session scoped');
  if(!['create','asset-import','search-proposal'].includes(operation)&&typeof targetId!=='string')throw Error('The original owned production identity is required');
  let trusted;
  const result=await performDurableMutation({journal,session,sessions,persistence,mapSessionId,currentCallId,toolName,operation,requestId:input.requestId,input,correlationHash,targetId,send,wireProof,
    async verifyReceipt(response,{sessionId,intent}){
      const rejected=operation==='workflow-draft'&&response?.receipt?.state==='rejected';
      const observed=await readProof(intent,rejected?response:undefined),proof=proofFor(intent,sessionId,observed);
      if(rejected){
        if(observed.receipt?.state!=='rejected'||proofFor(intent,sessionId,{receipt:response.receipt}).receiptHash!==proof.receiptHash)throw Error('The direct rejection differs from the saved receipt');
        trusted={state:'rejected',requestId:intent.requestId,diagnostic:response.diagnostic,guidance:'No workflow was saved by this request. Correct the reported setting before preparing again. If the setting is a user requirement, ask before changing it.'};
        return proof;
      }
      if(operation==='create'&&response?.production?.id!==observed?.productions?.[0]?.id||operation==='asset-import'&&response?.asset?.id!==observed?.asset?.id||operation==='workflow-draft'&&response?.workflow?.id!==observed?.workflow?.id||operation==='prepared-render'&&response?.run?.id!==observed?.run?.id||operation==='evaluate'&&response?.evaluation?.id!==observed?.evaluation?.id||operation==='iteration'&&response?.plan?.id!==observed?.plan?.id||operation==='feedback'&&response?.feedback?.id!==observed?.feedback?.id)throw Error('The direct response differs from the saved receipt');
      if(operation==='search-proposal'&&response?.proposal?.id!==observed?.proposal?.id)throw Error('The direct search response differs from the saved receipt');
      if(operation==='render'&&response?.run?.id!==observed?.run?.id)throw Error('The direct render response differs from the saved receipt');
      if(/^(moss|qwen)-pe-/.test(operation)&&response?.run?.id!==observed?.run?.id)throw Error('The direct PE response differs from the saved receipt');
      if(operation==='workflow-draft'&&response?.validation?.valid!==true)throw Error('Workflow validation response is missing');
      // Never return the unverified POST body to a tool caller. Only its
      // identity is used above; displayed production and result fields come
      // from the separately verified Controller read.
      trusted=operation==='create'?{production:observed.productions[0]}:operation==='workflow-draft'?{production:observed.production,workflow:observed.workflow,validation:{valid:true}}:observed;
      return proof;
    }});
  return {...result,value:trusted};
}

// This only rebinds a verified Controller receipt to a *different* DSH call.
// Its caller must include journalReceipt in the tool result. A subsequent tool
// call performs the separate session flush, durable read and acknowledgement.
export async function reconcileDurableOwnedMutation({journal,session,mapSessionId,currentCallId,toolName,operation,requestId,targetId=null,readProof}){
  if(reconcileNames[operation]!==toolName||typeof readProof!=='function')throw Error('Unsupported durable reconciliation');
  const sessionId=mapSessionId(session.id),candidates=journal.pending(sessionId).filter(x=>x.operation===operation&&x.requestId===requestId&&x.targetId===targetId);
  if(candidates.length!==1)throw Error('The original request is not uniquely pending');
  const intent=candidates[0],call=originalIdentity(session,currentCallId,toolName),value=await readProof(intent),proof=proofFor(intent,sessionId,value);
  const bound=journal.bindReconciledReceipt({sessionId,id:intent.id,requestId: intent.requestId,inputHash:intent.inputHash,operation,targetId,receiptHash:proof.receiptHash,previousReceiptHash:intent.state==='receipt'?intent.receiptHash:null,previousDeliveryCallIdHash:intent.deliveryCallIdHash,source:'verified-controller-read',outcome:proof.outcome,callIdHash:hash(currentCallId),toolName,turn:call.turn,step:call.step});
  return {value,journalReceipt:{id:intent.id,receiptHash:proof.receiptHash,ackNonce:bound.ackNonce}};
}

// A cancellation has an independent lane so that an in-progress mutation or
// an unresolved operation cannot prevent stopping its owned production. A 202
// confirms acceptance only; it never proves process exit or resource release.
export async function runDurableCancellation({journal,session,sessions,persistence,mapSessionId,currentCallId,toolName,targetId,input,send,readProof}){
  if(typeof targetId!=='string'||typeof send!=='function'||typeof readProof!=='function'||typeof input?.requestId!=='string')throw Error('Cancellation requires an owned target and request identity');
  const sessionId=mapSessionId(session.id),parents=journal.pending(sessionId).filter(x=>x.lane==='normal'&&x.callIdHash===hash(currentCallId));
  if(parents.length>1)throw Error('Cancellation parent is ambiguous');
  const parentIntentId=parents[0]?.id??null;
  let trusted;
  const result=await performDurableMutation({journal,session,sessions,persistence,mapSessionId,currentCallId,toolName,operation:'cancel',requestId:input.requestId,lane:'cancel',targetId,parentIntentId,input,send,
    async verifyReceipt(value,{intent}){
      const observed=await readProof(intent),proof=verifyCancelReceipt(intent,sessionId,observed);
      if(value?.production?.id!==targetId||value?.receipt?.requestId!==intent.requestId)throw Error('Cancellation response differs from its saved receipt');
      trusted=observed;return proof;
    }});
  return {...result,value:trusted};
}

export const durableInputHash=digest;
