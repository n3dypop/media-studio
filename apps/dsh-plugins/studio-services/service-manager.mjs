import {readFile,writeFile,mkdir,rename,open,unlink,lstat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join,resolve,sep,win32} from 'node:path';
import net from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createEpochVerifier,probeWindowsEpoch,validateEpochEvidence} from '../../controller/epoch.mjs';
import {createStrataEpochVerifier} from '../../controller/strata-epoch.mjs';
import {runServiceCommand} from './service-command-runner.mjs';
import {controllerNodeExecutable} from '../../controller/service-paths.mjs';
import {loadSearchConfiguration} from '../../controller/search/config.mjs';

export const SERVICES=Object.freeze(['Strata','ComfyUI','Controller']);
const actions=new Set(['start','stop','restart','unload']);
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fault=(message,status=409)=>Object.assign(new Error(message),{status});
const copy=value=>structuredClone(value);
const executeFile=promisify(execFile);

// A refused loopback connection alone cannot distinguish a stopped service
// from a live process that lost its listener. No record is deleted here.
export async function probeStoppedService({pid,port},{execute=executeFile}={}){
  if(!Number.isSafeInteger(pid)||pid<1||pid>0xffffffff||!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid stopped-process probe');
  const script=`$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$first=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop
$listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq ${port})
$last=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop
[ordered]@{pidAbsent=($null -eq $first -and $null -eq $last);listenerCount=$listeners.Count}|ConvertTo-Json -Compress`;
  const powershell=win32.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const result=await execute(powershell,['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:8000,maxBuffer:65536,encoding:'utf8'});
  const value=JSON.parse(result.stdout.trim().replace(/^\uFEFF/,''));
  if(typeof value.pidAbsent!=='boolean'||!Number.isSafeInteger(value.listenerCount)||value.listenerCount<0)throw Error('Invalid stopped-process evidence');
  return value.pidAbsent&&value.listenerCount===0;
}

export function servicePlan(service,action,snapshot){
  if(!SERVICES.includes(service)||!actions.has(action))throw fault('サービスまたは操作が不正です。',400);
  const byId=new Map(snapshot.services.map(s=>[s.id,s]));
  const target=byId.get(service),controller=byId.get('Controller');
  if(!target||!controller||snapshot.services.some(s=>!['running','stopped'].includes(s.state)))throw fault('管理プロセスを照合できないサービスがあります。状態を確認してください。');
  if(action==='unload'){
    if(!['Strata','ComfyUI'].includes(service))throw fault('このサービスには解放対象の生成モデルがありません。',400);
    if(target.state!=='running'||controller.state!=='running')throw fault('リソース解放には対象サービスとControllerの起動が必要です。');
    return [{service,action,label:`${service}: リソース解放`,state:'pending'}];
  }
  if(action==='start'&&target.state==='running'||action==='stop'&&target.state==='stopped')return [];
  const steps=[];
  const add=(id,verb)=>{if(verb==='start'&&steps.findLast(step=>step.service===id)?.action==='start')return;steps.push({service:id,action:verb,label:`${id}: ${verb==='start'?'起動':'停止'}`,state:'pending'});};
  const ensureStarted=id=>{
    if(byId.get(id)?.state!=='running'||steps.some(step=>step.service===id&&step.action==='stop'))add(id,'start');
  };
  const startController=()=>{
    ensureStarted('ComfyUI');
    if(snapshot.strataEnabled)ensureStarted('Strata');
    if(snapshot.searchEnabled)add('RustXNG','start');
    add('Controller','start');
  };
  if(service==='Controller'){
    if(action!=='start')add('Controller','stop');
    if(action!=='stop')startController();
  }else{
    if(service==='Strata'&&!snapshot.strataEnabled&&action!=='stop')throw fault('Strataは現在の構成で無効です。設定ファイルを確認してください。');
    const restartController=controller.state==='running';
    if(restartController)add('Controller','stop');
    if(action!=='start')add(service,'stop');
    if(action!=='stop')add(service,'start');
    if(restartController&&action!=='stop')startController();
  }
  return steps;
}

async function fileJson(path){try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function portOpen(port){
  if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid local port');
  return new Promise((resolve,reject)=>{const socket=net.createConnection({host:'127.0.0.1',port});socket.setTimeout(2500);socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',e=>{socket.destroy();e.code==='ECONNREFUSED'?resolve(false):reject(Error('Port state unavailable'));});socket.once('timeout',()=>{socket.destroy();reject(Error('Port state unavailable'));});});
}
async function getJson(url,headers={}){const r=await fetch(url,{headers,redirect:'error',signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error('Service response unavailable');return r.json();}
function projectPath(root,relative){const path=resolve(root,relative);if(!path.startsWith(root+sep))throw Error('Path escapes project');return path;}

export async function createSystemAdapter({root,probeStopped=probeStoppedService,checkPort=portOpen,hostOrigin}){
  root=resolve(root);
  const programFiles=process.env.ProgramW6432??process.env.ProgramFiles;
  const standardPowerShell=programFiles&&win32.isAbsolute(programFiles)?join(programFiles,'PowerShell/7/pwsh.exe'):null;
  const powerShell=standardPowerShell&&(await lstat(standardPowerShell).catch(()=>null))?.isFile()?standardPowerShell:'pwsh.exe';
  let environment,controller,strata,paths,descriptions;
  let configurationDirty=true;
  async function loadConfiguration(){
  environment=await fileJson(join(root,'config/environment.json'));controller=await fileJson(join(root,'config/controller.json'));strata=await fileJson(join(root,'config/strata.json'));
  if(!environment||!controller||typeof strata?.enabled!=='boolean')throw Error('Service configuration unavailable');
  const node=controllerNodeExecutable(root,environment);
  const receipt=await fileJson(join(root,'data/strata/installation.json'));
  const strataExe=environment.strataPythonExecutable??(receipt?.control?join(receipt.control,'python/python.exe'):null);
  if(strata.enabled&&!strataExe)throw Error('Strata Python requires explicit configuration or a prepared installation receipt.');
  descriptions={Strata:{executable:strataExe,url:strata.baseUrl},ComfyUI:{executable:environment.comfyPythonExecutable,url:`http://127.0.0.1:${environment.comfyPort}`},Controller:{executable:node,url:`http://127.0.0.1:${controller.port}`}};
  for(const description of Object.values(descriptions)){const url=new URL(description.url);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('Unexpected service address');}
  paths={readOnly:true,Strata:{executable:strataExe,configuration:receipt?.config??join(root,'data/strata/serve-config.json')},ComfyUI:{directory:environment.comfyDirectory,executable:environment.comfyPythonExecutable},Controller:{entry:fileURLToPath(new URL('../../controller/server.mjs',import.meta.url)),executable:node},configurationFiles:['config/environment.json','config/controller.json','config/strata.json'].map(path=>join(root,path))};
  configurationDirty=false;
  }
  await loadConfiguration();
  async function serviceStatus(id){
    const expected=descriptions[id],recordPath=join(root,'runtime',id+'.json');
    try{
      const port=Number(new URL(expected.url).port),record=await fileJson(recordPath),listening=await checkPort(port);
      if(!record)return {id,name:id,state:listening?'unmanaged':'stopped',detail:listening?'管理台帳にない待受です。操作しません。':'停止しています。'};
      if(record.service!==id||record.url!==expected.url||String(record.executable).replaceAll('\\','/').toLowerCase()!==String(expected.executable).replaceAll('\\','/').toLowerCase())throw Error('Record differs');
      if(!listening){
        if(!Number.isSafeInteger(record.processId)||record.processId<1||typeof record.startTimeUtcTicks!=='string'||!/^\d{17,19}$/.test(record.startTimeUtcTicks))throw Error('Invalid stopped record');
        if(await probeStopped({pid:record.processId,port})&&JSON.stringify(record)===JSON.stringify(await fileJson(recordPath))&&!await checkPort(port))return {id,name:id,state:'stopped',detail:'管理プロセスの終了と待受なしを確認しました。次回の起動で既存の管理記録を照合します。'};
        return {id,name:id,state:'unknown',detail:'管理記録はありますがプロセス終了と待受なしを証明できません。記録を保持しています。'};
      }
      let epoch;
      if(id==='Strata')epoch=await createStrataEpochVerifier({root,expectedExecutable:expected.executable,baseUrl:expected.url})();
      else if(id==='ComfyUI')epoch=await createEpochVerifier({runtimePath:recordPath,expectedExecutable:expected.executable,baseUrl:expected.url})();
      else epoch=validateEpochEvidence({pid:record.processId,startTimeUtcTicks:record.startTimeUtcTicks,executable:win32.normalize(expected.executable).toLowerCase(),url:expected.url},await probeWindowsEpoch({pid:record.processId,port}));
      if(id==='Controller'){
        const health=await getJson(expected.url+'/health');if(epoch.listenerPid!==epoch.pid||health.service!=='local-image-controller'||health.ready!==true||health.pid!==epoch.pid||record.controllerId!==health.controllerId)throw Error('Controller identity differs');
      }else if(id==='ComfyUI'){const stats=await getJson(expected.url+'/system_stats');if(!stats.system||!Array.isArray(stats.devices))throw Error('Comfy readiness unavailable');}
      else{const token=(await readFile(join(root,'data/strata/api-token'),'utf8')).trim(),value=await getJson(expected.url+'/v1/status',{Authorization:'Bearer '+token});if(value.service!=='strata'||value.started!==record.started||!Number.isSafeInteger(value.activity?.in_flight))throw Error('Strata readiness unavailable');}
      return {id,name:id,state:'running',detail:'管理プロセスと待受を照合済みです。'};
    }catch{return {id,name:id,state:'unknown',detail:'プロセス・待受・管理記録の一致を確認できません。操作を保留します。'};}
  }
  async function assertIdle(snapshot,cookie){
    if(!cookie)throw fault('本人のDSH接続を確認できません。',403);
    const dshOrigin=hostOrigin?hostOrigin():`http://127.0.0.1:${environment.dshPort}`,rpcId=randomUUID();
    if(!dshOrigin)throw fault('DSHの会話状態を確認できません。');
    const response=await fetch(dshOrigin+'/api/session/list',{method:'POST',headers:{Cookie:cookie,Origin:dshOrigin,'Content-Type':'application/json'},body:JSON.stringify({type:'client-request',rpcId,method:'session/list',payload:{args:{_request:{}}}}),signal:AbortSignal.timeout(10000),redirect:'error'});
    const result=await response.json(),items=result.result?.value?.items;
    if(!response.ok||result.rpcId!==rpcId||result.result?.ok!==true||!Array.isArray(items)||items.some(item=>typeof item.running!=='boolean'))throw fault('DSHの会話状態を確認できません。');
    if(items.some(item=>item.running))throw fault('実行中の会話があります。終了後にサービスを操作してください。');
    if(snapshot.services.some(s=>s.state==='unknown'||s.state==='unmanaged'))throw fault('サービスの所有状態が不明です。');
    if(snapshot.services.find(s=>s.id==='Controller')?.state==='running'){
      const token=(await readFile(join(root,'data/controller/auth-token'),'utf8')).trim(),headers={Authorization:'Bearer '+token};
      const [status,state]=await Promise.all([getJson(descriptions.Controller.url+'/api/status',headers),getJson(descriptions.Controller.url+'/api/production-state',headers)]),gate=status.resources;
      if(!gate||status.activeRunId||state.inferenceScope||gate.activeCore!==0||gate.blocked!==false||gate.generationRunId||!['none','core'].includes(gate.owner))throw fault('Controllerに実行中または未解決の処理があります。');
    }else{
      // A missing API is not evidence that the durable GPU lease is idle.
      // Do not open a journal in write mode just to decide lifecycle safety.
      const dbPath=join(root,'data/controller/controller.db');
      try{
        const stat=await lstat(dbPath);if(stat.isSymbolicLink()||!stat.isFile())throw fault('Controllerの記録を確認できません。');
        const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(dbPath,{readOnly:true});
        try{const active=db.prepare("SELECT count(*) AS n FROM runs WHERE phase NOT IN ('completed','failed','cancelled')").get().n,row=db.prepare("SELECT value FROM meta WHERE key='resourceGate'").get(),gate=row?JSON.parse(row.value):null;
          if(active||gate&&(gate.activeCore!==0||gate.blocked||gate.generationRunId||!['none','core'].includes(gate.owner)))throw fault('Controllerの記録に未解決の実行またはGPU所有があります。既存の復旧手順で照合してください。');
        }finally{db.close();}
      }catch(e){if(e.code!=='ENOENT')throw e;}
    }
    if(snapshot.services.find(s=>s.id==='ComfyUI')?.state==='running'){
      const queue=await getJson(descriptions.ComfyUI.url+'/queue');if(!Array.isArray(queue.queue_running)||!Array.isArray(queue.queue_pending)||queue.queue_running.length||queue.queue_pending.length)throw fault('ComfyUIに実行中または待機中のジョブがあります。');
    }
    if(snapshot.services.find(s=>s.id==='Strata')?.state==='running'){
      const token=(await readFile(join(root,'data/strata/api-token'),'utf8')).trim(),status=await getJson(descriptions.Strata.url+'/v1/status',{Authorization:'Bearer '+token});if(status.activity?.in_flight!==0)throw fault('Strataが推論中です。');
    }
  }
  const scripts={
    'ComfyUI:start':['Start-Environment.ps1','-Service','ComfyUI'], 'ComfyUI:stop':['Stop-Environment.ps1','-Service','ComfyUI'],
    'Strata:start':['Start-Strata.ps1'], 'Strata:stop':['Stop-Strata.ps1'],
    'Controller:start':['Start-Controller.ps1'], 'Controller:stop':['Stop-Controller.ps1'], 'RustXNG:start':['Start-RustXNG.ps1'],
  };
  return {get paths(){return paths;},reload(){configurationDirty=true;},async snapshot(){if(configurationDirty)await loadConfiguration();const searchEnabled=loadSearchConfiguration(root).enabled;return {observedAt:new Date().toISOString(),services:await Promise.all(SERVICES.map(serviceStatus)),strataEnabled:strata.enabled,searchEnabled,paths};},assertIdle,
    async runStep(step){
      if(step.action==='unload'){
        const token=(await readFile(join(root,'data/controller/auth-token'),'utf8')).trim();
        let response;
        try{response=await fetch(descriptions.Controller.url+'/api/resources/unload',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({service:step.service}),signal:AbortSignal.timeout(75000),redirect:'error'});}
        catch{throw Object.assign(Error('リソース解放の結果を確認できません。自動再実行しません。'),{uncertain:true});}
        let result;try{result=await response.json();}catch{throw Object.assign(Error('リソース解放の応答を確認できません。'),{uncertain:true});}
        if(!response.ok)throw Object.assign(Error(typeof result.error==='string'?result.error:'リソースを解放できません。'),{status:response.status,uncertain:result.uncertain===true});
        if(result.service!==step.service||result.released!==true||result.resources?.blocked!==false)throw Object.assign(Error('リソース解放の完了を確認できません。'),{uncertain:true});
        return;
      }
      const args=scripts[step.service+':'+step.action];if(!args)throw fault('未対応の起動処理です。',400);
      if(step.service==='Controller'&&step.action==='start'){
        const dependencies=strata.enabled?['ComfyUI','Strata']:['ComfyUI'];
        const states=await Promise.all(dependencies.map(serviceStatus));
        const unavailable=states.filter(service=>service.state!=='running');
        if(unavailable.length)throw fault(`Controllerの起動に必要な${unavailable.map(service=>service.name).join('・')}の稼働を確認できません。`);
      }
      const script=projectPath(root,'scripts/'+args[0]);if((await lstat(script)).isSymbolicLink())throw Error('Linked launch script');
      const logDir=projectPath(root,'logs/service-manager');
      const logName=`${step.service}-${step.action}-${randomUUID()}.stderr.log`;
      const logPath=join(logDir,logName);
      await mkdir(logDir,{recursive:true});
      if(!(await lstat(logDir)).isDirectory())throw fault('サービス操作のログを準備できません。');
      const log=await open(logPath,'wx',0o600);
      try{
        await runServiceCommand(powerShell,['-NoLogo','-NoProfile','-NonInteractive','-File',script,...args.slice(1)],{cwd:root,stderr:log.fd});
      }catch(error){
        const reason={spawn:'PowerShellを起動できません。',timeout:'PowerShellの終了確認が時間切れです。',interrupted:'PowerShellの終了結果が不明です。',exit:'起動・停止スクリプトがエラーを返しました。'}[error.reason];
        throw Object.assign(new Error(`${step.service}の操作を確認できません。${reason??''} ログ: logs/service-manager/${logName}`),{uncertain:error.uncertain===true});
      }finally{await log.close();}
      await unlink(logPath).catch(()=>{});
    }};
}

export async function createServiceManager({root,adapter,clock=()=>new Date(),id=randomUUID,readJournal=fileJson}={}){
  root=resolve(root);if(!adapter||typeof adapter.snapshot!=='function'||typeof adapter.assertIdle!=='function'||typeof adapter.runStep!=='function')throw TypeError('Service adapter required');
  const directory=projectPath(root,'data/service-manager'),journal=join(directory,'operations.json'),lockPath=projectPath(root,'runtime/Studio-services.lock');
  await mkdir(directory,{recursive:true});await mkdir(join(root,'runtime'),{recursive:true});
  const projectReceipts=items=>items.map(item=>item.state==='running'?{...item,state:'unknown',detail:'前回のインスタンスのサービス操作は実行中または結果不明です。自動再実行しません。'}:item);
  const stored=await readJournal(journal),operations=Array.isArray(stored?.operations)?projectReceipts(stored.operations):[];
  let running=null,readPending=null,cache=null,disposed=false,generation=0,cacheGeneration=0;
  function invalidateCache(){cache=null;cacheGeneration++;readPending=null;}
  const persist=async()=>{const tmp=journal+'.'+id()+'.partial';try{await writeFile(tmp,JSON.stringify({schemaVersion:1,operations},null,2)+'\n',{encoding:'utf8',flag:'wx'});await rename(tmp,journal);}finally{await unlink(tmp).catch(()=>{});}};
  const refreshReceipts=async()=>{if(running)return;const at=generation,stored=await readJournal(journal);if(running||generation!==at)return;if(Array.isArray(stored?.operations)){operations.splice(0,operations.length,...projectReceipts(stored.operations));generation++;}};
  const currentSnapshot=async fresh=>{
    if(!fresh&&cache&&clock().getTime()-cache.at<5000)return copy(cache.value);
    if(!readPending){
      const entry={generation:cacheGeneration,promise:null};
      entry.promise=adapter.snapshot().then(value=>{if(entry.generation===cacheGeneration&&readPending===entry)cache={at:clock().getTime(),value};return value;}).finally(()=>{if(readPending===entry)readPending=null;});
      readPending=entry;
    }
    const entry=readPending,value=await entry.promise;
    return entry.generation===cacheGeneration?copy(value):currentSnapshot(fresh);
  };
  async function snapshot(requestId){
    await refreshReceipts();
    const status=running&&cache?copy(cache.value):await currentSnapshot(false);
    return {...status,operation:copy(requestId?operations.find(o=>o.requestId===requestId)??null:operations.at(-1)??null)};
  }
  async function submit(input,{cookie}={}){
    if(disposed)throw fault('サービス管理は終了しています。',503);
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['service','action','requestId'].includes(k))||!SERVICES.includes(input.service)||!actions.has(input.action)||!uuid.test(input.requestId??''))throw fault('サービス操作の指定が不正です。',400);
    await refreshReceipts();
    const existing=operations.find(o=>o.requestId===input.requestId);
    if(existing){if(existing.service!==input.service||existing.action!==input.action)throw fault('同じrequestIdの操作を変更できません。');return {operation:copy(existing),created:false};}
    if(running)throw fault('別のサービス操作を処理中です。');
    // Reserve before any asynchronous preflight, including concurrent requests.
    const reservation={};running=reservation;generation++;let lock,prepared;
    try{
      try{lock=await open(lockPath,'wx');}catch{throw fault('別の操作または結果不明のサービス操作があります。自動再実行しません。');}
      const before=await currentSnapshot(true),steps=servicePlan(input.service,input.action,before);
      if(steps.length&&operations.some(o=>o.state==='unknown'))throw fault('前回の操作結果が不明です。新しい変更は開始せず、既存の管理記録を確認してください。');
      if(steps.length)await adapter.assertIdle(before,cookie);
      const operation={id:id(),...input,state:steps.length?'running':'completed',steps,createdAt:clock().toISOString(),updatedAt:clock().toISOString(),detail:steps.length?'サービスの管理手順を実行します。':'既に指定された状態です。'};
      // Receipts are retained so an older request ID never becomes a new
      // operation after a browser reconnect or reload.
      operations.push(operation);prepared=operation;await persist();
      if(!steps.length){await lock.close();lock=null;await unlink(lockPath);running=null;generation++;return {operation:copy(operation),created:true};}
      running=operation;
      const handle=lock;lock=null;
      void (async()=>{
        try{
          for(const step of steps){
            if(disposed)throw Object.assign(Error('管理pluginが終了したため、残りの操作は開始していません。'),{uncertain:true});
            step.state='running';operation.updatedAt=clock().toISOString();await persist();
            // Recheck before every destructive step. Stop scripts repeat
            // ownership, queue and controller-journal checks themselves.
            try{if(['stop','unload'].includes(step.action))await adapter.assertIdle(await currentSnapshot(true),cookie);await adapter.runStep(step);step.state='completed';}catch(e){step.state=e.uncertain?'unknown':'failed';throw e;}
            invalidateCache();operation.updatedAt=clock().toISOString();await persist();
          }
          operation.state='completed';operation.detail='サービス操作が完了しました。';
        }catch(e){operation.state=e.uncertain?'unknown':'failed';for(const step of steps)if(step.state==='running')step.state=operation.state;operation.detail=e.status?e.message:typeof e.message==='string'?e.message:'サービス操作を確認できません。';}
        finally{
          operation.updatedAt=clock().toISOString();await persist().catch(()=>{operation.state='unknown';operation.detail='結果の保存を確認できません。自動再実行しません。';});invalidateCache();await handle.close().catch(()=>{});await unlink(lockPath).catch(()=>{});running=null;generation++;
        }
      })();
      return {operation:copy(operation),created:true};
    }catch(e){if(running===reservation){if(prepared){const index=operations.indexOf(prepared);if(index!==-1)operations.splice(index,1);}running=null;generation++;}if(lock){await lock.close().catch(()=>{});await unlink(lockPath).catch(()=>{});}throw e;}
  }
  return {snapshot,submit,invalidateCache,dispose(){disposed=true;},async settled(){while(running)await new Promise(r=>setTimeout(r,10));}};
}
