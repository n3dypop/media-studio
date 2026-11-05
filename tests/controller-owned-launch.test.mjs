import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {RunStore} from '../apps/controller/store.mjs';
import {ProductionStore} from '../apps/controller/productions.mjs';
import {createControllerServer} from '../apps/controller/http.mjs';
import {scheduleOwnedLaunch,recordOwnedLaunchFailure} from '../apps/controller/owned-launch.mjs';
import {RunEngine} from '../apps/controller/engine.mjs';
import {MossPeCoordinator} from '../apps/controller/moss-pe-controller.mjs';

const profile='moss-image-sft-int8-v1';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const createRun=store=>store.create({requestId:randomUUID(),spec:{modelProfile:profile}},{decorate:()=>({sessionId:'owner',productionId:randomUUID()})}).run;

for(const asynchronous of [false,true])test(`owned launch ${asynchronous?'rejected promise':'synchronous exception'} retains a recoverable run`,async t=>{
  const store=new RunStore(':memory:');t.after(()=>store.close());const run=createRun(store);
  scheduleOwnedLaunch({store,run,launch:()=>{if(asynchronous)return Promise.reject(Error('injected'));throw Error('injected');}});
  await tick();const result=store.get(run.id);
  assert.equal(result.phase,'needs_attention');assert.equal(result.cancelRequested,false);
  assert.equal(store.active().id,run.id);assert.equal(store.events(run.id).at(-1).type,'deferred_launch_failed');
});

test('late launch failure cannot rewrite completed or differently owned records',async t=>{
  const store=new RunStore(':memory:');t.after(()=>store.close());const run=createRun(store);
  assert.equal(store.markLaunchFailure({...run,sessionId:'different'}),false);
  store.update(run.id,{phase:'completed'});
  scheduleOwnedLaunch({store,run,launch:()=>Promise.reject(Error('late failure'))});
  await tick();assert.equal(store.get(run.id).phase,'completed');
  assert.equal(store.events(run.id).some(e=>e.type==='deferred_launch_failed'),false);
});

test('engine rejection handler does not rewrite a run completed while execution was in flight',async t=>{
  const store=new RunStore(':memory:');t.after(()=>store.close());const run=createRun(store);
  const engine=new RunEngine({store,adapter:{},outputRoot:'unused'});
  let reject;engine.execute=()=>new Promise((_resolve,fail)=>{reject=fail;});
  const pending=engine.launch(run.id);store.update(run.id,{phase:'completed'});reject(Error('late failure'));
  await pending;assert.equal(store.get(run.id).phase,'completed');assert.equal(engine.work.has(run.id),false);
});

test('a changed effective spec is not mistaken for a changed run owner',async t=>{
  const store=new RunStore(':memory:');t.after(()=>store.close());const run=createRun(store);
  const engine=new RunEngine({store,adapter:{},outputRoot:'unused'});let reject;
  engine.execute=()=>new Promise((_resolve,fail)=>{reject=fail;});const pending=engine.launch(run.id);
  store.update(run.id,{specHash:'new-effective-spec-hash'});reject(Error('late failure'));await pending;
  assert.equal(store.get(run.id).phase,'needs_attention');
});

test('owner mismatch preserves the run and emits a generic diagnostic',t=>{
  const store=new RunStore(':memory:');t.after(()=>store.close());const run=createRun(store);const original=console.error;const logs=[];
  console.error=message=>logs.push(message);
  try {recordOwnedLaunchFailure(store,{...run,sessionId:'different'});} finally {console.error=original;}
  assert.equal(store.get(run.id).phase,'queued');assert.equal(logs.length,1);
  assert.equal(logs[0],'Owned run launch or execution failed; durable status could not be updated.');
});

test('a terminal run with different ownership still emits a generic diagnostic',t=>{
  const store=new RunStore(':memory:');t.after(()=>store.close());const run=createRun(store);
  store.update(run.id,{phase:'completed',sessionId:'other-owner'});const logs=[],original=console.error;
  console.error=message=>logs.push(message);try{recordOwnedLaunchFailure(store,run);}finally{console.error=original;}
  assert.equal(store.get(run.id).phase,'completed');assert.equal(logs.length,1);
});

test('synchronous engine execute failure clears work and holds the owned run',async t=>{
  const store=new RunStore(':memory:');t.after(()=>store.close());const run=createRun(store);
  const engine=new RunEngine({store,adapter:{},outputRoot:'unused'});engine.execute=()=>{throw Error('injected');};
  await engine.launch(run.id);assert.equal(engine.work.has(run.id),false);assert.equal(store.get(run.id).phase,'needs_attention');
});

test('synchronous PE execute failure clears work and preserves resource hold',async t=>{
  const store=new RunStore(':memory:');t.after(()=>store.close());const run=createRun(store);
  const pe=Object.assign(Object.create(MossPeCoordinator.prototype),{store,work:new Set(),gate:{status:()=>({blocked:true})},family:'moss',stateKey:'mossPe'});
  pe.execute=()=>{throw Error('injected');};await pe.launch(run.id);
  assert.equal(pe.work.has(run.id),false);assert.equal(store.get(run.id).phase,'needs_attention');
});

test('failure to record the failure never escapes the asynchronous callback',async()=>{
  const original=console.error;let logs=0;console.error=()=>{logs++};
  try{scheduleOwnedLaunch({store:{markLaunchFailure(){throw Error('database unavailable');}},run:{id:'r',requestId:'q',controllerId:'c'},launch:()=>{throw Error('launch');}});await tick();assert.equal(logs,1);}
  finally{console.error=original;}
});

test('real HTTP cancellation responds and a failed deferred recovery keeps the owned run blocked',async t=>{
  const store=new RunStore(':memory:'),productions=new ProductionStore(store),session='fixture-session';
  const p=productions.create(session,{requestId:randomUUID(),modelProfile:profile,brief:{request:'test',criteria:[{id:'C1',description:'test'}],invariants:[]}}).production;
  const run=store.create({requestId:randomUUID(),spec:{modelProfile:profile}},{decorate:()=>({productionId:p.id,sessionId:session})}).run;
  const holder=createServer();await new Promise(ok=>holder.listen(0,'127.0.0.1',ok));const port=holder.address().port;await new Promise(ok=>holder.close(ok));
  const engine={work:new Set(),launch(){throw Error('injected deferred failure');}};
  const server=createControllerServer({store,productions,workflows:{},engine,token:'admin-test',dshToken:'fixture-token',port,profile});
  await new Promise((ok,fail)=>server.once('error',fail).listen(port,'127.0.0.1',ok));
  t.after(async()=>{server.closeAllConnections();await new Promise(ok=>server.close(ok));store.close();});
  const response=await fetch(`http://127.0.0.1:${port}/api/runs/${run.id}/cancel`,{method:'POST',headers:{Authorization:'Bearer admin-test','Content-Type':'application/json'},body:'{}'});
  assert.equal(response.status,202);await tick();const actual=store.get(run.id);
  assert.equal(actual.cancelRequested,true);assert.equal(actual.phase,'needs_attention');assert.equal(store.active().id,run.id);
});
