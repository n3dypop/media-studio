// Live-then-stopped Controller evidence for a single maintenance process.
// This module does not stop a process, activate cutover, or prove Host/backup
// quiescence. The caller must hold the cooperative launch lock throughout.
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {resolve,dirname,isAbsolute,win32} from 'node:path';
import {probeWindowsEpoch,validateEpochEvidence} from '../epoch.mjs';
import {probeRetiredWindowsProcesses} from '../server-recovery.mjs';

const hash=x=>createHash('sha256').update(x).digest('hex');
const pathEqual=(a,b)=>win32.normalize(a).toLowerCase()===win32.normalize(b).toLowerCase();
function safeRead(file){
 if(!isAbsolute(file)||/^[\\/]{2}/.test(file))throw Error('Controller record path must be local and absolute');
 const target=resolve(file);for(let current=target;;current=dirname(current)){const s=lstatSync(current);if(s.isSymbolicLink()||(current===target?(!s.isFile()||s.nlink!==1):!s.isDirectory())||!pathEqual(realpathSync(current),current))throw Error('Controller record path is unsafe');const parent=dirname(current);if(parent===current)break;}
 const before=lstatSync(target,{bigint:true});if(before.size>65536n)throw Error('Controller record is too large');const bytes=readFileSync(target),after=lstatSync(target,{bigint:true});if(['dev','ino','size','mtimeNs','ctimeNs'].some(k=>before[k]!==after[k]))throw Error('Controller record changed while reading');return bytes;
}
function parse(bytes,expectedHash,expectedExecutable,baseUrl){
 if(!/^[a-f0-9]{64}$/.test(expectedHash??'')||hash(bytes)!==expectedHash)throw Error('Controller record hash differs');let row;try{row=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));}catch{throw Error('Controller record is invalid');}
 let url,expected;try{url=new URL(row?.url);expected=new URL(baseUrl);}catch{throw Error('Controller URL is invalid');}
 if(row?.service!=='Controller'||!Number.isSafeInteger(row.processId)||row.processId<1||typeof row.startTimeUtcTicks!=='string'||!/^[1-9]\d{16,18}$/.test(row.startTimeUtcTicks)||typeof row.executable!=='string'||!win32.isAbsolute(row.executable)||!win32.isAbsolute(expectedExecutable)||!pathEqual(row.executable,expectedExecutable)||typeof row.controllerId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(row.controllerId)||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.search||url.hash||url.pathname!=='/'||url.origin!==expected.origin||expected.protocol!=='http:'||expected.username||expected.password||expected.search||expected.hash||expected.pathname!=='/')throw Error('Controller record identity differs');
 return {pid:row.processId,startTimeUtcTicks:row.startTimeUtcTicks,executable:win32.normalize(row.executable).toLowerCase(),url:url.origin,port:Number(url.port),controllerId:row.controllerId};
}
export async function createControllerCutoverFence({recordPath,preservedRecordPath,recordSha256,expectedExecutable,baseUrl,assertLaunchFence,probe=probeWindowsEpoch,probeAbsent=probeRetiredWindowsProcesses,fetcher=fetch}={}){
 if(typeof assertLaunchFence!=='function'||assertLaunchFence()!==true)throw Error('Controller launch fence unavailable');
 const first=safeRead(recordPath),preserved=safeRead(preservedRecordPath);if(hash(first)!==hash(preserved))throw Error('Preserved Controller record differs');const identity=parse(first,recordSha256,expectedExecutable,baseUrl);
 async function live(){if(assertLaunchFence()!==true||hash(safeRead(recordPath))!==recordSha256||hash(safeRead(preservedRecordPath))!==recordSha256)throw Error('Controller fence or record changed');const observed=validateEpochEvidence(identity,await probe({pid:identity.pid,port:identity.port}));if(observed.listenerPid!==identity.pid)throw Error('Controller listener is not the managed PID');return observed;}
 async function checkLive(){await live();let health;try{const response=await fetcher(identity.url+'/health',{redirect:'error',signal:AbortSignal.timeout(5000)});if(!response.ok)throw Error();health=await response.json();}catch{throw Error('Controller health unavailable');}if(health?.service!=='local-image-controller'||health.ready!==true||health.pid!==identity.pid||health.controllerId!==identity.controllerId||health.activeRunId!==null)throw Error('Controller health or active run differs');await live();}
 await checkLive();
 let portServer=null,closed=false;
 async function absent(){const observed=await probeAbsent([identity.pid]),rows=observed?.processes;if(typeof observed?.observedAt!=='string'||!Number.isFinite(Date.parse(observed.observedAt))||!Array.isArray(rows)||rows.length!==1||rows[0]?.pid!==identity.pid||rows[0]?.exists!==false)throw Error('Old Controller absence is unproven');}
 return Object.freeze({identity,recordSha256,async verifyLive(){if(closed||portServer)return false;try{await checkLive();return true;}catch{return false;}},async holdStopped(){if(closed||portServer||assertLaunchFence()!==true)throw Error('Controller fence unavailable');await absent();portServer=createServer(socket=>socket.destroy());try{await new Promise((ok,fail)=>{portServer.once('error',fail);portServer.listen(identity.port,'127.0.0.1',()=>{portServer.off('error',fail);ok();});});await absent();if(!this.verifySync())throw Error('Controller fence changed');}catch(error){if(portServer?.listening)await new Promise(ok=>portServer.close(ok));portServer=null;throw error;}return {recordSha256,identity};},verifySync(){if(closed||!portServer?.listening||assertLaunchFence()!==true)return false;try{if(hash(safeRead(preservedRecordPath))!==recordSha256)return false;process.kill(identity.pid,0);return false;}catch(error){return error?.code==='ESRCH';}},async close(){closed=true;if(portServer?.listening)await new Promise(ok=>portServer.close(ok));portServer=null;}});
}
