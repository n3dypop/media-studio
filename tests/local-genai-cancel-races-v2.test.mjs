// Durable coordinator tests with synthetic DSH events and receipts.  These do
// not assert process termination, GPU cleanup, or a real provider delivery.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,sep} from 'node:path';
import {openMutationJournal} from '../apps/dsh-plugins/local-genai/durable-journal.mjs';
import {runDurableOwnedMutation,runDurableCancellation,reconcileDurableOwnedMutation} from '../apps/dsh-plugins/local-genai/durable-coordinator.mjs';

const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const deferred=()=>{let resolve,reject;const promise=new Promise((ok,no)=>{resolve=ok;reject=no;});return {promise,resolve,reject};};
async function fixture(t){
 const base=await realpath(tmpdir()),root=await mkdtemp(join(base,'cancel-races-'));assert.ok(root.startsWith(base+sep));await mkdir(join(root,'data'));
 const journal=await openMutationJournal(root);t.after(async()=>{journal.close();assert.equal(await realpath(root),root);assert.ok(root.startsWith(base+sep));await rm(root,{recursive:true,force:true});});
 const sessionId='session',events=[],nodes=[],messages=[],session={id:sessionId,surface:{nodes},snapshotEvents:()=>events,deriveMessages:()=>messages};
 const sessions={flush:async()=>true},persistence={flush:async()=>{},open:async(id,access)=>({id,access,read:async seq=>({events:events.filter(x=>x.seq===seq)}),close:async()=>{}})};
 let seq=0;const call=name=>{const step=++seq,callId='call-'+step;events.push({seq:events.length,type:'assistant/message',data:{turn:1,step,message:{source:{kind:'model'},content:[{type:'tool-call',id:callId}]}}});events.push({seq:events.length,type:'tool/call',data:{callId,name,turn:1,step}});return callId;};
 const result=(callId,value)=>{const original=events.find(x=>x.type==='tool/call'&&x.data.callId===callId),text=JSON.stringify(value),index=events.length,step=original.data.step;events.push({seq:index,type:'tool/result',sourceEventSeqs:[original.seq],data:{turn:1,step,message:{role:'tool',toolCallId:callId,isError:false,source:{kind:'tool',callId},content:[{type:'text',text}]}}});nodes.push(index);messages.push({role:'tool',source:{kind:'tool',callId},toolCallId:callId,content:[{type:'text',text}]});};
 const productionId=randomUUID(),requestId=randomUUID(),brief={request:'portrait',criteria:[{id:'C1',description:'portrait'}],invariants:[],modelProfile:'moss-image-sft-int8-v1',mode:'t2i'},production={id:productionId,sessionId,requestId,brief,briefHash:digest(brief),revision:0,cancelRequested:false,workflowId:null,latestRunId:null,attempts:[]},input={requestId,brief},common={journal,session,sessions,persistence,mapSessionId:id=>id,wireProof:async()=>true};
 const start=(callId,send)=>runDurableOwnedMutation({...common,currentCallId:callId,toolName:'local_production_create',operation:'create',input,correlationHash:digest(brief),send,readProof:async()=>({productions:[production]})});
 const read=(callId,readProof)=>reconcileDurableOwnedMutation({...common,currentCallId:callId,toolName:'local_production_reconcile_create',operation:'create',requestId,readProof});
 const cancelInput={requestId:randomUUID()},stamp='2026-11-05T00:00:00.000Z',stopped={...production,revision:1,cancelRequested:true,cancelRequestedAt:stamp},cancelValue={production:stopped,receipt:{requestId:cancelInput.requestId,sessionId,productionId,operation:'cancel',payloadHash:digest(cancelInput),previousRevision:0,productionRevision:1,disposition:'accepted',acceptedAt:stamp,cancelRequestedAt:stamp}};
 const cancel=(callId,send)=>runDurableCancellation({...common,currentCallId:callId,toolName:'local_production_cancel',targetId:productionId,input:cancelInput,send,readProof:async()=>cancelValue});
 const next=()=>runDurableOwnedMutation({...common,currentCallId:call('local_production_create'),toolName:'local_production_create',operation:'create',input:{requestId:randomUUID(),brief},correlationHash:digest(brief),send:async()=>{throw Error('must not submit');},readProof:async()=>{throw Error('must not read');}});
 return {journal,call,result,production,productionId,start,read,cancel,cancelValue,next};
}

test('independent in-flight cancel keeps normal mutations blocked until both receipts are delivered',async t=>{
 const f=await fixture(t),createGate=deferred(),cancelGate=deferred(),createCall=f.call('local_production_create'),pending=f.start(createCall,()=>createGate.promise);
 while(f.journal.pending('session').length!==1)await new Promise(ok=>setImmediate(ok));
 const cancelCall=f.call('local_production_cancel'),stopping=f.cancel(cancelCall,()=>cancelGate.promise);
 while(f.journal.pending('session').length!==2)await new Promise(ok=>setImmediate(ok));
 createGate.resolve({production:f.production});const created=await pending;f.result(createCall,created);
 await assert.rejects(f.next(),/unresolved|receipt|result|delivery|unique/i);
 assert.deepEqual(f.journal.pending('session').map(x=>[x.lane,x.state]),[['cancel','intent']]);
 cancelGate.resolve(f.cancelValue);const cancelled=await stopping;f.result(cancelCall,cancelled);
 // The verified create was delivered, but the independent cancellation still
 // needs its own proof of delivery before normal work can resume.
 assert.deepEqual(f.journal.pending('session').map(x=>[x.lane,x.state]),[['cancel','receipt']]);
 await assert.rejects(f.next(),/must not submit/);
 // Delivery proofs were synthetic here; the only remaining intent is the
 // deliberately interrupted new request, not either earlier operation.
 assert.equal(f.journal.pending('session').length,1);assert.equal(f.journal.pending('session')[0].lane,'normal');
});

test('a concurrent cancel cannot be lost when a create reconciliation finishes first',async t=>{
 const f=await fixture(t),createCall=f.call('local_production_create');await assert.rejects(f.start(createCall,async()=>{throw Error('lost create');}),/lost create/);
 const readGate=deferred(),read=f.read(f.call('local_production_reconcile_create'),()=>readGate.promise),cancelGate=deferred(),stop=f.cancel(f.call('local_production_cancel'),()=>cancelGate.promise);
 while(f.journal.pending('session').length!==2)await new Promise(ok=>setImmediate(ok));
 readGate.resolve({productions:[f.production]});await read;
 assert.equal(f.journal.pending('session').find(x=>x.lane==='normal').state,'receipt');assert.equal(f.journal.pending('session').find(x=>x.lane==='cancel').state,'intent');
 await assert.rejects(f.next(),/unresolved|receipt|result|delivery|unique/i);
 cancelGate.resolve(f.cancelValue);await stop;assert.equal(f.journal.pending('session').length,2);
});

test('independent cancellation with unknown response survives successful create reconciliation',async t=>{
 const f=await fixture(t),createCall=f.call('local_production_create');await assert.rejects(f.start(createCall,async()=>{throw Error('lost create');}),/lost create/);
 await assert.rejects(f.cancel(f.call('local_production_cancel'),async()=>{throw Error('lost cancellation');}),/lost cancellation/);
 const reconciled=await f.read(f.call('local_production_reconcile_create'),async()=>({productions:[f.production]}));assert.equal(reconciled.value.productions[0].id,f.productionId);
 const pending=f.journal.pending('session');assert.equal(pending.length,2);assert.equal(pending.find(x=>x.lane==='cancel').state,'intent');await assert.rejects(f.next(),/unresolved|receipt|result|delivery|unique/i);
});
