// Offline Web Host observer candidate. No live route imports this module.
// The caller must be the fixed maintenance entry, itself a child of the
// wrapper holding both native lock handles until the supplied callback ends.
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {createServer} from 'node:net';
import {spawnSync} from 'node:child_process';
import {readFileSync,lstatSync,realpathSync,existsSync} from 'node:fs';
import {join,resolve,relative,isAbsolute,dirname,win32} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {safeEvidencePath,stableEvidenceRead} from './cutover-evidence-files.mjs';
import {createCombinedWrapperFenceVerifier} from './cutover-wrapper-fence.mjs';
import {assertNoPendingInbox} from './cutover-web-session-lease.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex');
const canonical=x=>process.platform==='win32'?win32.normalize(resolve(x)).toLowerCase():resolve(x);
const contained=(root,path)=>{const r=relative(root,path);return r!==''&&!r.startsWith('..')&&!isAbsolute(r);};
const sameStat=(a,b)=>['dev','ino','size','mtimeNs','ctimeNs'].every(k=>a[k]===b[k]);
function stableSync(path,max){const before=lstatSync(path,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>BigInt(max)||canonical(realpathSync(path))!==canonical(path))throw Error('Host evidence path differs');const bytes=readFileSync(path),after=lstatSync(path,{bigint:true});if(!sameStat(before,after))throw Error('Host evidence changed during read');return bytes;}
function snapshotLedger(root){
 const db=join(root,'data/host-manager/maintenance-stop.sqlite');for(const suffix of ['-wal','-shm','-journal'])if(existsSync(db+suffix))throw Error('Host ledger sidecar needs inspection');
 const paths=[['maintenance-stop.sqlite',db],['maintenance-stop-provision.json',join(root,'data/maintenance-stop-provision.json')],['maintenance-stop-ready.json',join(root,'data/maintenance-stop-ready.json')]],files=paths.map(([name,path])=>({name,bytes:stableSync(path,16*1024*1024)})),rows=files.map(x=>({name:x.name,bytes:x.bytes.length,sha256:sha(x.bytes)})).sort((a,b)=>a.name.localeCompare(b.name));return {files,hash:sha(Buffer.from(JSON.stringify(rows)))};
}
function fixedLayout(root){
 const self=fileURLToPath(import.meta.url),install=resolve(dirname(self),'../../..'),namespace=dirname(install),plugins=dirname(namespace),runtimeBase=dirname(plugins),dsh=dirname(runtimeBase);
 if(process.platform!=='win32'||win32.basename(install)!=='media-studio'||win32.basename(namespace)!=='n3dypop'||win32.basename(plugins)!=='plugins'||win32.basename(runtimeBase)!=='.runtime'||canonical(root)!==canonical(join(runtimeBase,'media-studio')))throw Error('Installed Web runtime differs');
 return {self,install,namespace,runtimeBase,dsh,wrapper:join(install,'scripts/maintenance/Invoke-WebSearchCutover.ps1'),helper:join(install,'scripts/maintenance/Verify-WebHostOwner.ps1'),ledger:join(namespace,'dsh-plugins/apps/dsh-plugins/studio-host/maintenance-ledger.mjs'),restart:join(namespace,'dsh-plugins/apps/dsh-plugins/studio-host/restart-state.mjs')};
}

// No default nonce, no network access, and no automatic stop/restart/retry.
export async function withStoppedWebHostObserver({runtimeRoot,requestId,nonce},operation){
 if(typeof runtimeRoot!=='string'||!isAbsolute(runtimeRoot)||!/^[a-f0-9-]{36}$/.test(requestId??'')||!/^[a-f0-9]{64}$/.test(nonce??'')||typeof operation!=='function')throw Error('Web observer arguments differ');
 const root=await safeEvidencePath(runtimeRoot,true),layout=fixedLayout(root);await safeEvidencePath(layout.install,true);
 const manifestPath=await safeEvidencePath(join(root,'runtime/maintenance/approved-cutover-components.json'),false),manifestBytes=await stableEvidenceRead(manifestPath,32768),manifest=JSON.parse(manifestBytes);if(manifest.version!==1||canonical(manifest.runtimeRoot??'')!==canonical(root)||!manifest.pins||typeof manifest.pins!=='object')throw Error('Approved component manifest differs');
 const pinned=[['observer',layout.self],['wrapper',layout.wrapper],['hostVerifier',layout.helper],['hostStopLedger',layout.ledger],['restartState',layout.restart],['wrapperFence',join(layout.install,'apps/controller/search/cutover-wrapper-fence.mjs')],['sessionLease',join(layout.install,'apps/controller/search/cutover-web-session-lease.mjs')],['evidenceFiles',join(layout.install,'apps/controller/search/cutover-evidence-files.mjs')]];
 for(const [name,path] of pinned){if(!/^[a-f0-9]{64}$/.test(manifest.pins[name]??'')||sha(await stableEvidenceRead(await safeEvidencePath(path,false),16*1024*1024))!==manifest.pins[name])throw Error('Approved observer component differs');}
 const both=createCombinedWrapperFenceVerifier({controllerLockPath:join(root,'runtime/Controller-launch.lock'),dshLockPath:join(root,'runtime/DSH-launch.lock'),scriptPath:layout.wrapper});if(!both())throw Error('Maintenance owner is unavailable');
 const settingsPath=await safeEvidencePath(join(root,'config/environment.json'),false),settingsBytes=await stableEvidenceRead(settingsPath,65536),settings=JSON.parse(settingsBytes),dshHome=resolve(root,settings.dshHome??'');if(!contained(root,dshHome))throw Error('DSH home differs');await safeEvidencePath(dshHome,true);
 const backend=resolve(settings.dshDirectory??'');if(!isAbsolute(settings.dshDirectory??'')||!contained(join(layout.dsh,'.runtime/host'),backend))throw Error('DSH runtime differs');await safeEvidencePath(backend,true);const storage=await safeEvidencePath(join(dshHome,'sessions'),true);
 const recordPath=await safeEvidencePath(join(root,'runtime/DSH.json'),false),recordBytes=await stableEvidenceRead(recordPath,65536),record=JSON.parse(recordBytes),readyPath=await safeEvidencePath(join(root,'runtime/maintenance/fence-ready.json'),false),readyBytes=await stableEvidenceRead(readyPath,16384),ready=JSON.parse(readyBytes),ledgerBefore=snapshotLedger(root);
 const {openMaintenanceLedger}=await import(pathToFileURL(layout.ledger).href),ledger=await openMaintenanceLedger({root,readOnly:true});let prepared;try{prepared=await ledger.readPrepared(requestId);}finally{ledger.close();}if(snapshotLedger(root).hash!==ledgerBefore.hash)throw Error('Host ledger changed');
 const epoch=prepared.epoch,url=new URL(epoch.url);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||record.service!=='DSH'||record.processId!==epoch.pid||record.startTimeUtcTicks!==epoch.startTimeUtcTicks||record.url!==epoch.url||canonical(record.executable??'')!==canonical(epoch.executable)||prepared.owner.nonceHash!==sha(Buffer.from(nonce))||prepared.owner.fenceInfoHash!==sha(readyBytes)||prepared.owner.holderPid!==ready.pid||prepared.owner.holderTicks!==ready.ticks)throw Error('Prepared Host evidence differs');
 const verify=()=>{try{if(!both()||!stableSync(manifestPath,32768).equals(manifestBytes)||!stableSync(settingsPath,65536).equals(settingsBytes)||!stableSync(recordPath,65536).equals(recordBytes)||!stableSync(readyPath,16384).equals(readyBytes)||snapshotLedger(root).hash!==ledgerBefore.hash)return false;try{process.kill(epoch.pid,0);return false;}catch(error){if(error?.code!=='ESRCH')return false;}const result=spawnSync('pwsh',['-NoLogo','-NoProfile','-NonInteractive','-File',layout.helper,'-Root',root,'-ExpectedPid',String(epoch.pid),'-ExpectedTicks',epoch.startTimeUtcTicks,'-ExpectedExe',epoch.executable,'-HostExited'],{input:nonce+'\n',encoding:'utf8',windowsHide:true,timeout:12000});return result.status===0&&result.stdout.trim()==='verified';}catch{return false;}};
 if(!verify())throw Error('Host stop or owner is unconfirmed');const listener=createServer();await new Promise((ok,fail)=>listener.once('error',fail).listen(Number(url.port),'127.0.0.1',ok));let ctx;
 try{
  const require=createRequire(join(backend,'package.json'));if(require('@deepseek-ai/dsh-agent-loop/package.json').version!=='0.2.2-rc.1'||sha(readFileSync(require.resolve('@deepseek-ai/dsh-session-persistence-jsonl')))!=='69efef5f84dddf947032bc1425067878fa610416c8885acde2ded9b01230c9b7')throw Error('Unsupported DSH persistence backend');
  const {Context}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href),jsonl=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href);ctx=new Context();await ctx.plugin(jsonl,{root:storage}).await();const ids=(await ctx.sessionPersistence.list()).map(x=>x.header?.id).sort(),proofs=[];if(ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length)throw Error('Session catalog is incomplete');
  for(const id of ids){const handle=await ctx.sessionPersistence.open(id,'read');try{const events=(await handle.read(0,100001)).events;if(!Array.isArray(events)||events.length>100000||events.some((event,i)=>event.seq!==i))throw Error('Session history is incomplete');assertNoPendingInbox(events);proofs.push({idHash:sha(Buffer.from(id)),sequence:events.length,eventsHash:sha(Buffer.from(JSON.stringify(events)))});}finally{await handle.close();}}
  proofs.sort((a,b)=>a.idHash.localeCompare(b.idHash));const after=(await ctx.sessionPersistence.list()).map(x=>x.header?.id).sort();if(new Set(proofs.map(x=>x.idHash)).size!==proofs.length||JSON.stringify(ids)!==JSON.stringify(after)||JSON.stringify(proofs)!==JSON.stringify(prepared.sessionProofs)||sha(Buffer.from(JSON.stringify(proofs)))!==prepared.snapshotHash||ids.length!==prepared.sessionCount||!listener.listening||!verify())throw Error('Stored Host snapshot differs');
  await ctx.fiber.dispose();ctx=null;const receipt={state:'observed-absent',requestId,nonceHash:prepared.owner.nonceHash,preparedHash:sha(Buffer.from(JSON.stringify(prepared))),ledgerFilesHash:ledgerBefore.hash,fenceInfoHash:sha(readyBytes),holderPid:ready.pid,holderTicks:ready.ticks,snapshotHash:prepared.snapshotHash,sessionCount:proofs.length,sessionProofs:proofs,pid:epoch.pid,observedAt:new Date().toISOString()},receiptBytes=Buffer.from(JSON.stringify(receipt));let active=true;
  const assertStableSync=()=>{if(!active||!listener.listening||!verify())return false;for(const [name,path] of pinned){try{if(sha(stableSync(path,16*1024*1024))!==manifest.pins[name])return false;}catch{return false;}}return true;};
  const copySource=async()=>{if(!assertStableSync())throw Error('Host observer fence is unavailable');return [...snapshotLedger(root).files,{name:'fence-ready.json',bytes:Buffer.from(readyBytes)},{name:'stop-observed.json',bytes:Buffer.from(receiptBytes)}];};
  try{return await operation(Object.freeze({receipt,receiptSha256:sha(receiptBytes),assertStableSync,copySource}));}finally{active=false;}
 }finally{await ctx?.fiber.dispose();await new Promise(ok=>listener.close(ok));}
}
