import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {probeStoppedService,createSystemAdapter,servicePlan} from '../apps/dsh-plugins/studio-services/service-manager.mjs';

const evidence=value=>async()=>({stdout:JSON.stringify(value)});

test('stopped evidence requires both an absent PID and no TCP listener',async()=>{
  const target={pid:123,port:5000};
  for(const [value,expected]of [
    [{pidAbsent:true,listenerCount:0},true],
    [{pidAbsent:false,listenerCount:0},false],
    [{pidAbsent:true,listenerCount:1},false],
    [{pidAbsent:false,listenerCount:2},false],
  ])assert.equal(await probeStoppedService(target,{execute:evidence(value)}),expected);
});

test('failed or malformed process queries cannot prove a service stopped',async()=>{
  const target={pid:123,port:5000};
  const error=Object.assign(Error('Observation unavailable'),{code:'ETIMEDOUT'});
  await assert.rejects(probeStoppedService(target,{execute:async()=>{throw error;}}),e=>e===error);
  for(const value of [{pidAbsent:'true',listenerCount:0},{pidAbsent:true,listenerCount:-1},{pidAbsent:true,listenerCount:0.5},{}]){
    await assert.rejects(probeStoppedService(target,{execute:evidence(value)}),/Invalid stopped-process evidence/);
  }
  await assert.rejects(probeStoppedService({...target,pid:'123; exit'},{execute:async()=>assert.fail('must not execute')}),/Invalid stopped-process probe/);
});

test('cold service records stay intact and allow Controller startup only with positive stopped evidence',async t=>{
  const root=await mkdtemp(join(tmpdir(),'studio-cold-status-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'config'));await mkdir(join(root,'runtime'));
  const node='C:/managed/node.exe',python='C:/managed/python.exe';
  const json=(path,value)=>writeFile(join(root,path),JSON.stringify(value));
  await json('config/environment.json',{controllerNodeExecutable:node,strataPythonExecutable:python,comfyPythonExecutable:python,comfyPort:8189});
  await json('config/controller.json',{port:3090});await json('config/strata.json',{enabled:true,baseUrl:'http://127.0.0.1:8190'});
  const records={};
  for(const [service,port,executable]of [['Strata',8190,python],['ComfyUI',8189,python],['Controller',3090,node]]){
    const record={service,url:`http://127.0.0.1:${port}`,executable,processId:123,startTimeUtcTicks:'638000000000000000'};
    await json('runtime/'+service+'.json',record);records[service]=await readFile(join(root,'runtime',service+'.json'),'utf8');
  }
  let stopped=true;
  const adapter=await createSystemAdapter({root,checkPort:async()=>false,probeStopped:async()=>stopped});
  const snapshot=await adapter.snapshot();assert.ok(snapshot.services.every(row=>row.state==='stopped'));
  assert.deepEqual(servicePlan('Controller','start',snapshot).map(step=>step.service),['ComfyUI','Strata','Controller']);
  stopped=false;const uncertain=await adapter.snapshot();assert.ok(uncertain.services.every(row=>row.state==='unknown'));
  assert.throws(()=>servicePlan('Controller','start',uncertain),{status:409});
  for(const [service,raw]of Object.entries(records))assert.equal(await readFile(join(root,'runtime',service+'.json'),'utf8'),raw);
});

test('Windows stopped probe distinguishes a live PID, a live listener, and a fully stopped service',{
  skip:process.platform!=='win32',timeout:45000,
},async t=>{
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
  const exited=once(child,'exit');await once(child,'spawn');
  const server=createServer();
  t.after(async()=>{if(server.listening)await new Promise(ok=>server.close(ok));if(child.exitCode===null&&child.signalCode===null)child.kill();await exited;});
  await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok);});
  const port=server.address().port;
  await new Promise(ok=>server.close(ok));
  assert.equal(await probeStoppedService({pid:child.pid,port}),false,'live PID without a listener');
  server.listen(port,'127.0.0.1');await once(server,'listening');
  child.kill();await exited;
  assert.equal(await probeStoppedService({pid:child.pid,port}),false,'listener without the recorded PID');
  await new Promise(ok=>server.close(ok));
  assert.equal(await probeStoppedService({pid:child.pid,port}),true,'both PID and listener absent');
});

test('service status reuses the configured epoch observer and never falls back after its failure',async t=>{
  const {createServer:createHttpServer}=await import('node:http');
  const root=await mkdtemp(join(tmpdir(),'studio-native-status-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'config'));await mkdir(join(root,'runtime'));
  const server=createHttpServer((_request,response)=>{response.setHeader('content-type','application/json');response.end(JSON.stringify({service:'local-image-controller',ready:true,pid:123,controllerId:'fixture-controller'}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(ok=>server.close(ok)));
  const port=server.address().port,node='C:/managed/node.exe',python='C:/managed/python.exe',ticks='638000000000000000';
  const json=(path,value)=>writeFile(join(root,path),JSON.stringify(value));
  const configuration={port,nativeProbe:{enabled:true,executable:'C:/managed/probe.exe',sha256:'4'.repeat(64)}};
  await json('config/environment.json',{controllerNodeExecutable:node,strataPythonExecutable:python,comfyPythonExecutable:python,comfyPort:8189});
  await json('config/controller.json',configuration);await json('config/strata.json',{enabled:true,baseUrl:'http://127.0.0.1:8190'});
  await json('runtime/Controller.json',{service:'Controller',url:`http://127.0.0.1:${port}`,executable:node,processId:123,startTimeUtcTicks:ticks,controllerId:'fixture-controller'});
  let nativeCalls=0,legacyCalls=0,factoryCalls=0,broken=false;
  const evidence={managed:{pid:123,startTimeUtcTicks:ticks,executable:node},listener:{pid:123,startTimeUtcTicks:ticks,executable:node,parentPid:1}};
  const adapter=await createSystemAdapter({root,checkPort:async value=>value===port,
    nativeProbeFactory:async(config,home)=>{factoryCalls++;assert.equal(home,root);if(!config.enabled)return null;return {epoch:async request=>{nativeCalls++;assert.deepEqual(request,{pid:123,port});if(broken)throw Error('Observer failed');return evidence;}};},
    probeEpoch:async()=>{legacyCalls++;return evidence;},
  });
  const controller=async()=> (await adapter.snapshot()).services.find(row=>row.id==='Controller');
  assert.equal((await controller()).state,'running');assert.equal(factoryCalls,1);assert.equal(nativeCalls,1);assert.equal(legacyCalls,0);
  broken=true;assert.equal((await controller()).state,'unknown');assert.equal(factoryCalls,1);assert.equal(legacyCalls,0);
  configuration.nativeProbe.enabled=false;await json('config/controller.json',configuration);adapter.reload();
  assert.equal((await controller()).state,'running');assert.equal(factoryCalls,2);assert.equal(legacyCalls,1);
});
