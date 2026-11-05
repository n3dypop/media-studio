// Fixed-path owner verification candidate. The caller supplies trusted local
// installation pins and Host epoch, never HTTP request parameters.
// The candidate wrapper and maintenance route implement the pipe contract;
// deployment and live-runtime operation have not yet been verified.
import {createHash} from 'node:crypto';
import {readFile,realpath,lstat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {join,resolve,win32} from 'node:path';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function pinned(path,expected){
 if(!/^[a-f0-9]{64}$/.test(expected??'')||!(await lstat(path)).isFile()||(await lstat(path)).isSymbolicLink()||win32.normalize(await realpath(path)).toLowerCase()!==win32.normalize(resolve(path)).toLowerCase()||sha(await readFile(path))!==expected)throw Error('Maintenance component identity differs');
}
async function fenceBytes(path){
 const deadline=Date.now()+1000;
 for(;;){const item=await lstat(path);if(!item.isFile()||item.isSymbolicLink()||item.nlink!==1||win32.normalize(await realpath(path)).toLowerCase()!==win32.normalize(resolve(path)).toLowerCase()||item.size>16384)throw Error('Maintenance fence file differs');const bytes=await readFile(path);try{JSON.parse(bytes);return bytes;}catch{if(Date.now()>=deadline)throw Error('Maintenance fence is incomplete');await new Promise(done=>setTimeout(done,25));}}
}
export function createMaintenanceOwnerVerifier({installationRoot,runtimeRoot,pwshPath,helperHash,wrapperHash,pwshHash,epochProvider,spawnProcess=spawn}){
 if(typeof installationRoot!=='string'||typeof runtimeRoot!=='string'||typeof pwshPath!=='string'||typeof epochProvider!=='function'||typeof spawnProcess!=='function')throw TypeError('Maintenance owner dependencies are incomplete');
 const install=resolve(installationRoot),root=resolve(runtimeRoot),executable=resolve(pwshPath),helper=join(install,'scripts/maintenance/Verify-WebHostOwner.ps1'),wrapper=join(install,'scripts/maintenance/Invoke-WebSearchCutover.ps1'),fencePath=join(root,'runtime/maintenance/fence-ready.json');
 const verifyPins=()=>Promise.all([pinned(helper,helperHash),pinned(wrapper,wrapperHash),pinned(executable,pwshHash)]);
 return Object.freeze({async verify(){
  try{
   if(process.platform!=='win32')return false;await verifyPins();const epoch=await epochProvider();if(epoch?.pid!==process.pid||typeof epoch.startTimeUtcTicks!=='string'||!/^\d+$/.test(epoch.startTimeUtcTicks)||typeof epoch.executable!=='string'||win32.normalize(epoch.executable).toLowerCase()!==win32.normalize(process.execPath).toLowerCase())return false;
   const before=await fenceBytes(fencePath),fence=JSON.parse(before);if(!Number.isSafeInteger(fence.pid)||fence.pid<1||typeof fence.ticks!=='string'||!/^\d+$/.test(fence.ticks)||!/^[a-f0-9]{64}$/.test(fence.nonceHash??'')||fence.targetPid!==epoch.pid||fence.targetTicks!==epoch.startTimeUtcTicks||typeof fence.targetExe!=='string'||win32.normalize(fence.targetExe).toLowerCase()!==win32.normalize(epoch.executable).toLowerCase())return false;
   const ok=await new Promise(done=>{let settled=false,output='';const child=spawnProcess(executable,['-NoLogo','-NoProfile','-NonInteractive','-File',helper,'-Root',root,'-ExpectedPid',String(epoch.pid),'-ExpectedTicks',epoch.startTimeUtcTicks,'-ExpectedExe',epoch.executable],{windowsHide:true,shell:false,stdio:['pipe','pipe','ignore']});
    const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);done(value);};const timer=setTimeout(()=>{child.kill();finish(false);},10000);
    child.once('error',()=>finish(false));child.stdout.on('data',chunk=>{output+=chunk.toString();if(output.length>1024){child.kill();finish(false);}});child.once('exit',code=>finish(code===0&&output.trim()==='verified'));child.stdin.on('error',()=>finish(false));child.stdin.end();
   });if(!ok)return false;await verifyPins();const again=await epochProvider();if(again?.pid!==epoch.pid||again.startTimeUtcTicks!==epoch.startTimeUtcTicks||typeof again.executable!=='string'||win32.normalize(again.executable).toLowerCase()!==win32.normalize(epoch.executable).toLowerCase()||!(await fenceBytes(fencePath)).equals(before))return false;return {nonceHash:fence.nonceHash,fenceInfoHash:sha(before),holderPid:fence.pid,holderTicks:fence.ticks};
  }catch{return false;}
 }});
}
