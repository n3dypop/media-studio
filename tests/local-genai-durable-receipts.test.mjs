import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {verifyCreateReceipt,verifyWorkflowReceipt,verifyPreparedRenderReceipt,verifyActionReceipt,verifyAssetReceipt,verifyCancelReceipt,verifySearchReceipt,verifyPeReceipt,verifyAdmissionRejection} from '../apps/dsh-plugins/local-genai/durable-receipts.mjs';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
test('common rejected receipt binds action, owner, target and exact payload',()=>{
 for(const operation of ['create','asset-import','render','prepared-render','cancel','evaluate','iteration','feedback','moss-pe-start','moss-pe-decision','moss-pe-reconcile','qwen-pe-start','qwen-pe-decision','qwen-pe-reconcile']){const sessionId='owner',requestId='dddddddd-dddd-4ddd-8ddd-dddddddddddd',targetId=['create','asset-import'].includes(operation)?null:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',inputHash='a'.repeat(64),intent={operation,sessionId,requestId,targetId,inputHash},receipt={operation,sessionId,requestId,targetId,payloadHash:inputHash,state:'rejected',reason:'rejected-before-admission',httpStatus:400,recordedAt:'2026-01-01T00:00:00.000Z'};assert.equal(verifyAdmissionRejection(intent,sessionId,{receipt}).outcome,'rejected');for(const change of [{...receipt,targetId:'other'},{...receipt,payloadHash:'b'.repeat(64)},{...receipt,state:'started'},{...receipt,operation:'feedback'}])if(JSON.stringify(change)!==JSON.stringify(receipt))assert.throws(()=>verifyAdmissionRejection(intent,sessionId,{receipt:change}),/unresolved/);}
});
test('search approval proposal receipt binds exact owner, input and saved query while started remains unresolved',()=>{
 const sessionId='owned-session',requestId='dddddddd-dddd-4ddd-8ddd-dddddddddddd',proposalId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',inputHash='a'.repeat(64);
 const fields={kind:'queries',productionId:null,sessionId,queries:['fixture'],engine:'duckduckgo',purpose:'fixture'};
 const proposalHash=digest(fields),proposal={id:proposalId,...fields,requestId,requestPayloadHash:inputHash,proposalHash},receipt={requestId,sessionId,payloadHash:inputHash,proposalId,proposalHash,state:'committed'},intent={operation:'search-proposal',sessionId,requestId,inputHash,targetId:null},value={proposal,receipt};
 assert.equal(verifySearchReceipt(intent,sessionId,value).outcome,'applied');
 assert.equal(verifySearchReceipt(intent,sessionId,{receipt:{...receipt,state:'abandoned',createdAt:'2026-01-01T00:00:00.000Z'}}).outcome,'rejected');
 assert.equal(verifySearchReceipt(intent,sessionId,{receipt:{operation:'search-proposal',reason:'rejected-before-admission',requestId,sessionId,payloadHash:inputHash,state:'rejected',httpStatus:400,recordedAt:'2026-01-01T00:00:00.000Z'}}).outcome,'rejected');
 assert.throws(()=>verifySearchReceipt(intent,sessionId,{receipt:{...receipt,state:'started'}}),/unresolved/);
 for(const bad of [{...value,receipt:{...receipt,state:'started'}},{...value,proposal:{...proposal,queries:['other']}},{...value,receipt:{...receipt,sessionId:'other'}},{...value,receipt:{...receipt,payloadHash:'b'.repeat(64)}}])assert.throws(()=>verifySearchReceipt(intent,sessionId,bad),/unresolved/);
});
const productionId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',workflowId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',runId='cccccccc-cccc-4ccc-8ccc-cccccccccccc',requestId='dddddddd-dddd-4ddd-8ddd-dddddddddddd',session='owned-session';
const brief={request:'adult portrait',criteria:[{id:'C1',description:'portrait'}],invariants:[],modelProfile:'moss-image-sft-official-v1',mode:'t2i'};
test('PE start, decision and recovery receipts bind the same production and run without asserting cleanup',()=>{
 for(const family of ['moss','qwen']){
  const p={id:productionId,sessionId:session,revision:1,cancelRequested:false,brief,briefHash:digest(brief),promptEnhancements:[runId]},spec={task:family+'-pe',productionId,briefHash:p.briefHash},run={id:runId,productionId,sessionId:session,kind:family+'-pe',requestId,spec,specHash:digest(spec),productionRevision:1},base={requestId,sessionId:session,productionId,runId,family,payloadHash:'a'.repeat(64)},intent={operation:family+'-pe-start',sessionId:session,requestId,inputHash:base.payloadHash,targetId:productionId};
  const start={production:p,run,receipt:{...base,expectedRevision:0,productionRevision:1}};assert.equal(verifyPeReceipt(intent,session,start).outcome,'applied');
  const decision={id:workflowId,decision:'accept'},decisionRun={...run,[family==='moss'?'mossPeDecision':'qwenPeDecision']:decision},decisionValue={production:p,run:decisionRun,receipt:{...base,expectedRevision:0,productionRevision:1,decisionId:workflowId,decisionHash:digest(decision)}};
  assert.equal(verifyPeReceipt({...intent,operation:family+'-pe-decision',targetId:runId},session,decisionValue).outcome,'applied');
  const recovery={production:p,run,receipt:{...base,operation:'reconcile',acceptedAt:'2026-01-01T00:00:00.000Z'}};assert.equal(verifyPeReceipt({...intent,operation:family+'-pe-reconcile',targetId:runId},session,recovery).outcome,'applied');
  for(const bad of [{...start,run:{...run,spec:{...spec,task:'altered'}}},{...start,receipt:{...start.receipt,payloadHash:'b'.repeat(64)}},{...start,production:{...p,sessionId:'other'}}])assert.throws(()=>verifyPeReceipt(intent,session,bad),/unresolved/);
 }
});
const p={id:productionId,sessionId:session,requestId,brief,briefHash:digest(brief),revision:0,cancelRequested:false,workflowId:null,latestRunId:null,attempts:[]};
const graph={'1':{class_type:'Example',inputs:{seed:2}}};
const w={id:workflowId,productionId,sha256:digest(graph),graph,modelProfile:brief.modelProfile,mode:'t2i',schemaVersion:4,inputAssetIds:[],request:{prompt:'adult portrait',negativePrompt:'',seed:'42',steps:25},output:{width:768,height:1024}};
const createIntent={operation:'create',sessionId:session,requestId,inputHash:digest({any:'create request'}),correlationHash:p.briefHash,targetId:null};
const workflowIntent={operation:'workflow-draft',sessionId:session,requestId,inputHash:digest({any:'workflow request'}),targetId:productionId};
const preparedBody={workflowId,expectedRevision:1,requestId};
const preparedIntent={operation:'prepared-render',sessionId:session,requestId,inputHash:digest(preparedBody),targetId:productionId};
const workflowProduction={...p,revision:1,workflowId,workflowSha256:w.sha256};
const workflowValue={production:workflowProduction,workflow:w,receipt:{requestId,productionId,payloadHash:workflowIntent.inputHash,expectedRevision:0,workflowId,workflowHash:w.sha256,snapshotHash:digest(w)}};
const spec={workflow:w,assetSessionId:session,briefHash:p.briefHash,enhancer:false,modelProfile:brief.modelProfile,mode:'t2i',inputAssetId:null,invariants:[],referenceAssets:[],prompt:'adult portrait',negativePrompt:'',seed:'42',steps:25,width:768,height:1024};
const run={id:runId,sessionId:session,productionId,requestId,productionRevision:2,cancelRequested:false,spec,specHash:digest(spec)};
const renderValue={production:{...workflowProduction,revision:2,latestRunId:runId,attempts:[runId]},run};
const change=(value,fn)=>{const copy=structuredClone(value);fn(copy);return copy;};
function cancelAfter(value,revision){const x=structuredClone(value),production=x.production??x.productions[0],stamp='2026-11-05T00:00:00Z';production.cancelRequested=true;production.cancelRequestedAt=stamp;production.revision=revision+1;x.cancellationReceipt={sessionId:session,productionId,requestId:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',operation:'cancel',payloadHash:'f'.repeat(64),disposition:'accepted',previousRevision:revision,productionRevision:revision+1,acceptedAt:stamp,cancelRequestedAt:stamp};return x;}

test('create receipt binds the request, normalized brief and session, rejecting ambiguity',()=>{
  const value={productions:[p]};assert.equal(verifyCreateReceipt(createIntent,session,value).receiptHash,digest(value));
  for(const bad of [change(value,x=>x.productions[0].sessionId='other'),change(value,x=>x.productions[0].brief.request='changed'),change(value,x=>x.productions[0].revision=1),{productions:[p,p]}])assert.throws(()=>verifyCreateReceipt(createIntent,session,bad),/unresolved/);
  assert.throws(()=>verifyCreateReceipt({...createIntent,correlationHash:'a'.repeat(64)},session,value),/unresolved/);
  const cancelled=cancelAfter(value,0);assert.equal(verifyCreateReceipt(createIntent,session,cancelled).outcome,'applied');delete cancelled.cancellationReceipt;assert.throws(()=>verifyCreateReceipt(createIntent,session,cancelled),/unresolved/);
});
test('workflow receipt requires exact original payload and intact owned snapshot',()=>{
  assert.equal(verifyWorkflowReceipt(workflowIntent,session,workflowValue).receiptHash,digest(workflowValue));
  for(const bad of [change(workflowValue,x=>x.receipt.payloadHash='0'.repeat(64)),change(workflowValue,x=>x.workflow.graph['1'].inputs.seed=5),change(workflowValue,x=>x.receipt.snapshotHash='0'.repeat(64)),change(workflowValue,x=>x.production.sessionId='other'),change(workflowValue,x=>x.production.revision++)])assert.throws(()=>verifyWorkflowReceipt(workflowIntent,session,bad),/unresolved/);
  const cancelled=cancelAfter(workflowValue,1);assert.equal(verifyWorkflowReceipt(workflowIntent,session,cancelled).outcome,'applied');cancelled.cancellationReceipt.previousRevision=0;assert.throws(()=>verifyWorkflowReceipt(workflowIntent,session,cancelled),/unresolved/);
});
test('workflow rejection or fenced abandonment matches the original revision and never claims cache removal',()=>{
 const intent={operation:'workflow-draft',sessionId:session,requestId,targetId:productionId,inputHash:'a'.repeat(64),correlationHash:digest({expectedRevision:3})};
 const base={operation:'workflow-draft',sessionId:session,requestId,productionId,payloadHash:intent.inputHash,expectedRevision:3,inputCacheMayExist:true,recordedAt:'2026-01-01T00:00:00.000Z'};
 const rejected={receipt:{...base,state:'rejected',httpStatus:400,reason:'rejected-before-workflow-write'}};assert.equal(verifyWorkflowReceipt(intent,session,rejected).outcome,'rejected');
 const abandoned={receipt:{...base,state:'abandoned',reason:'fenced-against-binding',workflowFileMayExist:true}};assert.equal(verifyWorkflowReceipt(intent,session,abandoned).outcome,'rejected');
 for(const bad of [{receipt:{...base,state:'started'}},{receipt:{...rejected.receipt,expectedRevision:4}},{receipt:{...abandoned.receipt,workflowFileMayExist:false}}])assert.throws(()=>verifyWorkflowReceipt(intent,session,bad),/unresolved/);
});
test('prepared render recovers exact original request and rejects changed or foreign evidence',()=>{
  assert.equal(verifyPreparedRenderReceipt(preparedIntent,session,renderValue).receiptHash,digest(renderValue));
  for(const bad of [change(renderValue,x=>x.run.sessionId='other'),change(renderValue,x=>x.run.spec.workflow.graph['1'].inputs.seed=4),change(renderValue,x=>x.run.specHash='0'.repeat(64)),change(renderValue,x=>x.production.attempts.push(runId)),change(renderValue,x=>x.run.productionRevision++),change(renderValue,x=>x.run.cancelRequested=true)])assert.throws(()=>verifyPreparedRenderReceipt(preparedIntent,session,bad),/unresolved/);
  assert.throws(()=>verifyPreparedRenderReceipt({...preparedIntent,inputHash:digest({...preparedBody,expectedRevision:0})},session,renderValue),/unresolved/);
  const cancelled=change(renderValue,x=>{x.production.cancelRequested=true;x.production.cancelRequestedAt='2026-11-05T00:00:00Z';x.production.revision++;x.run.cancelRequested=true;x.cancellationReceipt={sessionId:session,productionId,requestId:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',operation:'cancel',payloadHash:'f'.repeat(64),disposition:'accepted',previousRevision:2,productionRevision:3,acceptedAt:'2026-11-05T00:00:00Z',cancelRequestedAt:x.production.cancelRequestedAt};});assert.equal(verifyPreparedRenderReceipt(preparedIntent,session,cancelled).outcome,'applied');
  cancelled.run.cancelRequested=false;assert.equal(verifyPreparedRenderReceipt(preparedIntent,session,cancelled).outcome,'applied');
  const withoutProof=change(cancelled,x=>delete x.cancellationReceipt);assert.throws(()=>verifyPreparedRenderReceipt(preparedIntent,session,withoutProof),/unresolved/);
  cancelled.production.revision++;assert.throws(()=>verifyPreparedRenderReceipt(preparedIntent,session,cancelled),/unresolved/);
});
test('evaluation, iteration and feedback receipts bind production, input and exact saved result',()=>{
  for(const operation of ['evaluate','iteration','feedback']){
    const item={id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',summary:'synthetic'},field=operation==='evaluate'?'evaluation':operation==='iteration'?'plan':'feedback',collection=operation==='evaluate'?'evaluations':operation==='iteration'?'iterationPlans':'feedbackRequests';
    const intent={operation,sessionId:session,requestId,inputHash:'a'.repeat(64),targetId:productionId};
    const value={production:{...p,revision:1,[collection]:[item]},[field]:item,receipt:{operation,requestId,sessionId:session,productionId,payloadHash:intent.inputHash,expectedRevision:0,productionRevision:1,resultId:item.id,resultHash:digest(item)}};
    assert.equal(verifyActionReceipt(intent,session,value).receiptHash,digest(value));
    for(const bad of [change(value,x=>x.receipt.payloadHash='0'.repeat(64)),change(value,x=>x.production.sessionId='other'),change(value,x=>x[field].summary='altered'),change(value,x=>x.production[collection].push(item)),change(value,x=>x.production[collection].push({...item,summary:'altered duplicate'})),change(value,x=>x.production.revision++)])assert.throws(()=>verifyActionReceipt(intent,session,bad),/unresolved/);
    const cancelled=cancelAfter(value,1);assert.equal(verifyActionReceipt(intent,session,cancelled).outcome,'applied');cancelled.production.revision++;assert.throws(()=>verifyActionReceipt(intent,session,cancelled),/unresolved/);
  }
});
test('asset receipt binds session, exact request, metadata, purpose and original hash',()=>{
 const asset={id:'ffffffff-ffff-4fff-8fff-ffffffffffff',purpose:'input',mime:'image/png',originalSha256:'a'.repeat(64),sha256:'b'.repeat(64),width:64,height:64};
 const intent={operation:'asset-import',sessionId:session,requestId,inputHash:'c'.repeat(64),correlationHash:digest({purpose:asset.purpose,originalSha256:asset.originalSha256}),targetId:null};
 const value={asset,receipt:{requestId,sessionId:session,payloadHash:intent.inputHash,assetId:asset.id,originalSha256:asset.originalSha256,canonicalSha256:asset.sha256,metadataHash:digest(asset),state:'committed'}};
 assert.equal(verifyAssetReceipt(intent,session,value).receiptHash,digest(value));
 const rejected={receipt:{requestId,sessionId:session,payloadHash:intent.inputHash,assetId:asset.id,originalSha256:asset.originalSha256,state:'rejected'}};
 assert.equal(verifyAssetReceipt(intent,session,rejected).outcome,'rejected');
 assert.equal(verifyAssetReceipt(intent,session,{receipt:{...rejected.receipt,state:'abandoned',createdAt:'2026-01-01T00:00:00.000Z'}}).outcome,'rejected');
 assert.throws(()=>verifyAssetReceipt(intent,session,{receipt:{...rejected.receipt,originalSha256:'0'.repeat(64)}}),/unresolved/);
 for(const bad of [change(value,x=>x.receipt.state='started'),change(value,x=>x.receipt.sessionId='other'),change(value,x=>x.receipt.payloadHash='0'.repeat(64)),change(value,x=>x.asset.purpose='reference'),change(value,x=>x.asset.originalSha256='0'.repeat(64)),change(value,x=>x.receipt.metadataHash='0'.repeat(64))])assert.throws(()=>verifyAssetReceipt(intent,session,bad),/unresolved/);
});
test('cancel receipt proves acceptance separately from completion or resource release',()=>{
 const stamp='2026-11-05T00:00:00.000Z',body={requestId},intent={operation:'cancel',sessionId:session,requestId,inputHash:digest(body),targetId:productionId};
 const value={production:{...p,cancelRequested:true,cancelRequestedAt:stamp,revision:1},receipt:{requestId,sessionId:session,productionId,operation:'cancel',payloadHash:intent.inputHash,previousRevision:0,productionRevision:1,disposition:'accepted',acceptedAt:stamp,cancelRequestedAt:stamp}};
 assert.equal(verifyCancelReceipt(intent,session,value).outcome,'applied');
 for(const bad of [change(value,x=>x.receipt.sessionId='other'),change(value,x=>x.receipt.payloadHash='0'.repeat(64)),change(value,x=>x.production.cancelRequested=false),change(value,x=>x.receipt.productionRevision=0),change(value,x=>x.receipt.cancelRequestedAt='different')])assert.throws(()=>verifyCancelReceipt(intent,session,bad),/unresolved/);
});
