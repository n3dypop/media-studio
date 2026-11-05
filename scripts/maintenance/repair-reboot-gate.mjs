import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:net';
import {resolve,join,win32,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createStrataEpochVerifier} from '../../apps/controller/strata-epoch.mjs';
import {createEpochVerifier} from '../../apps/controller/epoch.mjs';
import {probeRetiredWindowsProcesses} from '../../apps/controller/server-recovery.mjs';
import {StrataClient} from '../../apps/controller/strata.mjs';
import {strataPythonExecutable} from '../../apps/controller/service-paths.mjs';
import {validateRebootGate,writeRecoveryInTransaction} from './reboot-gate-rules.mjs';

if(process.platform!=='win32'||process.env.LOCAL_MEDIA_RECOVERY_LOCKS!=='held-by-Repair-RebootGate') throw new Error('Run through Repair-RebootGate.ps1 with the real launcher locks held.');
if(process.argv.slice(2).some(x=>x!=='--apply')||process.argv.slice(2).length>1)throw new Error('Only --apply is supported.');
const apply=process.argv.includes('--apply');
if(process.env.MEDIA_STUDIO_HOME&&!isAbsolute(process.env.MEDIA_STUDIO_HOME))throw Error('MEDIA_STUDIO_HOME must be absolute');
const root=resolve(process.env.MEDIA_STUDIO_HOME||fileURLToPath(new URL('../..',import.meta.url)));
const readJson=async p=>JSON.parse(await readFile(join(root,p),'utf8'));
const environment=await readJson('config/environment.json');
const config=await readJson('config/strata.json');
const controller=await readJson('config/controller.json');
const strataExe=strataPythonExecutable(environment,await readJson('data/strata/installation.json'));
const verifyStrata=createStrataEpochVerifier({root,expectedExecutable:strataExe,baseUrl:config.baseUrl});
const verifyComfy=createEpochVerifier({runtimePath:join(root,'runtime/ComfyUI.json'),expectedExecutable:environment.comfyPythonExecutable,baseUrl:`http://127.0.0.1:${environment.comfyPort}`});
const token=(await readFile(join(root,config.tokenFile),'utf8')).trim();
const strata=new StrataClient({baseUrl:config.baseUrl,model:config.model,token,verifyIdentity:verifyStrata,timeoutMs:10000});
const command=promisify(execFile);
const ps=win32.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
const osScript=`$ErrorActionPreference='Stop'; $boot=(Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().Ticks.ToString(); $matches=@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.CommandLine -match 'apps[\\\\/]controller[\\\\/]server\\.mjs|@deepseek-ai[\\\\/]dsh[\\\\/]lib[\\\\/]bin\\.js' }); [ordered]@{bootTicks=$boot;serviceProcesses=$matches.Count}|ConvertTo-Json -Compress`;
const system=async()=>JSON.parse((await command(ps,['-NoProfile','-NonInteractive','-Command',osScript],{windowsHide:true,timeout:15000,maxBuffer:65536})).stdout.trim().replace(/^\uFEFF/,''));
async function reserve(port){const server=createServer();await new Promise((yes,no)=>{server.once('error',no);server.listen({port,host:'127.0.0.1',exclusive:true},yes);});return server;}
const held=[];
let db;
try {
  held.push(await reserve(controller.port));
  held.push(await reserve(environment.dshPort));
  db=new DatabaseSync(join(root,'data/controller/controller.db'));
  const initial=db.prepare("SELECT value FROM meta WHERE key='resourceGate'").get();
  if(!initial)throw Error('No resource gate record.');
  const gate=JSON.parse(initial.value),old=gate.strataIdentity;
  if(!Number.isSafeInteger(old?.pid)||old.pid<1)throw Error('No valid retired process ID.');
  const collect=async()=>{
    const sys=await system();
    const retired=[await probeRetiredWindowsProcesses([old.pid]),await probeRetiredWindowsProcesses([old.pid])];
    const comfy=await verifyComfy();
    const response=await fetch(`http://127.0.0.1:${environment.comfyPort}/queue`,{signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw Error('ComfyUI queue request failed.');
    const queue=await response.json();
    const status=await strata.status();
    const identity=strata.identity;
    const active=db.prepare("SELECT count(*) n FROM runs WHERE phase NOT IN ('completed','failed','cancelled')").get().n;
    return {gate,bootTicks:sys.bootTicks,retired,currentStrata:{...identity,loaded:status.loaded,inFlight:status.activity.in_flight},comfy,queue,active,serviceProcesses:sys.serviceProcesses};
  };
  const first=await collect();
  const next=validateRebootGate(first);
  if(!apply){console.log(JSON.stringify({mode:'dry-run',eligible:true,evidence:first,next},null,2));}
  else {
    db.exec('BEGIN IMMEDIATE');
    try {
      if(db.prepare("SELECT value FROM meta WHERE key='resourceGate'").get()?.value!==initial.value)throw Error('Gate changed before transaction.');
      const last=await collect();
      validateRebootGate(last);
      if(last.bootTicks!==first.bootTicks||JSON.stringify(last.currentStrata)!==JSON.stringify(first.currentStrata)||JSON.stringify(last.comfy)!==JSON.stringify(first.comfy))throw Error('Process identity changed during reconciliation.');
      const now=new Date().toISOString(),id=randomUUID();
      const audit={id,at:now,operation:'windows-reboot-idle-gate-reconciliation',before:gate,after:next,first,last};
      writeRecoveryInTransaction(db,initial.value,next,audit);
      db.exec('COMMIT');
      console.log(JSON.stringify({mode:'applied',id,at:now,audit:'controller.db:maintenance_recoveries',after:next},null,2));
    } catch(error) {try{db.exec('ROLLBACK');}catch{} throw error;}
  }
} finally {db?.close();await Promise.all(held.map(s=>new Promise(resolve=>s.close(resolve))));}
