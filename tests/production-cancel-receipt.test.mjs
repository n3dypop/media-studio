import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createServer as reservePort} from 'node:net';
import {RunStore,ApiError,digest} from '../apps/controller/store.mjs';
import {ProductionStore} from '../apps/controller/productions.mjs';
import {createControllerServer} from '../apps/controller/http.mjs';

const session='cancel-receipt-session',profile='moss-image-sft-int8-v1';
async function fixture(t,{failCleanup=false,onCleanup=()=>{}}={}) {
  const dir=await mkdtemp(join(tmpdir(),'cancel-receipt-')),db=join(dir,'controller.sqlite');
  const store=new RunStore(db),productions=new ProductionStore(store);
  const p=productions.create(session,{requestId:randomUUID(),modelProfile:profile,brief:{request:'portrait',criteria:[{id:'C1',description:'portrait'}],invariants:[]}}).production;
  const run=store.create({requestId:randomUUID(),spec:{modelProfile:profile}},{decorate:()=>({sessionId:session,productionId:p.id})}).run;
  store.transaction(()=>{p.attempts.push(run.id);p.latestRunId=run.id;p.phase='generating';productions.write(p,'fixture_attempt');});
  const engine={work:new Set([run.id]),launch(){throw Error('Unexpected launch');}};
  let cleanups=0;const mossPe={work:new Set(),cancelProduction(){cleanups++;onCleanup();if(failCleanup)throw new ApiError(409,'fixture cleanup failure');}};
  const holder=reservePort();await new Promise(ok=>holder.listen(0,'127.0.0.1',ok));const port=holder.address().port;await new Promise(ok=>holder.close(ok));
  const server=createControllerServer({store,productions,workflows:{},engine,token:'admin-test-token',dshToken:'synthetic-only',port,profile,mossPe});
  await new Promise((ok,fail)=>server.once('error',fail).listen(port,'127.0.0.1',ok));
  const root=`http://127.0.0.1:${port}`,path=`/api/productions/${p.id}`;
  const post=(action,input,{owner=session,admin=false,signal}={})=>fetch(`${root}${path}/${action}`,{method:'POST',headers:{Authorization:'Bearer '+(admin?'admin-test-token':'synthetic-only'),'X-DSH-Session':owner,'Content-Type':'application/json'},body:JSON.stringify(input),signal});
  const get=(requestId,{owner=session,admin=false}={})=>fetch(`${root}${path}/cancel-by-request?${new URLSearchParams({requestId})}`,{headers:{Authorization:'Bearer '+(admin?'admin-test-token':'synthetic-only'),'X-DSH-Session':owner}});
  t.after(async()=>{server.closeAllConnections();await new Promise(ok=>server.close(ok));store.close();await rm(dir,{recursive:true,force:true});});
  return {p,run,store,productions,post,get,db,cleanups:()=>cleanups};
}

for(const operation of ['cancel','cancel-owned'])test(`${operation} records the exact acceptance atomically and replay never repeats cleanup`,async t=>{
  const f=await fixture(t),requestId=randomUUID(),input=operation==='cancel'?{requestId}:{requestId,expectedRunId:f.run.id,expectedRevision:0},admin=operation==='cancel-owned';
  const response=await f.post(operation,input,{admin});assert.equal(response.status,202);const out=await response.json();
  assert.equal(out.receipt.disposition,'accepted');assert.equal(out.receipt.operation,operation);assert.equal(out.receipt.payloadHash,digest(input));assert.equal(out.receipt.previousRevision,0);assert.equal(out.receipt.productionRevision,1);
  assert.equal(out.production.cancelRequested,true);assert.equal(f.store.get(f.run.id).cancelRequested,true);assert.equal(f.cleanups(),1);
  const read=await f.get(requestId,{admin});assert.equal(read.status,200);const saved=await read.json();assert.deepEqual(saved.receipt,out.receipt);assert.match(saved.guidance,/only the recorded cancellation request/i);assert.match(saved.guidance,/resource state separately/i);
  const replay=await f.post(operation,input,{admin});assert.equal(replay.status,200);assert.equal((await replay.json()).created,false);assert.equal(f.cleanups(),1);
  const different=await f.post(operation,{...input,expectedRevision:1},{admin});assert.equal(different.status,admin?409:503);assert.equal(f.cleanups(),1);
  assert.deepEqual((await (await f.get(requestId,{admin})).json()).receipt,out.receipt);
});

test('post-commit cleanup failure stays 503 and the same acceptance is recoverable without rerunning cleanup',async t=>{
  const f=await fixture(t,{failCleanup:true}),requestId=randomUUID(),input={requestId};
  assert.equal((await f.post('cancel',input)).status,503);assert.equal(f.cleanups(),1);
  const r=await f.get(requestId);assert.equal(r.status,200);const out=await r.json();assert.equal(out.receipt.disposition,'accepted');assert.equal(out.production.cancelRequested,true);
  assert.equal((await f.post('cancel',input)).status,200);assert.equal(f.cleanups(),1);
});

test('dropped HTTP response does not require resubmitting the accepted cancellation',async t=>{
  const abort=new AbortController(),f=await fixture(t,{onCleanup:()=>abort.abort()}),requestId=randomUUID();
  await assert.rejects(f.post('cancel',{requestId},{signal:abort.signal}));
  const response=await f.get(requestId);assert.equal(response.status,200);assert.equal((await response.json()).receipt.disposition,'accepted');assert.equal(f.cleanups(),1);
});

test('simultaneous same-ID requests commit one receipt and perform cleanup only once',async t=>{
  const f=await fixture(t),requestId=randomUUID(),responses=await Promise.all([f.post('cancel',{requestId}),f.post('cancel',{requestId})]);
  assert.deepEqual(responses.map(x=>x.status).sort(),[200,202]);assert.equal(f.cleanups(),1);
  const count=f.store.db.prepare('SELECT count(*) AS n FROM production_cancel_receipts').get().n;assert.equal(count,1);
});

test('missing, changed owner, duplicate parameters and different operation never prove cancellation',async t=>{
  const f=await fixture(t),requestId=randomUUID();assert.equal((await f.get(requestId)).status,404);
  assert.equal((await f.post('cancel',{requestId},{owner:'other-session'})).status,404);
  assert.equal((await f.post('cancel',{requestId})).status,202);
  assert.equal((await f.get(requestId,{owner:'other-session'})).status,404);
  assert.equal((await f.post('cancel-owned',{requestId,expectedRunId:f.run.id,expectedRevision:1},{admin:true})).status,409);
  assert.equal((await fetch(`http://127.0.0.1:${new URL((await f.get(requestId)).url).port}/api/productions/${f.p.id}/cancel-by-request?requestId=${requestId}&requestId=${requestId}`,{headers:{Authorization:'Bearer synthetic-only','X-DSH-Session':session}})).status,400);
  assert.equal(f.cleanups(),1);
});

test('receipt insert failure rolls back both production and run cancellation',async t=>{
  const f=await fixture(t);f.store.db.exec("CREATE TRIGGER fail_cancel_receipt BEFORE INSERT ON production_cancel_receipts BEGIN SELECT RAISE(ABORT,'injected'); END;");
  assert.equal((await f.post('cancel',{requestId:randomUUID()})).status,500);
  assert.equal(f.productions.get(f.p.id,session).cancelRequested,false);assert.equal(f.store.get(f.run.id).cancelRequested,false);assert.equal(f.cleanups(),0);
});

test('a run with a foreign owner is never cancelled even if a production lists it',async t=>{
  const f=await fixture(t),run=f.store.get(f.run.id);run.sessionId='foreign-session';
  f.store.db.prepare('UPDATE runs SET json=? WHERE id=?').run(JSON.stringify(run),run.id);
  const requestId=randomUUID();assert.equal((await f.post('cancel',{requestId})).status,409);
  assert.equal(f.store.get(run.id).cancelRequested,false);assert.equal(f.productions.get(f.p.id,session).cancelRequested,false);
  assert.equal((await f.get(requestId)).status,404);assert.equal(f.cleanups(),0);
});

test('receipt survives DB reopen and detects receipt or owner tampering',async t=>{
  const f=await fixture(t),requestId=randomUUID();assert.equal((await f.post('cancel',{requestId})).status,202);
  const otherStore=new RunStore(f.db),other=new ProductionStore(otherStore);
  try{assert.equal(other.findCancelByRequest(f.p.id,session,requestId).receipt.disposition,'accepted');
    other.db.prepare('UPDATE production_cancel_receipts SET receipt_hash=? WHERE request_id=?').run('0'.repeat(64),requestId);
    assert.throws(()=>other.findCancelByRequest(f.p.id,session,requestId),/一致しません/);
  }finally{otherStore.close();}
});

test('a separately requested cancellation is recorded as already requested and the old API still works',async t=>{
  const f=await fixture(t);assert.equal((await f.post('cancel',{})).status,202);
  const out=await (await f.post('cancel',{requestId:randomUUID()})).json();assert.equal(out.receipt.disposition,'already-requested');assert.equal(out.receipt.previousRevision,out.receipt.productionRevision);
});
