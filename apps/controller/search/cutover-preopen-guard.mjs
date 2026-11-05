// Durable guard for the interval before SQLite pending exists. This module
// does not restore a DB or retry a cutover after a crash.
import {openSync,writeFileSync,fsyncSync,closeSync,lstatSync,readFileSync,unlinkSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {safeEvidencePath} from './cutover-evidence-files.mjs';
import {openControllerPreopenEvidence} from './cutover-controller-preopen.mjs';
import {verifyCutoverBackup,verifyCutoverRecoveryIntent} from './cutover-backup.mjs';
import {cutoverForSession} from './cutover-ledger.mjs';

const guardPath=root=>join(root,'runtime/maintenance/controller-cutover-preopen.json');
export function assertNoControllerPreopenGuard(root){
 try{lstatSync(guardPath(root));}catch(error){if(error?.code==='ENOENT')return;throw Error('Controller cutover guard cannot be inspected');}
 throw Error('Controller cutover recovery is pending; preserve the database and backup');
}
export async function beginControllerPreopenGuard({runtimeRoot,preopen,controllerFence,hostEvidence}){
 if(typeof runtimeRoot!=='string'||!isAbsolute(runtimeRoot)||typeof controllerFence?.verifySync!=='function'||controllerFence.verifySync()!==true||typeof hostEvidence?.assertStableSync!=='function'||hostEvidence.assertStableSync()!==true||preopen?.controllerRecordSha256!==controllerFence.recordSha256)throw Error('Pre-open guard fence unavailable');
 const root=await safeEvidencePath(runtimeRoot,true),dir=await safeEvidencePath(join(root,'runtime/maintenance'),true),proof=openControllerPreopenEvidence(preopen);if(proof.assertStableSync()!==true)throw Error('Pre-open guard backup unavailable');
 const value={version:1,operationId:randomUUID(),preopenDirectory:preopen.directory,preopenManifestSha256:preopen.manifestSha256,controllerRecordSha256:preopen.controllerRecordSha256},bytes=Buffer.from(JSON.stringify(value)+'\n');let fd;try{fd=openSync(join(dir,'controller-cutover-preopen.json'),'wx',0o600);writeFileSync(fd,bytes);fsyncSync(fd);}finally{if(fd!==undefined)closeSync(fd);}
 if(controllerFence.verifySync()!==true||hostEvidence.assertStableSync()!==true||proof.assertStableSync()!==true)throw Error('Pre-open guard evidence changed; retain guard for recovery');return Object.freeze(value);
}
export function completeControllerPreopenGuard({runtimeRoot,guard,store,sessionId,backup,intent,controllerFence,hostEvidence}){
 const path=guardPath(runtimeRoot);try{
  const stat=lstatSync(path,{bigint:true});if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n||stat.size>8192n)return false;const bytes=readFileSync(path),value=JSON.parse(bytes);if(JSON.stringify(value)!==JSON.stringify(guard)||guard?.version!==1||backup?.preopenManifestSha256!==guard.preopenManifestSha256||controllerFence?.recordSha256!==guard.controllerRecordSha256||controllerFence.verifySync()!==true||hostEvidence?.assertStableSync?.()!==true||!verifyCutoverBackup(backup)||!verifyCutoverRecoveryIntent(backup,intent))return false;
  const generation=cutoverForSession(store.db,sessionId);if(!generation||generation.backup_hash!==backup.manifestSha256||generation.session_id!==intent.session_id||generation.generation_id!==intent.generation_id)return false;const after=lstatSync(path,{bigint:true});if(['dev','ino','size','mtimeNs','ctimeNs'].some(k=>stat[k]!==after[k]))return false;unlinkSync(path);return true;
 }catch{return false;}
}
