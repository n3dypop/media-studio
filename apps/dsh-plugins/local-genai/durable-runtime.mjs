// Durable adapter for local-genai. Unsupported mutations fail before dispatch;
// cancellation is always a separate owned lane. Deployment requires the
// corresponding Controller contracts and verified Host recovery paths.
import {createHash} from 'node:crypto';
import {openMutationJournal} from './durable-journal.mjs';
import {pinCreateModel,runDurableOwnedMutation,runDurableCancellation,reconcileDurableOwnedMutation} from './durable-coordinator.mjs';
import {requireScopeFeature} from './scope-feature.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const digest=value=>hash(JSON.stringify(value));
// Controller path routers and fences use canonical lowercase UUIDs. Never
// change a caller's identity silently; reject any other spelling before begin.
const validId=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function classify(path,body){
  if(path==='/api/productions')return {operation:'create',targetId:null};
  if(path==='/api/assets')return {operation:'asset-import',targetId:null};
  if(path==='/api/search-proposals')return {operation:'search-proposal',targetId:null};
  if(path==='/api/workflows/draft')return {operation:'workflow-draft',targetId:body?.productionId};
  const pe=path.match(/^\/api\/(moss|qwen)-pe(?:\/([a-f0-9-]{36})\/(decision|reconcile))?$/i);
  if(pe)return {operation:`${pe[1]}-pe-${pe[3]??'start'}`,targetId:pe[2]??body?.productionId};
  const match=path.match(/^\/api\/productions\/([a-f0-9-]{36})\/(render|render-prepared|evaluate|iteration|feedback|cancel)$/i);
  if(!match)return null;
  return {targetId:match[1],operation:match[2]==='render-prepared'?'prepared-render':match[2]};
}
function proofPath(operation,targetId,requestId){
  const query=new URLSearchParams({requestId});
  if(operation==='create')return '/api/productions?'+query;
  if(operation==='asset-import')return '/api/assets/by-request?'+query;
  if(operation==='search-proposal')return '/api/search-proposals/by-request?'+query;
  if(operation==='workflow-draft')return `/api/productions/${targetId}/workflow-by-request?`+query;
  if(operation==='prepared-render'||operation==='render')return `/api/productions/${targetId}/run-by-request?`+query;
  if(operation==='cancel')return `/api/productions/${targetId}/cancel-by-request?`+query;
  const pe=/^(moss|qwen)-pe-(start|decision|reconcile)$/.exec(operation);
  if(pe){if(pe[2]==='start'){query.set('productionId',targetId);return `/api/${pe[1]}-pe?`+query;}return `/api/${pe[1]}-pe/${targetId}/${pe[2]}-by-request?`+query;}
  if(['evaluate','iteration','feedback'].includes(operation)){query.set('operation',operation);return `/api/productions/${targetId}/operation-by-request?`+query;}
  throw Error('This operation has no verified recovery path');
}

export async function createDurableRuntime({root,ctx,sessionIdentity,mapSessionId,request,requestIdFor,expectedCreateBrief,errorFactory}){
  if(!ctx?.sessions||!ctx?.sessionPersistence||typeof sessionIdentity!=='function'||typeof mapSessionId!=='function'||typeof request!=='function'||typeof requestIdFor!=='function'||typeof expectedCreateBrief!=='function'||typeof errorFactory!=='function')throw Error('Durable DSH runtime dependencies are unavailable');
  const journal=await openMutationJournal(root),receipts=new Map();let closed=false;
  const remember=(callId,proof)=>receipts.set(callId,[...(receipts.get(callId)??[]),proof]);
  const read=(path,exec,signal=exec.signal)=>request(path,{sessionId:sessionIdentity(exec),signal});
  const wireProof=(exec,signal)=>async proof=>(await read('/api/durable-wire-proof?'+new URLSearchParams(proof),exec,signal))?.present===true;
  function unresolved(error,sessionId,callId){
    let pending=[];try{pending=journal.pending(sessionId).filter(x=>x.callIdHash===hash(callId));}catch{}
    const original=pending.find(x=>x.lane==='normal')??pending[0];
    if(original)return errorFactory(`The operation result is unresolved. Do not resend it; use request ID ${original.requestId} for the corresponding read-only reconciliation or contact maintenance.`,{uncertain:true,requestId:original.requestId});
    return error;
  }
  return Object.freeze({
    pending(exec,{currentCallOnly=false}={}){
      if(closed)throw Error('Durable DSH runtime is closed');
      const sessionId=sessionIdentity(exec);requireScopeFeature(sessionId);
      if(typeof currentCallOnly!=='boolean'||(currentCallOnly&&(typeof exec.callId!=='string'||!exec.callId)))throw Error('Invalid pending operation scope');
      const callHash=currentCallOnly?hash(exec.callId):null;
      return journal.pending(sessionId).filter(row=>!callHash||row.callIdHash===callHash||row.deliveryCallIdHash===callHash).map(row=>({operation:row.operation,requestId:row.requestId,targetId:row.targetId,phase:row.state}));
    },
    async mutate(path,originalBody,exec,{allowUncertain=false,signal=exec.signal,validateResult=()=>{}}={}){
      if(closed)throw Error('Durable DSH runtime is closed');
      let body=originalBody;const description=classify(path,body),sessionId=sessionIdentity(exec);
      if(!description||allowUncertain!==(description.operation==='cancel'||description.operation.endsWith('-pe-reconcile')))throw errorFactory('This operation has no verified durable contract and was not sent. Request maintenance support.',{uncertain:false});
      const {operation,targetId}=description;if(targetId!==null&&!validId.test(targetId??''))throw errorFactory('The owned production identity is invalid; no operation was sent.',{uncertain:false});
      if(operation==='create'&&body.modelProfile===undefined){
        const query=new URLSearchParams({mode:body.brief?.mode??'t2i'}),input=body.brief?.inputAssetId??body.brief?.inputAssetIds?.[0];if(input)query.set('inputAssetId',input);
        body=pinCreateModel(body,await read('/api/workflow-catalog?'+query,exec,signal));
      }
      if(['asset-import','evaluate','iteration','feedback','search-proposal','cancel'].includes(operation))body={...body,requestId:requestIdFor(sessionId,exec.callId,operation==='cancel'?'cancel:'+targetId:operation)};
      if(/^(moss|qwen)-pe-(decision|reconcile)$/.test(operation))body={...body,requestId:requestIdFor(sessionId,exec.callId,operation)};
      if(typeof body?.requestId!=='string'||!validId.test(body.requestId))throw errorFactory('A stable request identity is unavailable; no operation was sent.',{uncertain:false});
      if(operation==='workflow-draft'&&(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0))throw errorFactory('The workflow revision is invalid; no operation was sent.',{uncertain:false});
      let size;try{size=Buffer.byteLength(JSON.stringify(body));}catch{throw errorFactory('The request cannot be serialized; no operation was sent.',{uncertain:false});}
      const limit=operation==='asset-import'?14*1024**2:operation==='workflow-draft'?131072:/^(moss|qwen)-pe-decision$/.test(operation)?1048576:32768;
      if(size>limit)throw errorFactory('The request exceeds the supported size; no operation was sent.',{uncertain:false});
      if(operation!=='cancel')requireScopeFeature(sessionId);
      let correlationHash=null;
      if(operation==='create')correlationHash=digest(expectedCreateBrief(body));
      if(operation==='workflow-draft')correlationHash=digest({expectedRevision:body.expectedRevision});
      if(operation==='asset-import'){
        const originalSha256=typeof body.dataBase64==='string'?hash(Buffer.from(body.dataBase64,'base64')):body.artifactSha256;
        if(!/^[a-f0-9]{64}$/.test(originalSha256??'')||!['input','reference'].includes(body.purpose))throw errorFactory('The original image cannot be identified; no import was sent.',{uncertain:false});
        correlationHash=digest({purpose:body.purpose,originalSha256});
      }
      const common={journal,session:exec.agent.session,sessions:ctx.sessions,persistence:ctx.sessionPersistence,mapSessionId,currentCallId:exec.callId,toolName:exec.name,targetId,input:body,send:async()=>{const value=await request(path,{sessionId,method:'POST',body,signal});validateResult(value);return value;},readProof:()=>read(proofPath(operation,targetId,body.requestId),exec,signal)};
      try{
        const result=operation==='cancel'?await runDurableCancellation(common):await runDurableOwnedMutation({...common,operation,correlationHash,wireProof:wireProof(exec,signal)});
        remember(exec.callId,result.journalReceipt);return result.value;
      }catch(error){throw unresolved(error,sessionId,exec.callId);}
    },
    async reconcile({operation,targetId=null,requestId,exec}){
      if(closed)throw Error('Durable DSH runtime is closed');
      if(!validId.test(requestId??'')||targetId!==null&&!validId.test(targetId))throw errorFactory('The original request identity is required; nothing was sent.',{uncertain:false});
      requireScopeFeature(sessionIdentity(exec));
      if(operation==='any-render'){
        const matches=journal.pending(sessionIdentity(exec)).filter(x=>['render','prepared-render'].includes(x.operation)&&x.requestId===requestId&&x.targetId===targetId);
        if(matches.length!==1)throw errorFactory('The original render identity is missing or ambiguous; nothing was sent.',{uncertain:true,requestId});
        operation=matches[0].operation;
      }
      const result=await reconcileDurableOwnedMutation({journal,session:exec.agent.session,mapSessionId,currentCallId:exec.callId,toolName:exec.name,operation,targetId,requestId,readProof:async()=>{
        if(operation==='workflow-draft'){
          const status=await read('/api/workflow-requests/by-request?'+new URLSearchParams({requestId}),exec);
          if(status?.receipt?.state!=='committed')return status;
        }
        let value;try{value=await read(proofPath(operation,targetId,requestId),exec);}catch(error){
          const pe=/^(moss|qwen)-pe-(start|decision|reconcile)$/.test(operation),eligible=['create','asset-import','render','prepared-render','cancel','evaluate','iteration','feedback'].includes(operation)||pe;
          // An unavailable PE endpoint returns 503 even when the controller
          // has durably fenced a pre-admission rejection. The separate owned
          // rejection read must itself reject an existing acceptance or an
          // inconsistent ledger; it never proves absence from a 404.
          if(!eligible||(error?.status!==404&&!(pe&&error?.status===503)))throw error;
          return read('/api/productions/mutation-rejections/by-request?'+new URLSearchParams({operation,requestId}),exec);
        }
        if(operation==='create'&&Array.isArray(value?.productions)&&value.productions.length===0)return read('/api/productions/mutation-rejections/by-request?'+new URLSearchParams({operation,requestId}),exec);
        return value;
      }});
      remember(exec.callId,result.journalReceipt);return result.value;
    },
    takeReceipts(callId){const value=receipts.get(callId);receipts.delete(callId);return value;},
    close(){if(!closed){closed=true;receipts.clear();journal.close();}},
  });
}
