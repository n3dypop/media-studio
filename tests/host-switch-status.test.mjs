import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { controllerSwitchStatus } from '../apps/controller/host-switch-status.mjs';
import { createControllerServer } from '../apps/controller/http.mjs';

function fixture() {
  return {
    controllerId:'fixture-controller',closing:false,mutations:0,resourceOperation:false,
    store:{controllerId:'fixture-controller',active:()=>null},engine:{work:new Set()},
    gate:{status:()=>({initialized:true,owner:'core',blocked:false,activeCore:0,generationRunId:null})},
    inferenceScope:null,inferenceBySession:new Map(),searches:new Set(),
    search:{active:new Map(),persistenceFault:false,list:()=>[]},
    mossPe:{work:new Set()},qwenPe:{work:new Set()},isIdle:()=>true,
  };
}
const status=overrides=>controllerSwitchStatus({...fixture(),...overrides});

test('idle means Controller-only snapshot and names every required external observation',()=>{
  const result=status({});
  assert.equal(result.state,'idle');assert.equal(result.scope,'controller-only');
  assert.deepEqual(result.busy,[]);assert.deepEqual(result.unknown,[]);
  assert.deepEqual(result.externalChecksRequired,['previous-host-exited','comfy-queue','strata-inference','service-operations']);
  assert.match(result.note,/does not freeze admission/);
});

test('queued, running, pending approval, inference and enhancement prevent an idle result',()=>{
  const base=fixture();
  const cases=[
    {mutations:1}, {resourceOperation:true}, {closing:true}, {isIdle:()=>false},
    {store:{active:()=>({phase:'queued',kind:'moss-pe'})}},
    {engine:{work:new Set(['job'])}}, {mossPe:{work:new Set(['job'])}}, {qwenPe:{work:new Set(['job'])}},
    {inferenceScope:{id:'fixture'}}, {inferenceBySession:new Map([['session',new Set()]])},
    {searches:new Set(['search'])}, {search:{...base.search,active:new Map([['id',{}]])}},
    ...['awaiting_approval','approved','running'].map(phase=>({search:{...base.search,list:()=>[{phase}]}})),
    {gate:{status:()=>({initialized:true,owner:'core',blocked:false,activeCore:1,generationRunId:null})}},
    {gate:{status:()=>({initialized:true,owner:'generator',blocked:false,activeCore:0,generationRunId:'job'})}},
  ];
  for(const change of cases){const result=status(change);assert.equal(result.state,'busy',JSON.stringify(change));assert.ok(result.busy.length);}
});

test('missing, corrupt, unavailable and unresolved evidence is unknown',()=>{
  const base=fixture();
  const cases=[
    {controllerId:''},{mutations:null},{store:{active:()=>undefined}},{store:{active:()=>{throw Error('bad ledger');}}},
    {engine:null},{mossPe:null},{qwenPe:null},{inferenceScope:undefined},{inferenceBySession:null},{searches:null},
    {search:{...base.search,persistenceFault:true}}, {search:{...base.search,list:()=>[{phase:'needs_attention'}]}},
    {search:{...base.search,list:()=>[{phase:'invalid'}]}}, {search:{...base.search,list:()=>null}},
    {gate:{status:()=>({initialized:true,owner:'unknown',blocked:true,activeCore:0,generationRunId:null})}},
    {gate:{status:()=>({initialized:false,owner:'core',blocked:false,activeCore:0,generationRunId:null})}},
    {isIdle:()=>undefined},
  ];
  for(const change of cases){const result=status(change);assert.equal(result.state,'unknown',JSON.stringify(change));assert.ok(result.unknown.length);}
});

test('a real HTTP listener restricts the snapshot to admin and observes an in-flight mutation', async t=>{
  const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const config=fixture(),server=createControllerServer({...config,token:'admin-token',dshToken:'dsh-token',port});
  await new Promise((resolve,reject)=>server.once('error',reject).listen(port,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const url=`http://127.0.0.1:${port}/api/host-switch-status`;
  assert.equal((await fetch(url)).status,401);
  assert.equal((await fetch(url,{headers:{Authorization:'Bearer dsh-token'}})).status,403);
  let response=await fetch(url,{headers:{Authorization:'Bearer admin-token'}});
  assert.equal(response.status,200);assert.equal((await response.json()).state,'idle');
  let finished;
  const result=new Promise((resolve,reject)=>{finished={resolve,reject};});
  const pending=request({host:'127.0.0.1',port,path:'/api/core-scope/start',method:'POST',headers:{Authorization:'Bearer dsh-token','Content-Type':'application/json','X-DSH-Session':'test-session'}},res=>{res.resume();res.once('end',()=>finished.resolve(res.statusCode));});
  pending.on('error',finished.reject);pending.flushHeaders();
  // The body has not been sent. Let the server admit the request before taking the snapshot.
  await new Promise(resolve=>setTimeout(resolve,50));
  response=await fetch(url,{headers:{Authorization:'Bearer admin-token'}});
  const during=await response.json();assert.equal(during.state,'busy');assert.ok(during.busy.includes('controller-admission'));
  pending.end(JSON.stringify({requestId:'request-id-00000001'}));assert.equal(await result,201);
});
