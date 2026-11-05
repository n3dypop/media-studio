// Fixed Web cutover candidate. No installed launcher invokes it yet.
// A trusted wrapper must hold both launch locks, pin its fixed components,
// hold the Host process handle and pass the nonce only on standard input.
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open} from 'node:fs/promises';
import {readFileSync,lstatSync,unlinkSync} from 'node:fs';
import {join,resolve,dirname,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {RunStore} from '../store.mjs';
import {SearchService} from './service.mjs';
import {loadSearchConfiguration} from './config.mjs';
import {safeEvidencePath,stableEvidenceRead,historyEvidenceSnapshot} from './cutover-evidence-files.mjs';
import {createCombinedWrapperFenceVerifier} from './cutover-wrapper-fence.mjs';
import {prepareManagedHostStop} from './cutover-host-stop.mjs';
import {createControllerCutoverFence} from './cutover-controller-fence.mjs';
import {assertControllerIdleForCutover,assertManagedServicesIdle,shutdownOwnedController} from './cutover-controller-shutdown.mjs';
import {snapshotControllerBeforeRunStore,openControllerPreopenEvidence} from './cutover-controller-preopen.mjs';
import {beginControllerPreopenGuard,completeControllerPreopenGuard,assertNoControllerPreopenGuard} from './cutover-preopen-guard.mjs';
import {withStoppedWebHostObserver} from './cutover-host-observer.mjs';
import {withWebCutoverSessionLease} from './cutover-web-session-lease.mjs';
import {backupCutoverEvidence,verifyPrivateCutoverAcl} from './cutover-backup.mjs';
import {stageWebCutoverWithBackup} from './cutover-web-evidence.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex');
function absent(path){try{lstatSync(path);return false;}catch(error){if(error?.code==='ENOENT')return true;throw error;}}
async function writeNew(path,bytes){const file=await open(path,'wx',0o600);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}if(!readFileSync(path).equals(bytes))throw Error('Maintenance evidence could not be retained');}
function removeExact(path,bytes){const before=lstatSync(path,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||!readFileSync(path).equals(bytes))throw Error('Maintenance attempt evidence changed');const after=lstatSync(path,{bigint:true});if(['dev','ino','size','mtimeNs','ctimeNs'].some(k=>before[k]!==after[k]))throw Error('Maintenance attempt evidence changed');unlinkSync(path);}

export async function executeWebCutover({runtimeRoot,nonce}){
 if(typeof runtimeRoot!=='string'||!isAbsolute(runtimeRoot)||!/^[a-f0-9]{64}$/.test(nonce??''))throw Error('Maintenance input differs');
 const root=await safeEvidencePath(runtimeRoot,true),install=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),wrapper=join(install,'scripts/maintenance/Invoke-WebSearchCutover.ps1');assertNoControllerPreopenGuard(root);
 const both=createCombinedWrapperFenceVerifier({controllerLockPath:join(root,'runtime/Controller-launch.lock'),dshLockPath:join(root,'runtime/DSH-launch.lock'),scriptPath:wrapper});if(!both())throw Error('Maintenance owner is unavailable');
 const attemptPath=join(root,'runtime/maintenance/host-stop-attempt.json');if(!absent(attemptPath))throw Error('A Host stop attempt already needs inspection');
 const planPath=await safeEvidencePath(join(root,'runtime/maintenance/cutover-plan.json'),false),planBytes=await stableEvidenceRead(planPath,8192),plan=JSON.parse(planBytes);if(plan?.version!==1||Object.keys(plan).sort().join(',')!=='sessionId,turn,version'||typeof plan.sessionId!=='string'||!/^[\x21-\x7e]{1,150}$/.test(plan.sessionId)||!Number.isSafeInteger(plan.turn)||plan.turn<1)throw Error('Maintenance plan is unavailable');const planSha256=sha(planBytes),planUnchanged=()=>{try{return readFileSync(planPath).equals(planBytes);}catch{return false;}};
 const backupParent=await safeEvidencePath(join(root,'data/cutover-backups'),true),recordPath=await safeEvidencePath(join(root,'runtime/Controller.json'),false),recordBytes=await stableEvidenceRead(recordPath,65536),record=JSON.parse(recordBytes),recordSha256=sha(recordBytes),policyPath=await safeEvidencePath(join(root,'runtime/maintenance/route-policy.json'),false),policy=JSON.parse(await stableEvidenceRead(policyPath,16384));if(!isAbsolute(policy.pwshPath??'')||!/^[a-f0-9]{64}$/.test(policy.pwshSha256??'')||sha(await stableEvidenceRead(await safeEvidencePath(policy.pwshPath,false),128*1024*1024))!==policy.pwshSha256)throw Error('Desktop observation policy is unavailable');
 const desktop=()=>{const r=spawnSync(policy.pwshPath,['-NoLogo','-NoProfile','-NonInteractive','-File',join(install,'scripts/maintenance/Confirm-DesktopStopped.ps1')],{windowsHide:true,stdio:'ignore',timeout:12000});return r.status===0&&!r.error;};if(!desktop())throw Error('Desktop absence is unconfirmed');
 const host=await prepareManagedHostStop({runtimeRoot:root,nodeExecutable:process.execPath});await host.assertSessionReady(plan.sessionId,plan.turn);if(!planUnchanged()||!desktop())throw Error('Maintenance preflight changed');
 const recordDir=join(backupParent,'controller-record-'+randomUUID());await mkdir(recordDir,{mode:0o700});if(!verifyPrivateCutoverAcl(recordDir,true))throw Error('Controller record privacy is unavailable');const preserved=join(recordDir,'Controller.json');await writeNew(preserved,recordBytes);
 let fence,store,attemptBytes;try{
  fence=await createControllerCutoverFence({recordPath,preservedRecordPath:preserved,recordSha256,expectedExecutable:process.execPath,baseUrl:record.url,assertLaunchFence:both});if(!planUnchanged()||!desktop())throw Error('Maintenance preflight changed');await assertManagedServicesIdle({runtimeRoot:root});await assertControllerIdleForCutover({runtimeRoot:root,controllerFence:fence});if(!planUnchanged()||!desktop())throw Error('Maintenance preflight changed');
  const requestId=randomUUID();attemptBytes=Buffer.from(JSON.stringify({version:1,requestId,planSha256,controllerRecordSha256:recordSha256})+'\n');await writeNew(attemptPath,attemptBytes);
  await host.requestOnce(requestId);let gone=false;for(let i=0;i<240;i++){try{process.kill(host.identity.pid,0);}catch(error){if(error?.code==='ESRCH'){gone=true;break;}throw Error('Host exit could not be observed');}await new Promise(done=>setTimeout(done,250));}if(!gone)throw Error('Host exit is unconfirmed; retain the attempt evidence');
  return await withStoppedWebHostObserver({runtimeRoot:root,requestId,nonce},async observed=>{
   if(!planUnchanged()||!desktop())throw Error('Controller or Desktop state changed; retain the attempt evidence');await shutdownOwnedController({runtimeRoot:root,controllerFence:fence});
   const dbPath=join(root,'data/controller/controller.db'),preopen=await snapshotControllerBeforeRunStore({databasePath:dbPath,backupParent,controllerFence:fence}),preopenEvidence=openControllerPreopenEvidence(preopen),guard=await beginControllerPreopenGuard({runtimeRoot:root,preopen,controllerFence:fence,hostEvidence:observed});
   store=new RunStore(dbPath);new SearchService({root,...loadSearchConfiguration(root),enabled:false,store,requireTurnOwner:true});
   const settings=JSON.parse(await stableEvidenceRead(await safeEvidencePath(join(root,'config/environment.json'),false),65536)),dshHome=resolve(root,settings.dshHome??''),backend=resolve(settings.dshDirectory??''),storage=join(dshHome,'sessions'),historyDirectory=join(root,'data/search');
   return withWebCutoverSessionLease({mode:'web',dshDirectory:backend,sessionStorageRoot:storage,rawSessionId:plan.sessionId,turn:plan.turn},async(session,_assert,copySource,assertSessionStableSync)=>{
    const proof=observed.receipt.sessionProofs.find(x=>x.idHash===session.sessionIdHash);if(!proof||proof.eventsHash!==session.fullEventsHash||proof.sequence!==session.fullEventCount||!planUnchanged())throw Error('Planned session differs from Host evidence');
    store.db.exec('BEGIN IMMEDIATE');let backup;try{const history=await historyEvidenceSnapshot(historyDirectory);backup=await backupCutoverEvidence({parent:backupParent,runtimeRoot:join(root,'data/controller'),sessionStorageRoot:storage,recordPath:preserved,recordSha256,historyDirectory,history,session,copySource,assertSessionStableSync,assertControllerFence:()=>fence.verifySync(),db:store.db,databaseSha256:sha(store.db.serialize()),planSha256,hostEvidence:observed,preopenEvidence});store.db.exec('ROLLBACK');const row={session_id:plan.sessionId,generation_id:randomUUID(),boundary_turn:plan.turn,boundary_seq:session.endSeq,session_hash:session.filesHash,ledger_hash:history.sha256,database_hash:backup.databaseSha256,controller_hash:recordSha256,host_hash:observed.receiptSha256,backup_hash:backup.manifestSha256},verifyHostReceipt=(expected,s)=>expected===observed.receiptSha256&&observed.assertStableSync()===true&&observed.receipt.sessionProofs.some(x=>x.idHash===s.sessionIdHash&&x.eventsHash===s.fullEventsHash&&x.sequence===s.fullEventCount),operation=stageWebCutoverWithBackup({store,row,session,backup,historyDirectory,recordPath:preserved,assertSessionStableSync,controllerFence:fence,verifyHostReceipt});if(!planUnchanged())throw Error('Maintenance plan changed; retain recovery evidence');if(operation.commit().state!=='committed')throw Error('Cutover outcome is unconfirmed');removeExact(attemptPath,attemptBytes);if(!completeControllerPreopenGuard({runtimeRoot:root,guard,store,sessionId:plan.sessionId,backup,intent:row,controllerFence:fence,hostEvidence:observed}))throw Error('Cutover guard remains; inspect recovery evidence');return {state:'committed',backupManifestSha256:backup.manifestSha256};}catch(error){if(store.db.isTransaction)try{store.db.exec('ROLLBACK');}catch{}throw error;}
   });
  });
 }finally{store?.close();await fence?.close();}
}

if(process.argv[1]&&resolve(process.argv[1])===resolve(fileURLToPath(import.meta.url))){try{let nonce='';for await(const part of process.stdin)nonce+=part.toString();const result=await executeWebCutover({runtimeRoot:process.env.MEDIA_STUDIO_HOME,nonce:nonce.trim()});process.stdout.write(JSON.stringify(result)+'\n');}catch(error){process.stderr.write(String(error?.message??'Maintenance is on hold')+'\n');process.exitCode=1;}}
