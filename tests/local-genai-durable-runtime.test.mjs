import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readdir,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createDurableRuntime} from '../apps/dsh-plugins/local-genai/durable-runtime.mjs';
import {openMutationJournal} from '../apps/dsh-plugins/local-genai/durable-journal.mjs';
import {observeScopeFeature,resetScopeFeature} from '../apps/dsh-plugins/local-genai/scope-feature.mjs';

test('oversized or structurally unaddressable workflow is rejected before journal admission and HTTP',async()=>{
 const root=await mkdtemp(join(tmpdir(),'durable-preflight-'));await mkdir(join(root,'data'));let sent=0;
 const runtime=await createDurableRuntime({root,ctx:{sessions:{},sessionPersistence:{}},sessionIdentity:()=> 'owner',mapSessionId:x=>x,request:async()=>{sent++;},requestIdFor:()=>randomUUID(),expectedCreateBrief:()=>({}),errorFactory:(message,options)=>Object.assign(Error(message),options)}),requestId=randomUUID(),productionId=randomUUID(),exec={callId:'fixture',signal:new AbortController().signal,agent:{session:{id:'owner'}}};
 try{for(const body of [{requestId,productionId,expectedRevision:-1},{requestId,productionId,expectedRevision:0,graph:{text:'x'.repeat(131072)}},{requestId,productionId:'not-a-uuid',expectedRevision:0},{requestId,productionId:'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',expectedRevision:0}])await assert.rejects(runtime.mutate('/api/workflows/draft',body,exec),/no operation was sent/);
  assert.equal(sent,0);const journal=await openMutationJournal(root);try{assert.deepEqual(journal.pending('owner'),[]);}finally{journal.close();}
 }finally{runtime.close();await rm(root,{recursive:true,force:true});}
});

test('disabled PE without a rejection receipt keeps the original journal intent unresolved',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pe-missing-evidence-'));await mkdir(join(root,'data'));
 const requestId=randomUUID(),targetId=randomUUID(),sessionId='owner',callId='reconcile',events=[{type:'tool/call',data:{callId,name:'local_pe_receipt_reconcile',turn:1,step:2}}],session={id:sessionId,snapshotEvents:()=>events};
 let journal=await openMutationJournal(root),runtime;
 try{
  journal.begin({sessionId,lane:'normal',operation:'moss-pe-start',requestId,inputHash:'a'.repeat(64),targetId,callIdHash:createHash('sha256').update('initial').digest('hex'),toolName:'local_moss_pe_start',turn:1,step:1});journal.close();
  const paths=[];observeScopeFeature(sessionId,'synthetic-managed-scope');runtime=await createDurableRuntime({root,ctx:{sessions:{},sessionPersistence:{}},sessionIdentity:()=>sessionId,mapSessionId:x=>x,request:async path=>{paths.push(path);throw Object.assign(Error('fixture'),{status:path.startsWith('/api/moss-pe')?503:404});},requestIdFor:()=>randomUUID(),expectedCreateBrief:()=>({}),errorFactory:(message,options)=>Object.assign(Error(message),options)});
  await assert.rejects(runtime.reconcile({operation:'moss-pe-start',targetId,requestId,exec:{callId,name:'local_pe_receipt_reconcile',agent:{session}}}),/fixture/);
  assert.equal(paths.length,2);assert.match(paths[1],/^\/api\/productions\/mutation-rejections\/by-request\?/);
  runtime.close();runtime=null;journal=await openMutationJournal(root);assert.deepEqual(journal.pending(sessionId).map(x=>x.state),['intent']);
 }finally{
  resetScopeFeature(sessionId);runtime?.close();journal.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));
  async function noLinks(path){for(const entry of await readdir(path,{withFileTypes:true})){const child=join(path,entry.name),info=await lstat(child);assert.equal(info.isSymbolicLink(),false);if(info.isDirectory())await noLinks(child);}}
  await noLinks(root);await rm(root,{recursive:true});
 }
});

test('pending discovery is session-scoped, minimal, read-only and includes normal and cancellation delivery calls',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pending-discovery-'));await mkdir(join(root,'data'));
 const hash=x=>createHash('sha256').update(x).digest('hex'),targetId=randomUUID(),requestId=randomUUID(),cancelId=randomUUID(),call='source',sessionId='owner';
 let journal=await openMutationJournal(root),runtime;
 try{
  const parent=journal.begin({sessionId,lane:'normal',operation:'prepared-render',requestId,inputHash:'a'.repeat(64),targetId,callIdHash:hash(call),toolName:'local_prepared_render',turn:1,step:1});
  journal.begin({sessionId,lane:'cancel',operation:'cancel',requestId:cancelId,inputHash:'b'.repeat(64),targetId,callIdHash:hash(call),toolName:'local_prepared_render',turn:1,step:1,parentIntentId:parent.id});
  journal.recordReceipt({sessionId,id:parent.id,receiptHash:'c'.repeat(64),source:'verified-controller-read',outcome:'applied'});
  journal.bindReconciledReceipt({sessionId,id:parent.id,requestId,inputHash:'a'.repeat(64),operation:'prepared-render',targetId,receiptHash:'c'.repeat(64),previousReceiptHash:'c'.repeat(64),source:'verified-controller-read',outcome:'applied',callIdHash:hash('recover'),toolName:'local_render_reconcile',turn:2,step:1});
  journal.begin({sessionId:'desktop:owner',lane:'normal',operation:'create',requestId:randomUUID(),inputHash:'d'.repeat(64),targetId:null,callIdHash:hash('desktop'),toolName:'local_production_create',turn:1,step:1});journal.close();journal=null;
  for(const id of ['owner','desktop:owner','other'])observeScopeFeature(id,'synthetic-managed-scope');
  runtime=await createDurableRuntime({root,ctx:{sessions:{},sessionPersistence:{}},sessionIdentity:exec=>exec.owner,mapSessionId:x=>x,request:async()=>{throw Error('must not call HTTP');},requestIdFor:()=>randomUUID(),expectedCreateBrief:()=>({}),errorFactory:(message,options)=>Object.assign(Error(message),options)});
  const list=runtime.pending({owner:sessionId,callId:'list'});assert.deepEqual(list,[{operation:'prepared-render',requestId,targetId,phase:'receipt'},{operation:'cancel',requestId:cancelId,targetId,phase:'intent'}]);
  assert.deepEqual(runtime.pending({owner:sessionId,callId:'recover'},{currentCallOnly:true}),[list[0]]);
  assert.deepEqual(runtime.pending({owner:sessionId,callId:call},{currentCallOnly:true}),list);
  assert.deepEqual(runtime.pending({owner:'other',callId:'list'}),[]);
  const desktop=runtime.pending({owner:'desktop:owner',callId:'list'});assert.equal(desktop.length,1);assert.equal(desktop[0].operation,'create');assert.notEqual(desktop[0].requestId,requestId);
  runtime.close();runtime=null;journal=await openMutationJournal(root);assert.equal(journal.pending(sessionId).length,2);
 }finally{for(const id of ['owner','desktop:owner','other'])resetScopeFeature(id);runtime?.close();journal?.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));async function noLinks(path){for(const entry of await readdir(path,{withFileTypes:true})){const child=join(path,entry.name),info=await lstat(child);assert.equal(info.isSymbolicLink(),false);if(info.isDirectory())await noLinks(child);}}await noLinks(root);await rm(root,{recursive:true});}
});
