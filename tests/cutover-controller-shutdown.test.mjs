import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readdirSync,lstatSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {createServer} from 'node:http';
import {assertControllerIdleForCutover,assertObservedServicesIdle,shutdownOwnedController} from '../apps/controller/search/cutover-controller-shutdown.mjs';
test('external service preflight rejects queues, inference, missing observations and changed Comfy identity',async()=>{
 let calls=0;const idle={verifyComfy:async()=>{calls++},readQueue:async()=>({queue_running:[],queue_pending:[]}),readStrataStatus:async()=>({activity:{in_flight:0}})};
 await assertObservedServicesIdle(idle);assert.equal(calls,2);
 for(const queue of [{queue_running:[['job']],queue_pending:[]},{queue_running:[],queue_pending:[['job']]},{queue_running:[],queue_pending:null},{}])await assert.rejects(assertObservedServicesIdle({...idle,readQueue:async()=>queue}),/active, queued, or unconfirmed/);
 for(const status of [{activity:{in_flight:1}},{activity:{}},{}])await assert.rejects(assertObservedServicesIdle({...idle,readStrataStatus:async()=>status}),/active, queued, or unconfirmed/);
 await assert.rejects(assertObservedServicesIdle({...idle,readQueue:async()=>{throw Error('offline')}}),/observation is unavailable/);
 await assert.rejects(assertObservedServicesIdle({...idle,readStrataStatus:async()=>{throw Error('offline')}}),/observation is unavailable/);
 let observed=0;await assert.rejects(assertObservedServicesIdle({...idle,verifyComfy:async()=>{if(++observed===2)throw Error('changed')}}),/observation is unavailable/);
});
test('Controller preflight rejects busy, unknown, malformed, or changed identity before stopping the Host',{timeout:30000},async t=>{
 const base=resolve(import.meta.dirname,'../../runtime/cache'),root=mkdtempSync(join(base,'controller-preflight-')),token='c'.repeat(64);mkdirSync(join(root,'data/controller'),{recursive:true});writeFileSync(join(root,'data/controller/auth-token'),token);
 const identity={pid:123,controllerId:'fixture-controller'},idle={scope:'controller-only',processId:123,controllerId:'fixture-controller',state:'idle',busy:[],unknown:[]};let body=idle,requests=0,valid=true,auth;
 const server=createServer((req,res)=>{requests++;auth=req.headers.authorization;assert.equal(req.url,'/api/host-switch-status');assert.equal(req.method,'GET');res.setHeader('content-type','application/json');res.end(JSON.stringify(body));});await new Promise(ok=>server.listen(0,'127.0.0.1',ok));identity.url=`http://127.0.0.1:${server.address().port}`;
 t.after(async()=>{await new Promise(ok=>server.close(ok));assert.ok(resolve(root).startsWith(base+sep));const walk=p=>{const item=lstatSync(p);assert.equal(item.isSymbolicLink(),false);if(item.isDirectory())for(const name of readdirSync(p))walk(join(p,name));};walk(root);rmSync(root,{recursive:true,force:true});});
 const fence={identity,verifyLive:async()=>valid};await assertControllerIdleForCutover({runtimeRoot:root,controllerFence:fence});assert.equal(auth,'Bearer '+token);
 for(const invalid of [{...idle,state:'busy',busy:['search']},{...idle,state:'unknown',unknown:['resource-gate']},{...idle,busy:['inference']},{...idle,unknown:['search-ledger']},{...idle,processId:124},{...idle,controllerId:'other'},{...idle,busy:null},{...idle,scope:'all'}]){body=invalid;await assert.rejects(assertControllerIdleForCutover({runtimeRoot:root,controllerFence:fence}),/active, unresolved, or unconfirmed/);}
 body=idle;let checks=0;await assert.rejects(assertControllerIdleForCutover({runtimeRoot:root,controllerFence:{identity,verifyLive:async()=>++checks===1}}),/identity changed/);valid=false;const before=requests;await assert.rejects(assertControllerIdleForCutover({runtimeRoot:root,controllerFence:fence}),/identity is unavailable/);assert.equal(requests,before);
});
test('Controller shutdown is owned, single-shot and holds on uncertain outcomes',{timeout:30000},async t=>{
 const base=resolve(import.meta.dirname,'../../runtime/cache'),root=mkdtempSync(join(base,'controller-shutdown-')),token='b'.repeat(64);mkdirSync(join(root,'data/controller'),{recursive:true});writeFileSync(join(root,'data/controller/auth-token'),token);let mode='busy',requests=0,held=0,auth='';const server=createServer((req,res)=>{requests++;auth=req.headers.authorization;if(mode==='busy'){res.writeHead(409);res.end('{}');}else if(mode==='reset'){req.socket.destroy();}else{res.setHeader('content-type','application/json');res.end('{"stopping":true}');}});await new Promise(ok=>server.listen(0,'127.0.0.1',ok));t.after(async()=>{await new Promise(ok=>server.close(ok));assert.ok(resolve(root).startsWith(base+sep));const walk=p=>{const item=lstatSync(p);assert.equal(item.isSymbolicLink(),false);if(item.isDirectory())for(const name of readdirSync(p))walk(join(p,name));};walk(root);rmSync(root,{recursive:true,force:true});});
 const identity={url:`http://127.0.0.1:${server.address().port}`,pid:2147483647},controllerFence={identity,verifyLive:async()=>true,holdStopped:async()=>{held++;return {held:true}}};await assert.rejects(shutdownOwnedController({runtimeRoot:root,controllerFence}),/active or unresolved/);assert.equal(requests,1);assert.equal(held,0);assert.equal(auth,'Bearer '+token);
 mode='reset';requests=0;await assert.rejects(shutdownOwnedController({runtimeRoot:root,controllerFence}),/outcome is uncertain/);assert.equal(requests,1,'unknown POST outcome must never be retried');assert.equal(held,0);
 mode='success';requests=0;assert.deepEqual(await shutdownOwnedController({runtimeRoot:root,controllerFence}),{held:true});assert.equal(requests,1);assert.equal(held,1);
 requests=0;await assert.rejects(shutdownOwnedController({runtimeRoot:root,controllerFence:{...controllerFence,verifyLive:async()=>false}}),/identity is unavailable/);assert.equal(requests,0);
 let checks=0;requests=0;await assert.rejects(shutdownOwnedController({runtimeRoot:root,controllerFence:{...controllerFence,verifyLive:async()=>++checks===1}}),/identity changed before shutdown/);assert.equal(requests,0,'shutdown must not be sent after the Controller identity changes');
});
