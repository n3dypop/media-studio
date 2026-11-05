import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,isAbsolute,relative,sep} from 'node:path';
import {openMutationJournal} from '../apps/dsh-plugins/local-genai/durable-journal.mjs';
import {acknowledgeVisibleReceipts} from '../apps/dsh-plugins/local-genai/durable-mutation.mjs';
import {runDurableOwnedMutation,reconcileDurableOwnedMutation,runDurableCancellation,pinCreateModel} from '../apps/dsh-plugins/local-genai/durable-coordinator.mjs';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const requestId='dddddddd-dddd-4ddd-8ddd-dddddddddddd',productionId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',sessionId='owned-session';
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'owned-journal-'));await mkdir(join(root,'data'));
 t.after(async()=>{const rel=relative(tmpdir(),root);assert.ok(rel&&rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel));await rm(root,{recursive:true,force:true});});
 const events=[],nodes=[],messages=[],session={id:sessionId,surface:{nodes},snapshotEvents:()=>events,deriveMessages:()=>messages};
 const sessions={flush:async()=>true},persistence={flush:async()=>{},open:async(id,access)=>({id,access,read:async seq=>({events:events.filter(x=>x.seq===seq)}),close:async()=>{}})};
 const call=(id,step,name)=>{events.push({seq:events.length,type:'assistant/message',data:{turn:1,step,message:{source:{kind:'model'},content:[{type:'tool-call',id}]}}});events.push({seq:events.length,type:'tool/call',data:{callId:id,name,turn:1,step}});};
 const result=(id,step,value,isError=false)=>{const original=events.find(x=>x.type==='tool/call'&&x.data.callId===id),text=JSON.stringify(value),seq=events.length;events.push({seq,type:'tool/result',sourceEventSeqs:[original.seq],data:{turn:1,step,message:{role:'tool',toolCallId:id,isError,source:{kind:'tool',callId:id},content:[{type:'text',text}]}}});nodes.push(seq);messages.push({role:'tool',source:{kind:'tool',callId:id},toolCallId:id,content:[{type:'text',text}]});};
 const brief={request:'synthetic',criteria:[{id:'C1',description:'subject'}],invariants:[],modelProfile:'moss-image-sft-official-v1',mode:'t2i'};
 const production={id:productionId,sessionId,requestId,brief,briefHash:digest(brief),revision:0,cancelRequested:false,workflowId:null,latestRunId:null,attempts:[]};
 return {root,session,sessions,persistence,mapSessionId:id=>id,wireProof:async()=>true,call,result,production,correlationHash:digest(brief)};
}
test('visible and persisted DSH result cannot be acknowledged without provider-wire evidence',async t=>{
 const f=await fixture(t),journal=await openMutationJournal(f.root);f.call('create',1,'local_production_create');
 const first=await runDurableOwnedMutation({...f,journal,currentCallId:'create',toolName:'local_production_create',operation:'create',input:{requestId},send:async()=>({production:f.production}),readProof:async()=>({productions:[f.production]})});
 f.result('create',1,first);f.call('next',2,'local_workflow_draft');await assert.rejects(acknowledgeVisibleReceipts({...f,journal,currentCallId:'next',wireProof:async()=>false}),/Provider-wire/);assert.equal(journal.pending(sessionId).length,1);journal.close();
});
test('the observed available default is fixed before a request is journaled, never substituted',()=>{
 const body={requestId,brief:{request:'synthetic',mode:'t2i'}},catalog={modelProfile:'moss',modelProfiles:[{id:'moss',available:true},{id:'other',available:true}],capabilities:[{modelProfile:'moss',mode:'t2i'}]};
 const pinned=pinCreateModel(body,catalog);assert.equal(pinned.modelProfile,'moss');assert.equal(body.modelProfile,undefined);catalog.modelProfile='other';assert.equal(pinned.modelProfile,'moss');
 assert.throws(()=>pinCreateModel(body,catalog),/default model/);assert.throws(()=>pinCreateModel(body,{...catalog,modelProfile:'missing'}),/default model/);
 const explicit={...body,modelProfile:'chosen'};assert.equal(pinCreateModel(explicit,undefined),explicit);assert.throws(()=>pinCreateModel({...explicit,brief:{...body.brief,modelProfile:'other'}},catalog),/differs/);
});
test('lost create survives journal reopen and only a delivered verified reconcile unlocks it',async t=>{
 const f=await fixture(t);let journal=await openMutationJournal(f.root),sends=0;
 f.call('create',1,'local_production_create');
 await assert.rejects(runDurableOwnedMutation({...f,journal,currentCallId:'create',toolName:'local_production_create',operation:'create',input:{requestId},send:async()=>{sends++;throw Error('response lost');},readProof:async()=>{throw Error('unexpected read');}}),/response lost/);
 f.result('create',1,{error:'result unknown'},true);journal.close();journal=await openMutationJournal(f.root);
 f.call('wrong',2,'local_production_reconcile_create');
 await assert.rejects(reconcileDurableOwnedMutation({...f,journal,currentCallId:'wrong',toolName:'local_production_reconcile_create',operation:'create',requestId,readProof:async()=>({productions:[{...f.production,sessionId:'foreign'}]})}),/unresolved/);
 assert.equal(journal.pending(sessionId)[0].state,'intent');
 f.call('reconcile',3,'local_production_reconcile_create');
 const recovered=await reconcileDurableOwnedMutation({...f,journal,currentCallId:'reconcile',toolName:'local_production_reconcile_create',operation:'create',requestId,readProof:async()=>({productions:[f.production]})});
 f.result('reconcile',3,recovered);f.call('next',4,'local_workflow_draft');
 await acknowledgeVisibleReceipts({...f,journal,currentCallId:'next'});
 assert.equal(sends,1);assert.equal(journal.pending(sessionId).length,0);journal.close();
});
test('a definitively rejected asset remains fenced until its verified rejection is delivered',async t=>{
 const f=await fixture(t),input={requestId,purpose:'input',dataBase64:'ZmFrZQ=='},originalSha256=createHash('sha256').update('fake').digest('hex'),correlationHash=digest({purpose:'input',originalSha256});let journal=await openMutationJournal(f.root);
 f.call('import',1,'local_asset_import');await assert.rejects(runDurableOwnedMutation({...f,journal,currentCallId:'import',toolName:'local_asset_import',operation:'asset-import',input,correlationHash,send:async()=>{throw Error('HTTP 400');},readProof:async()=>{throw Error('unexpected');}}),/HTTP 400/);f.result('import',1,{error:'unknown'},true);
 journal.close();journal=await openMutationJournal(f.root);f.call('recover',2,'local_asset_reconcile');const rejected={receipt:{state:'rejected',requestId,sessionId,payloadHash:digest(input),assetId:productionId,originalSha256}};
 const recovered=await reconcileDurableOwnedMutation({...f,journal,currentCallId:'recover',toolName:'local_asset_reconcile',operation:'asset-import',requestId,readProof:async()=>rejected});assert.equal(journal.pending(sessionId)[0].outcome,'rejected');f.result('recover',2,recovered);f.call('next',3,'local_workflow_draft');await acknowledgeVisibleReceipts({...f,journal,currentCallId:'next'});assert.deepEqual(journal.pending(sessionId),[]);journal.close();
});
test('different direct response and controller evidence never acknowledge or retry the request',async t=>{
 const f=await fixture(t),journal=await openMutationJournal(f.root);let sends=0;
 f.call('create',1,'local_production_create');
 await assert.rejects(runDurableOwnedMutation({...f,journal,currentCallId:'create',toolName:'local_production_create',operation:'create',input:{requestId},send:async()=>{sends++;return {production:{...f.production,id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}};},readProof:async()=>({productions:[f.production]})}),/differs/);
 assert.equal(sends,1);assert.equal(journal.pending(sessionId)[0].state,'intent');journal.close();
});
test('the tool receives the verified read, not altered fields from a same-ID POST response',async t=>{
 const f=await fixture(t),journal=await openMutationJournal(f.root);f.call('create',1,'local_production_create');
 const result=await runDurableOwnedMutation({...f,journal,currentCallId:'create',toolName:'local_production_create',operation:'create',input:{requestId},send:async()=>({production:{...f.production,revision:99,brief:{...f.production.brief,request:'foreign'}}}),readProof:async()=>({productions:[f.production]})});
 assert.equal(result.value.production.revision,0);assert.equal(result.value.production.brief.request,'synthetic');journal.close();
});
test('a verified but undelivered reconcile can be rebound after restart and invalidates its old nonce',async t=>{
 const f=await fixture(t);let journal=await openMutationJournal(f.root);f.call('create',1,'local_production_create');
 await assert.rejects(runDurableOwnedMutation({...f,journal,currentCallId:'create',toolName:'local_production_create',operation:'create',input:{requestId},send:async()=>{throw Error('response lost');},readProof:async()=>{throw Error('unexpected');}}),/response lost/);
 f.result('create',1,{error:'unknown'},true);f.call('first-reconcile',2,'local_production_reconcile_create');
 const first=await reconcileDurableOwnedMutation({...f,journal,currentCallId:'first-reconcile',toolName:'local_production_reconcile_create',operation:'create',requestId,readProof:async()=>({productions:[f.production]})});
 journal.close();journal=await openMutationJournal(f.root);f.call('second-reconcile',3,'local_production_reconcile_create');
 const second=await reconcileDurableOwnedMutation({...f,journal,currentCallId:'second-reconcile',toolName:'local_production_reconcile_create',operation:'create',requestId,readProof:async()=>({productions:[f.production]})});
 assert.throws(()=>journal.acknowledge({sessionId,id:first.journalReceipt.id,receiptHash:first.journalReceipt.receiptHash,ackNonce:first.journalReceipt.ackNonce}),/matching/);
 assert.throws(()=>journal.begin({sessionId,lane:'cancel',operation:'cancel',requestId:null,inputHash:'a'.repeat(64),targetId:productionId,callIdHash:createHash('sha256').update('first-reconcile').digest('hex'),toolName:'local_production_cancel',turn:1,step:4}),/delivery call already used/);
 f.result('first-reconcile',2,first);f.call('interim',4,'local_workflow_draft');await assert.rejects(acknowledgeVisibleReceipts({...f,journal,currentCallId:'interim'}),/Result or subsequent call is not unique/);
 journal.close();journal=await openMutationJournal(f.root);f.call('third-reconcile',5,'local_production_reconcile_create');
 const third=await reconcileDurableOwnedMutation({...f,journal,currentCallId:'third-reconcile',toolName:'local_production_reconcile_create',operation:'create',requestId,readProof:async()=>({productions:[f.production]})});
 assert.throws(()=>journal.acknowledge({sessionId,id:second.journalReceipt.id,receiptHash:second.journalReceipt.receiptHash,ackNonce:second.journalReceipt.ackNonce}),/matching/);
 f.result('third-reconcile',5,third);f.call('next',6,'local_workflow_draft');await acknowledgeVisibleReceipts({...f,journal,currentCallId:'next'});
 assert.equal(journal.pending(sessionId).length,0);journal.close();
});
test('concurrent reconcile callers cannot both replace the same binding',async t=>{
 const f=await fixture(t),journal=await openMutationJournal(f.root);f.call('create',1,'local_production_create');
 await assert.rejects(runDurableOwnedMutation({...f,journal,currentCallId:'create',toolName:'local_production_create',operation:'create',input:{requestId},send:async()=>{throw Error('response lost');},readProof:async()=>{throw Error('unexpected');}}),/response lost/);
 f.call('first',2,'local_production_reconcile_create');f.call('second',3,'local_production_reconcile_create');
 let release;const gate=new Promise(resolve=>{release=resolve;}),readProof=async()=>{await gate;return {productions:[f.production]};};
 const a=reconcileDurableOwnedMutation({...f,journal,currentCallId:'first',toolName:'local_production_reconcile_create',operation:'create',requestId,readProof}),b=reconcileDurableOwnedMutation({...f,journal,currentCallId:'second',toolName:'local_production_reconcile_create',operation:'create',requestId,readProof});release();
 const outcome=await Promise.allSettled([a,b]);assert.equal(outcome.filter(x=>x.status==='fulfilled').length,1);assert.equal(outcome.filter(x=>x.status==='rejected').length,1);assert.equal(journal.pending(sessionId).length,1);journal.close();
});
test('the owning in-flight render can be cancelled in the same call without unlocking it',async t=>{
 const f=await fixture(t),journal=await openMutationJournal(f.root);let rejectSend,cancelSends=0;
 f.call('render',1,'local_prepared_render');
 const pending=runDurableOwnedMutation({...f,journal,currentCallId:'render',toolName:'local_prepared_render',operation:'prepared-render',targetId:productionId,input:{workflowId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',expectedRevision:0,requestId},send:()=>new Promise((_,reject)=>{rejectSend=reject;}),readProof:async()=>{throw Error('unexpected read');}});
 while(!rejectSend)await new Promise(resolve=>setImmediate(resolve));
 const cancelBody={requestId:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'},stamp='2026-11-05T00:00:00.000Z',cancelProduction={...f.production,cancelRequested:true,cancelRequestedAt:stamp,revision:1},receipt={requestId:cancelBody.requestId,sessionId,productionId,operation:'cancel',payloadHash:digest(cancelBody),previousRevision:0,productionRevision:1,disposition:'accepted',acceptedAt:stamp,cancelRequestedAt:stamp},cancelResult={production:cancelProduction,receipt};
 await assert.rejects(runDurableCancellation({...f,journal,currentCallId:'render',toolName:'local_prepared_render',targetId:'ffffffff-ffff-4fff-8fff-ffffffffffff',input:cancelBody,send:async()=>{cancelSends++;},readProof:async()=>cancelResult}),/parent or owned target differs/);
 const cancelled=await runDurableCancellation({...f,journal,currentCallId:'render',toolName:'local_prepared_render',targetId:productionId,input:cancelBody,send:async()=>{cancelSends++;return cancelResult;},readProof:async()=>cancelResult});
 assert.equal(cancelSends,1);assert.equal(journal.pending(sessionId).length,2);assert.equal(journal.get(sessionId,cancelled.journalReceipt.id).lane,'cancel');
 rejectSend(Error('render response lost'));await assert.rejects(pending,/response lost/);
 assert.equal(journal.pending(sessionId).length,2);journal.close();
});
