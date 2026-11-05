import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {access,mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,win32} from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {controllerNodeExecutable,validateControllerNodeRuntime} from '../apps/controller/service-paths.mjs';
import {validateServicePaths} from '../apps/dsh-plugins/studio-services/service-settings.mjs';

const exec=promisify(execFile),root='D:\\private',external='C:\\Program Files\\nodejs\\node.exe';
const metadata={version:'24.22.2',platform:'win32',arch:'x64',executable:external};

test('an explicit external Node path is accepted without changing the legacy private default',()=>{
  assert.equal(controllerNodeExecutable(root,{nodeDirectory:'apps/node'}),'D:\\private\\apps\\node\\node.exe');
  assert.equal(controllerNodeExecutable(root,{nodeDirectory:'apps/node',controllerNodeExecutable:external}),external);
  for(const value of ['node.exe','https://example.invalid/node.exe','\\\\server\\share\\node.exe','C:\\tools\\other.exe'])assert.throws(()=>controllerNodeExecutable(root,{controllerNodeExecutable:value}));
});

test('the runtime check rejects wrong versions, shims, architectures and missing SQLite',async()=>{
  const run=async()=>({stdout:JSON.stringify(metadata)});
  assert.equal((await validateControllerNodeRuntime(external,{run})).version,'24.22.2');
  for(const change of [{version:'26.0.0'},{version:'24.2.0-pre'},{arch:'arm64'},{platform:'linux'},{executable:'C:\\other\\node.exe'}]){
    await assert.rejects(validateControllerNodeRuntime(external,{run:async()=>({stdout:JSON.stringify({...metadata,...change})})}));
  }
  await assert.rejects(validateControllerNodeRuntime(external,{run:async()=>{throw Error('missing sqlite');}}));
});

test('service settings accept an existing external Node only after its runtime check',async()=>{
  const comfy='D:\\ComfyUI',strata='D:\\Strata',control=win32.join(strata,'.runtime/terminal/prepared'),engine=win32.join(strata,'.runtime/components/engine/prepared');
  const receipt={schemaVersion:1,prepared:true,workspace:root,productRoot:strata,control,engine,config:win32.join(root,'data/strata/serve-config.json')};
  const values={comfyDirectory:comfy,comfyPythonExecutable:win32.join(comfy,'.venv/Scripts/python.exe'),strataPythonExecutable:win32.join(control,'python/python.exe'),controllerNodeExecutable:external};
  const files=new Set([win32.join(comfy,'main.py'),...Object.values(values).filter(x=>x.endsWith('.exe')),win32.join(control,'serve/server.py'),win32.join(engine,'engine-component.json')]);
  const options={root,receipt,comfyRoot:comfy,strataRoot:strata,canonical:async path=>path,stat:async path=>({isSymbolicLink:()=>false,isFile:()=>files.has(path),isDirectory:()=>!files.has(path)})};
  let checked;assert.deepEqual(await validateServicePaths(values,{...options,verifyNode:async path=>{checked=path;}}),values);assert.equal(checked,external);
  await assert.rejects(validateServicePaths(values,{...options,verifyNode:async()=>{throw Error('bad Node');}}),/Node\.js 24/);
});

test('managed Controller starts and stops with a Node executable outside the private runtime', {skip:process.platform!=='win32'},async t=>{
  const fixture=await mkdtemp(join(tmpdir(),'media-external-node-'));
  for(const dir of ['config','input','outputs','runtime'])await mkdir(join(fixture,dir),{recursive:true});
  const socket=createServer();await new Promise((ok,fail)=>socket.once('error',fail).listen(0,'127.0.0.1',ok));const port=socket.address().port;await new Promise(ok=>socket.close(ok));
  const source=fileURLToPath(new URL('../scripts/',import.meta.url));
  const environment={nodeDirectory:'apps/legacy-node',controllerNodeExecutable:process.execPath,dshPort:port===3080?3081:3080,comfyPort:port===8189?8191:8189,comfyPythonExecutable:join(fixture,'fake-python.exe'),inputDirectory:join(fixture,'input'),outputDirectory:join(fixture,'outputs')};
  await writeFile(join(fixture,'config/environment.json'),JSON.stringify(environment));
  await writeFile(join(fixture,'config/controller.json'),JSON.stringify({port,profile:'moss-image-sft-int8-v1'}));
  await writeFile(join(fixture,'config/strata.json'),JSON.stringify({enabled:false}));
  const env={...process.env,MEDIA_STUDIO_HOME:fixture};let attempted=false,stopped=false;
  try {
    const args=['-NoProfile','-NonInteractive','-File',join(source,'Start-Controller.ps1')];
    const check=await exec('pwsh.exe',[...args,'-ValidateOnly'],{env,windowsHide:true,timeout:20000});const report=JSON.parse(check.stdout);assert.equal(report.started,false);assert.match(report.nodeVersion,/^24\./);
    attempted=true;
    // The managed Controller outlives the launcher; do not wait for inherited
    // pipe handles to close when the PowerShell launcher has already exited.
    await new Promise((ok,fail)=>{const child=spawn('pwsh.exe',args,{env,windowsHide:true,stdio:'ignore'});const timer=setTimeout(()=>{child.kill();fail(Error('Launcher timed out'));},20000);child.once('error',error=>{clearTimeout(timer);fail(error);});child.once('exit',code=>{clearTimeout(timer);code===0?ok():fail(Error('Launcher failed'));});});
    const saved=JSON.parse(await readFile(join(fixture,'runtime/Controller.json'),'utf8'));assert.equal(saved.executable.toLowerCase(),process.execPath.toLowerCase());
    const health=await (await fetch(`http://127.0.0.1:${port}/health`)).json();assert.equal(health.pid,saved.processId);assert.equal(health.ready,true);
    const token=(await readFile(join(fixture,'data/controller/dsh-token'),'utf8')).trim();
    const headers={Authorization:`Bearer ${token}`,'X-DSH-Session':'fixture-session','Content-Type':'application/json'};
    let response=await fetch(`http://127.0.0.1:${port}/api/status`,{headers});assert.equal(response.status,200);assert.equal((await response.json()).search.enabled,false);
    response=await fetch(`http://127.0.0.1:${port}/api/search-proposals/user-turn`,{method:'POST',headers,body:JSON.stringify({turn:1})});assert.equal(response.status,503,'A missing identity probe must not enable unprotected search');
    response=await fetch(`http://127.0.0.1:${port}/api/search-proposals`,{method:'POST',headers,body:JSON.stringify({queries:['fixture'],purpose:'test',turn:1})});assert.equal(response.status,409,'The rejected turn cannot submit a search');
    response=await fetch(`http://127.0.0.1:${port}/api/search-proposals`,{headers});assert.equal(response.status,200);const listing=await response.json();assert.equal(listing.enabled,false);assert.deepEqual(listing.proposals,[]);
    await exec('pwsh.exe',['-NoProfile','-NonInteractive','-File',join(source,'Stop-Controller.ps1')],{env,windowsHide:true,timeout:30000});stopped=true;
  } finally {
    if(attempted&&!stopped&&await access(join(fixture,'runtime/Controller.json')).then(()=>true,()=>false)){
      try{await exec('pwsh.exe',['-NoProfile','-NonInteractive','-File',join(source,'Stop-Controller.ps1')],{env,windowsHide:true,timeout:30000});stopped=true;}catch{}
    }
    if(attempted&&!stopped)throw Error(`Isolated Controller requires inspection before cleanup: ${fixture}`);
    await rm(fixture,{recursive:true,force:true});
  }
});
