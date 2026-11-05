import test from 'node:test';
import assert from 'node:assert/strict';
import { ResourceGate } from '../apps/controller/resource-gate.mjs';

function fixture(options={}) {
  const f={free:0,loaded:false,started:123,inFlight:0,loads:0,preflights:0,states:[]};
  const strata={
    status:async()=>({started:f.started,loaded:f.loaded,activity:{in_flight:f.inFlight},vision:{enabled:true,available:true,error:null}}),
    load:async()=>{f.loads++;f.loaded=true;},
  };
  const beforeCoreLoad=async()=>{f.preflights++;};
  const onState=async state=>f.states.push(structuredClone(state));
  f.gate=new ResourceGate({strata,observeResources:async()=>({freeBytes:f.free}),beforeCoreLoad,onState,
    minFreeBytes:100,minCoreFreeBytes:100,stableSamples:1,intervalMs:2,resourceTimeoutMs:15,...options});
  return f;
}

test('known shortage before load returns to durable idle after ownership and epoch recheck',async()=>{
  const f=fixture();await f.gate.initialize();
  await assert.rejects(f.gate.acquireCore(),{code:'RESOURCES_BUSY'});
  assert.equal(f.loads,0);assert.equal(f.preflights,1);
  assert.equal(f.gate.status().owner,'none');assert.equal(f.gate.status().blocked,false);
  assert.equal(f.states.at(-1).owner,'none');assert.equal(f.states.at(-1).blocked,false);
  const restarted=fixture();restarted.free=200;
  await restarted.gate.initialize({previousState:f.states.at(-1)});
  assert.equal(restarted.gate.status().owner,'none');assert.equal(restarted.gate.status().blocked,false);
  const afterRestart=await restarted.gate.acquireCore();await afterRestart();assert.equal(restarted.loads,1);
  f.free=200;const release=await f.gate.acquireCore();
  assert.equal(f.loads,1);assert.equal(f.preflights,2);assert.equal(f.gate.status().owner,'core');
  await release();
});

test('no explicit Comfy preflight cannot establish a safe recovery',async()=>{
  const f=fixture({beforeCoreLoad:null});await f.gate.initialize();
  await assert.rejects(f.gate.acquireCore(),{code:'RESOURCES_BUSY'});
  assert.equal(f.loads,0);assert.equal(f.gate.status().owner,'unknown');assert.equal(f.gate.status().blocked,true);
});

test('foreign work, changed epoch, loaded core, or active inference preserve blocked ownership',async t=>{
  for(const name of ['foreign-comfy','changed-epoch','loaded','in-flight','status-unavailable']) await t.test(name,async()=>{
    let f;
    f=fixture({beforeCoreLoad:async()=>{
      if(name==='foreign-comfy')throw Error('foreign Comfy work');
      if(name==='changed-epoch')f.started++;
      if(name==='loaded')f.loaded=true;
      if(name==='in-flight')f.inFlight=1;
      if(name==='status-unavailable')f.gate.strata.status=async()=>{throw Error('status unavailable');};
    }});
    await f.gate.initialize();await assert.rejects(f.gate.acquireCore());
    assert.equal(f.loads,0);assert.equal(f.gate.status().owner,'unknown');assert.equal(f.gate.status().blocked,true);
  });
});

test('unknown or timed-out resource observation remains blocked without a model load',async()=>{
  for(const observeResources of [async()=>({freeBytes:NaN}),async()=>new Promise(()=>{}),async()=>{throw Object.assign(Error('observer failed'),{code:'RESOURCES_BUSY'});}]){
    const f=fixture({observeResources});await f.gate.initialize();
    const hold=setTimeout(()=>{},100);
    try{await assert.rejects(f.gate.acquireCore());}finally{clearTimeout(hold);}
    assert.equal(f.loads,0);assert.equal(f.preflights,0);assert.equal(f.gate.status().blocked,true);
  }
});

test('failed durable reopening remains blocked and cannot issue a model load',async()=>{
  let writes=0;const f=fixture({onState:async()=>{if(++writes>=3)throw Error('journal unavailable');}});
  await f.gate.initialize();await assert.rejects(f.gate.acquireCore(),/journal unavailable/);
  assert.equal(f.loads,0);assert.equal(f.gate.status().blocked,true);assert.equal(f.gate.status().owner,'unknown');
});

test('a load request with unknown outcome remains blocked and is not retried',async()=>{
  const f=fixture();f.free=200;f.gate.strata.load=async()=>{f.loads++;throw Error('lost load response');};
  await f.gate.initialize();await assert.rejects(f.gate.acquireCore(),/lost load response/);
  assert.equal(f.gate.status().owner,'unknown');assert.equal(f.gate.status().blocked,true);assert.equal(f.loads,1);
  await assert.rejects(f.gate.acquireCore(),{code:'GPU_GATE_BLOCKED'});assert.equal(f.loads,1);
});

test('caller cancellation during resource observation fails closed',async()=>{
  const cancel=new AbortController();const f=fixture({observeResources:async()=>{cancel.abort(Error('cancelled'));return {freeBytes:0};}});
  await f.gate.initialize();await assert.rejects(f.gate.acquireCore(cancel.signal),/cancelled/);
  assert.equal(f.loads,0);assert.equal(f.preflights,0);assert.equal(f.gate.status().blocked,true);
});
