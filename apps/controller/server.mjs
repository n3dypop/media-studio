import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { RunStore } from './store.mjs';
import { RunEngine } from './engine.mjs';
import { ComfyAdapter } from './comfy.mjs';
import { createControllerServer } from './http.mjs';
import { DurableWireStore } from './durable-wire-store.mjs';
import { DurableWireJournalReader } from './durable-wire-journal.mjs';
import { createEpochVerifier } from './epoch.mjs';
import { createRetiredEpochVerifier } from './server-recovery.mjs';
import { StrataClient } from './strata.mjs';
import { createStrataEpochVerifier } from './strata-epoch.mjs';
import { ResourceGate } from './resource-gate.mjs';
import { observeWindowsResources,observeOutputDisks } from './resources.mjs';
import { WorkflowRegistry,MODEL_PROFILES } from './workflows.mjs';
import { ProductionStore } from './productions.mjs';
import { SearchService } from './search/service.mjs';
import { createSearchOpenHandshake } from './search/open-handshake.mjs';
import { loadSearchConfiguration } from './search/config.mjs';
import {AssetStore} from './assets.mjs';
import {RETIRED_VIDEO_PROFILES} from './media-modes.mjs';
import {MossPeCoordinator} from './moss-pe-controller.mjs';
import {createResourceObserver} from './monitor-telemetry.mjs';
import {createStrataOwnedChildReader} from './strata-owned-processes.mjs';
import {strataPythonExecutable} from './service-paths.mjs';
import {createComfyProgressMonitor} from './monitor-progress.mjs';
import {createConfiguredNativeProbe} from './native-probe.mjs';
import {assertNoControllerPreopenGuard} from './search/cutover-preopen-guard.mjs';

if(process.env.MEDIA_STUDIO_HOME&&!isAbsolute(process.env.MEDIA_STUDIO_HOME))throw Error('MEDIA_STUDIO_HOME must be absolute');
const packageRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const root=resolve(process.env.MEDIA_STUDIO_HOME||packageRoot);
assertNoControllerPreopenGuard(root);
const settings=JSON.parse(readFileSync(join(root,'config/environment.json'),'utf8'));
const config=JSON.parse(readFileSync(join(root,'config/controller.json'),'utf8'));
if(config.experimentalHostIsolation!==undefined&&config.experimentalHostIsolation!==false)throw new Error('Host isolation is incomplete; strict Controller startup is disabled.');
if(Object.hasOwn(config,'fixtureDesktopPaths'))throw new Error('Fixture-only Desktop paths are not available in the production Controller.');
if(config.searchTurnOwnership!==undefined&&typeof config.searchTurnOwnership!=='boolean')throw new Error('Invalid search turn ownership configuration');
if(!Number.isInteger(config.port)||config.port<1024||config.port>65535||!Object.hasOwn(MODEL_PROFILES,config.profile)) throw new Error('Invalid controller configuration');
const nativeProbe=await createConfiguredNativeProbe(config.nativeProbe,root);
const epochProbe=nativeProbe?{probe:nativeProbe.epoch}:{};
const observeResources=nativeProbe?options=>observeWindowsResources({...options,readMemory:nativeProbe.resources}):observeWindowsResources;
const data=join(root,'data/controller'); mkdirSync(data,{recursive:true});
const tokenPath=join(data,'auth-token');
try { writeFileSync(tokenPath,randomBytes(32).toString('hex'),{flag:'wx',mode:0o600}); } catch(error) { if(error.code!=='EEXIST') throw error; }
const token=readFileSync(tokenPath,'utf8').trim();
if(!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid local auth token');
const dshTokenPath=join(data,'dsh-token');
try {writeFileSync(dshTokenPath,randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
const dshToken=readFileSync(dshTokenPath,'utf8').trim();
if(!/^[a-f0-9]{64}$/.test(dshToken))throw new Error('Invalid local DSH token');
const comfyUrl=`http://127.0.0.1:${settings.comfyPort}`;
// Bind the dedicated port before opening the durable journal. A second process
// cannot recover or write the same runs before the first process has exited.
let store,engine,server;
const http=await import('node:http');
const listener=http.createServer();
await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(config.port,'127.0.0.1',resolve);});
try {
  // A maintenance process can persist the guard while this process is waiting
  // for its listener. Recheck immediately before the first DB constructor.
  assertNoControllerPreopenGuard(root);
  store=new RunStore(join(data,'controller.db'));
  const wireStore=new DurableWireStore(store),wireReader=new DurableWireJournalReader(root);
  const profilePaths=Object.fromEntries(Object.keys(MODEL_PROFILES).filter(id=>!RETIRED_VIDEO_PROFILES.includes(id)).map(id=>[id,join(packageRoot,'workflows/approved',id+'.json')]));
  const assets=new AssetStore({store,root,inputRoot:settings.inputDirectory,pythonExecutable:settings.comfyPythonExecutable});
  const adapter=new ComfyAdapter({baseUrl:comfyUrl,outputRoot:join(root,'outputs'),profilePath:profilePaths[config.profile],modelProfile:config.profile,profilePaths,assets});
  const verifyEpoch=createEpochVerifier({runtimePath:join(root,'runtime/ComfyUI.json'),expectedExecutable:settings.comfyPythonExecutable,baseUrl:comfyUrl,...epochProbe});
  const verifyRetiredEpoch=createRetiredEpochVerifier({expectedExecutable:settings.comfyPythonExecutable,baseUrl:comfyUrl});
  const productions=new ProductionStore(store,{defaultModelProfile:config.profile,assets}),workflows=new WorkflowRegistry({root,adapter,assets});
  const searchConfig=loadSearchConfiguration(root);
  // Search is always ownership- and handshake-protected. Legacy explicit false
  // disables search; it never selects an unprotected path. A missing probe
  // leaves search closed without disabling local generation.
  const openHandshake=nativeProbe?createSearchOpenHandshake({store,ownerProbe:nativeProbe,token:dshToken}):null;
  const search=new SearchService({root,...searchConfig,enabled:searchConfig.enabled!==false&&config.searchTurnOwnership!==false,store,requireTurnOwner:true,ownerProbe:nativeProbe,requireGatewayOpen:true,openHandshake});
  let gate=null,strata=null,enhancer=null,verifyStrata=null,readStrataChildren=null;
  const strataConfig=JSON.parse(readFileSync(join(root,'config/strata.json'),'utf8'));
  if(strataConfig.enabled) {
    const saved=store.db.prepare('SELECT value FROM meta WHERE key=?').get('resourceGate');
    let previousState=saved?JSON.parse(saved.value):null;
    const beforeCoreLoad=async()=>{
      await verifyEpoch();
      const preflight=await adapter.preflight();
      if(!preflight.ready||!preflight.queueEmpty)throw new Error('中核ロード前のComfyUI待機状態を確認できません。');
    };
    if(!store.active())await beforeCoreLoad();
    if(previousState?.cleanShutdown&&!store.active()&&!previousState.blocked&&!previousState.generationRunId&&previousState.activeCore===0) {
      previousState={...previousState,strataStarted:null,strataIdentity:null};
    }
    const strataExecutable=strataPythonExecutable(settings,JSON.parse(readFileSync(join(root,'data/strata/installation.json'),'utf8')));
    verifyStrata=createStrataEpochVerifier({root,expectedExecutable:strataExecutable,baseUrl:strataConfig.baseUrl,expectedIdentity:previousState?.strataIdentity??null,...epochProbe});
    readStrataChildren=createStrataOwnedChildReader({root,expectedExecutable:strataExecutable});
    strata=new StrataClient({baseUrl:strataConfig.baseUrl,model:strataConfig.model,token:readFileSync(join(root,strataConfig.tokenFile),'utf8').trim(),expectedStarted:previousState?.strataStarted??null,verifyIdentity:verifyStrata,timeoutMs:1800000});
    gate=new ResourceGate({strata,observeResources,beforeCoreLoad,minFreeBytes:strataConfig.minGeneratorFreeBytes,minCoreFreeBytes:strataConfig.minCoreFreeBytes,minRamAvailableBytes:strataConfig.minRamAvailableBytes??0,minCommitAvailableBytes:strataConfig.minCommitAvailableBytes??0,onState:async snapshot=>{
      store.db.prepare('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('resourceGate',JSON.stringify({...snapshot,strataIdentity:strata.identity}));
    }});
    await gate.initialize({recovery:Boolean(store.active()),previousState});
    if(strataConfig.enhancer?.enabled) {
      const {PromptEnhancer}=await import('./enhancer.mjs');
      enhancer=new PromptEnhancer({pythonExecutable:settings.comfyPythonExecutable,modelPath:strataConfig.enhancer.modelPath,scriptPath:fileURLToPath(new URL('./enhance_prompt.py',import.meta.url)),observeResources});
    }
  }
  engine=new RunEngine({store,adapter,verifyEpoch,verifyRetiredEpoch,gate,enhancer,outputRoot:join(root,'outputs'),...config,
    observeOutputDisks:()=>observeOutputDisks([{label:'controller',path:join(root,'outputs')},{label:'comfyui',path:settings.outputDirectory}])});
  const mossPe=gate?new MossPeCoordinator({store,productions,adapter,gate,assets,verifyEpoch}):null;
  const qwenPeLicense=()=>{
    try{
      const c=JSON.parse(readFileSync(join(root,'docs/manifests/qwen-image-2.1-consent.json'),'utf8'));
      return c.schemaVersion===1&&c.model==='Qwen-Image-2.1'&&c.license==='Qwen Research License Agreement'&&c.licenseUrl==='https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE'&&c.revision==='aacf31a6d48e707f352ecba714cee0680da3479b'&&c.userConfirmed===true&&['research','evaluation'].includes(c.purpose)&&typeof c.evidence==='string'&&Boolean(c.evidence.trim())&&typeof c.confirmedAt==='string'&&Boolean(c.confirmedAt.trim());
    }catch{return false;}
  };
  const qwenPe=gate?new MossPeCoordinator({store,productions,adapter,gate,assets,verifyEpoch,family:'qwen',licenseCheck:qwenPeLicense}):null;
  engine.mossPe=mossPe;engine.qwenPe=qwenPe;
  const monitorTelemetry=createResourceObserver({verifyComfy:verifyEpoch,verifyStrata,readStrataChildren,...(nativeProbe?{readProcesses:nativeProbe.processes}:{})});
  const monitorProgress=gate?createComfyProgressMonitor({store,gate,verifyEpoch,baseUrl:comfyUrl}):null;
  const shutdown=()=>{
    if(!server.beginShutdown())return;
    monitorProgress?.dispose();
    listener.close(()=>{
      if(gate&&server.isIdle())store.db.prepare('UPDATE meta SET value=? WHERE key=?').run(JSON.stringify({...gate.status(),strataIdentity:strata.identity,cleanShutdown:true}),'resourceGate');
      store.close();process.exit(0);
    });
    listener.closeIdleConnections();
  };
  server=createControllerServer({store,engine,token,dshToken,productions,workflows,search,gate,strata,assets,mossPe,mossPeEnabled:config.mossPeEnabled===true,qwenPe,qwenPeEnabled:config.qwenPeEnabled===true,monitorTelemetry,monitorProgress,wireStore,wireReader,outputRoot:join(root,'outputs'),port:config.port,comfyUrl,profile:config.profile,onShutdown:shutdown});
  listener.on('request',(req,res)=>server.emit('request',req,res));
  listener.requestTimeout=server.requestTimeout;listener.headersTimeout=server.headersTimeout;
  process.on('SIGINT',()=>{if(server.isIdle())shutdown();});
  process.on('SIGTERM',()=>{if(server.isIdle())shutdown();});
  engine.recover();
  console.log(`Local image controller ready at http://127.0.0.1:${config.port}`);
} catch(error) { listener.close();store?.close();throw error; }
