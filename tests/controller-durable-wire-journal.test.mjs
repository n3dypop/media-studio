import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openMutationJournal} from '../apps/dsh-plugins/local-genai/durable-journal.mjs';
import {DurableWireJournalReader} from '../apps/controller/durable-wire-journal.mjs';
import {DurableWireStore} from '../apps/controller/durable-wire-store.mjs';
import {RunStore} from '../apps/controller/store.mjs';
import {relayAttestedSse} from '../apps/controller/durable-wire-transport.mjs';

const hash=x=>createHash('sha256').update(x).digest('hex');
const message=(call,proof)=>[{role:'assistant',tool_calls:[{id:call}]},{role:'tool',tool_call_id:call,content:JSON.stringify({journalReceipt:proof})}];
const event=x=>'data: '+JSON.stringify(x)+'\n\n';
const raw=event({choices:[{index:0,delta:{content:'early'},finish_reason:null}]})+event({choices:[{index:0,delta:{tool_calls:[{index:0,id:'next'}]},finish_reason:null}]})+event({choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})+'data: [DONE]\n\n';
test('current owned journal filters stale, forged and over-16 historical proofs while preserving streamed output',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-wire-fixture-'));await mkdir(join(root,'data'));
 const journal=await openMutationJournal(root),reader=new DurableWireJournalReader(root),store=new RunStore(':memory:'),wireStore=new DurableWireStore(store),sessionId='web:fixture';
 try{
  const messages=[],receipts=[];
  for(let i=0;i<20;i++){
   const call='call-'+i,id=randomUUID(),begun=journal.begin({sessionId,lane:'cancel',operation:'cancel',requestId:randomUUID(),inputHash:hash('input-'+i),targetId:id,callIdHash:hash(call),toolName:'local_cancel',turn:1,step:i+1});
   const {ackNonce}=journal.recordReceipt({sessionId,id:begun.id,receiptHash:hash('receipt-'+i),source:'controller-response',outcome:'applied'});
   const proof={id:begun.id,receiptHash:hash('receipt-'+i),ackNonce};receipts.push(proof);messages.push(...message(call,proof));
  }
  // Stale and forged entries never contribute even when they precede valid entries.
  messages.unshift(...message('stale',{...receipts[0],ackNonce:'x'.repeat(43)}));
  assert.equal(reader.collect(sessionId,messages).length,20);assert.equal(reader.collect('desktop:fixture',messages).length,0);
  let text='';const upstream=new Response(raw,{headers:{'Content-Type':'text/event-stream'}});
  const result=await relayAttestedSse({sessionId,input:{messages},upstream,wireStore,readReceipts:({sessionId,messages})=>reader.collect(sessionId,messages),write:async x=>{text+=x.toString();}});
  assert.equal(text,raw);assert.equal(result.proofRecorded,true);
  for(let i=0;i<20;i++)assert.equal(wireStore.has({sessionId,intentId:receipts[i].id,receiptHash:receipts[i].receiptHash,receiptNonceHash:hash(receipts[i].ackNonce),priorCallIdHash:hash('call-'+i),nextCallIdHash:hash('next')}),true);
  journal.acknowledge({sessionId,id:receipts[0].id,receiptHash:receipts[0].receiptHash,ackNonce:receipts[0].ackNonce});assert.equal(reader.collect(sessionId,messages).length,19);
 }finally{journal.close();store.close();await rm(root,{recursive:true,force:true});}
});
test('corrupt journal and missing state never become delivery evidence',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-wire-corrupt-'));await mkdir(join(root,'data','dsh-mutations'),{recursive:true});
 try{await writeFile(join(root,'data','dsh-mutations','intents.sqlite'),'broken');assert.throws(()=>new DurableWireJournalReader(root).collect('web:fixture',[]));}
 finally{await rm(root,{recursive:true,force:true});}
});
test('rebound receipt supersedes a previously observed call and nonce',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-wire-rebind-'));await mkdir(join(root,'data'));const journal=await openMutationJournal(root),reader=new DurableWireJournalReader(root),sessionId='web:fixture',requestId=randomUUID(),targetId=randomUUID(),inputHash=hash('input'),receiptHash=hash('receipt');
 try{
  const original=journal.begin({sessionId,lane:'cancel',operation:'cancel',requestId,inputHash,targetId,callIdHash:hash('old'),toolName:'local_cancel',turn:1,step:1});
  const first=journal.recordReceipt({sessionId,id:original.id,receiptHash,source:'controller-response',outcome:'applied'}),old={id:original.id,receiptHash,ackNonce:first.ackNonce};
  assert.equal(reader.collect(sessionId,message('old',old)).length,1);
  const rebound=journal.bindReconciledReceipt({sessionId,id:original.id,requestId,inputHash,operation:'cancel',targetId,receiptHash,previousReceiptHash:receiptHash,previousDeliveryCallIdHash:null,source:'verified-controller-read',outcome:'applied',callIdHash:hash('new'),toolName:'local_cancel_reconcile',turn:2,step:1});
  const current={id:original.id,receiptHash,ackNonce:rebound.ackNonce},both=[...message('old',old),...message('new',current)];
  assert.equal(reader.collect(sessionId,both).length,1);assert.equal(reader.collect(sessionId,both)[0].priorCallIdHash,hash('new'));
  assert.throws(()=>journal.acknowledge({sessionId,...old}));journal.acknowledge({sessionId,...current});assert.equal(reader.collect(sessionId,both).length,0);
 }finally{journal.close();await rm(root,{recursive:true,force:true});}
});
