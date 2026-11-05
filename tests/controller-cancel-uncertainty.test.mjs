import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,rm,realpath} from 'node:fs/promises';
import {join,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {ApiError,RunStore} from '../apps/controller/store.mjs';
import {ProductionStore} from '../apps/controller/productions.mjs';
import {createControllerServer} from '../apps/controller/http.mjs';
import {openMutationJournal} from '../apps/dsh-plugins/local-genai/durable-journal.mjs';
import {runDurableCancellation,runDurableOwnedMutation,reconcileDurableOwnedMutation} from '../apps/dsh-plugins/local-genai/durable-coordinator.mjs';

const profile='moss-image-sft-int8-v1',session='fixture-session';
async function fixture(t,{mossPe,search}={}){
  const store=new RunStore(':memory:'),productions=new ProductionStore(store);
  const p=productions.create(session,{requestId:randomUUID(),modelProfile:profile,brief:{request:'test',criteria:[{id:'C1',description:'test'}],invariants:[]}}).production;
  const hold=createServer();await new Promise(ok=>hold.listen(0,'127.0.0.1',ok));const port=hold.address().port;await new Promise(ok=>hold.close(ok));
  const engine={work:new Set(),launch(){throw Error('unexpected background execution');}};
  const server=createControllerServer({store,productions,workflows:{},engine,token:'admin-test-token',dshToken:'synthetic-only',port,profile,mossPe,search});
  await new Promise((ok,fail)=>server.once('error',fail).listen(port,'127.0.0.1',ok));
  t.after(async()=>{server.closeAllConnections();await new Promise(ok=>server.close(ok));store.close();});
  const root=`http://127.0.0.1:${port}`;
  const post=(path,body,admin=false)=>fetch(root+path,{method:'POST',headers:{Authorization:'Bearer '+(admin?'admin-test-token':'synthetic-only'),'X-DSH-Session':session,'Content-Type':'application/json'},body:JSON.stringify(body)});
  return {store,productions,p,post,root,engine};
}
const error409=()=>new ApiError(409,'injected cleanup conflict');

for(const action of ['cancel','cancel-owned'])test(`${action}: post-commit 4xx cleanup errors become unknown`,async t=>{
  const f=await fixture(t,{mossPe:{cancelProduction(){throw error409();},work:new Set()}});
  const body=action==='cancel-owned'?{expectedRevision:0,expectedRunId:null}:{};
  const response=await f.post(`/api/productions/${f.p.id}/${action}`,body,action==='cancel-owned');
  assert.equal(response.status,503);assert.equal(f.productions.get(f.p.id,session).cancelRequested,true);
});

test('post-commit abortSession 4xx remains unknown after production cancellation',async t=>{
  const f=await fixture(t,{search:{validateStopTurn(){},cancelSession(){throw error409();}}});
  const response=await f.post(`/api/productions/${f.p.id}/cancel`,{});
  assert.equal(response.status,503);assert.equal(f.productions.get(f.p.id,session).cancelRequested,true);
});

test('pre-commit invalid target and revision remain definite 4xx without mutation',async t=>{
  const f=await fixture(t);
  const bad=await f.post(`/api/productions/${f.p.id}/cancel`,{expectedRunId:null,expectedRevision:0});assert.equal(bad.status,400);
  const conflict=await f.post(`/api/productions/${f.p.id}/cancel-owned`,{expectedRunId:null,expectedRevision:9},true);assert.equal(conflict.status,409);
  assert.equal(f.productions.get(f.p.id,session).cancelRequested,false);
});

test('DSH marks a post-commit cleanup error unresolved and blocks a new production',async t=>{
  const f=await fixture(t,{mossPe:{cancelProduction(){throw error409();},work:new Set()}}),base=await realpath(tmpdir()),root=await mkdtemp(join(base,'cancel-uncertainty-'));assert.ok(root.startsWith(base+sep));await mkdir(join(root,'data'));let journal=await openMutationJournal(root);t.after(async()=>{journal.close();assert.equal(await realpath(root),root);assert.ok(root.startsWith(base+sep));await rm(root,{recursive:true,force:true});});
  const events=[],owner={id:session,surface:{nodes:[]},snapshotEvents:()=>events,deriveMessages:()=>[]},sessions={flush:async()=>true},persistence={flush:async()=>{},open:async(id,access)=>({id,access,read:async seq=>({events:events.filter(x=>x.seq===seq)}),close:async()=>{}})},common={journal,session:owner,sessions,persistence,mapSessionId:id=>id,wireProof:async()=>true};let step=0;const call=name=>{const callId=`review-${++step}`;events.push({seq:events.length,type:'tool/call',data:{callId,name,turn:1,step}});return callId;},id=randomUUID(),input={requestId:id};
  await assert.rejects(runDurableCancellation({...common,currentCallId:call('local_production_cancel'),toolName:'local_production_cancel',targetId:f.p.id,input,send:async()=>{const response=await f.post(`/api/productions/${f.p.id}/cancel`,input);assert.equal(response.status,503);throw Error('HTTP 503: cleanup outcome unknown');},readProof:async()=>{throw Error('must not read');}}),/HTTP 503/);
  assert.equal(f.productions.get(f.p.id,session).cancelRequested,true);
  journal.close();journal=await openMutationJournal(root);common.journal=journal;
  await assert.rejects(runDurableOwnedMutation({...common,currentCallId:call('local_production_create'),toolName:'local_production_create',operation:'create',input:{requestId:randomUUID()},correlationHash:'a'.repeat(64),send:async()=>{throw Error('must not send');},readProof:async()=>{throw Error('must not read');}}),/unresolved|pending|open|UNIQUE/i);
  const readProof=async()=>{const response=await fetch(`${f.root}/api/productions/${f.p.id}/cancel-by-request?${new URLSearchParams({requestId:id})}`,{headers:{Authorization:'Bearer synthetic-only','X-DSH-Session':session}});assert.equal(response.status,200);return response.json();};
  const recovered=await reconcileDurableOwnedMutation({...common,currentCallId:call('local_cancel_reconcile'),toolName:'local_cancel_reconcile',operation:'cancel',targetId:f.p.id,requestId:id,readProof});assert.equal(recovered.value.receipt.disposition,'accepted');assert.equal(journal.pending(session)[0].state,'receipt');
  // The cancellation receipt proves acceptance only, not cleanup, process exit or GPU release.
});

test('admin run cancellation: post-commit 4xx cleanup failures remain unknown',async t=>{
  const f=await fixture(t,{search:{validateStopTurn(){},cancelSession(){throw error409();}}});
  const created=f.store.create({requestId:randomUUID(),spec:{modelProfile:profile}},{decorate:()=>({productionId:f.p.id,sessionId:session})}).run;
  f.engine.work.add(created.id);
  const response=await f.post(`/api/runs/${created.id}/cancel`,{},true);
  assert.equal(response.status,503);assert.equal(f.productions.get(f.p.id,session).cancelRequested,true);assert.equal(f.store.get(created.id).cancelRequested,true);
});

test('admin run cancellation: rejection before mutation remains 4xx',async t=>{
  const f=await fixture(t,{search:{validateStopTurn(){throw error409();}}});
  const created=f.store.create({requestId:randomUUID(),spec:{modelProfile:profile}},{decorate:()=>({productionId:f.p.id,sessionId:session})}).run;
  const response=await f.post(`/api/runs/${created.id}/cancel`,{},true);
  assert.equal(response.status,409);assert.equal(f.productions.get(f.p.id,session).cancelRequested,false);assert.equal(f.store.get(created.id).cancelRequested,false);
});
