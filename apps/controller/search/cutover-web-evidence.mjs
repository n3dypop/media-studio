import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {beginCutover,invalidateCutoverGrant} from './cutover-ledger.mjs';
import {commitPreparedCutover} from './cutover-transaction.mjs';
import {verifyCutoverBackup,prepareCutoverRecoveryIntent,verifyCutoverRecoveryIntent} from './cutover-backup.mjs';
import {historyEvidenceSnapshotSync} from './cutover-evidence-files.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex');
// Candidate composition, not a public route. Call only inside the callback of
// withWebCutoverSessionLease. A real Host-stop verifier is still required and
// is deliberately not supplied by this module.
export function stageWebCutoverWithBackup({store,row,session,backup,historyDirectory,recordPath,assertSessionStableSync,controllerFence,verifyHostReceipt}={}){
 const candidate=structuredClone(row),evidence=structuredClone(backup),sessionEvidence=structuredClone(session);
 if(!store?.db||!candidate||!evidence||!sessionEvidence||typeof assertSessionStableSync!=='function'||typeof controllerFence?.verifySync!=='function'||typeof verifyHostReceipt!=='function'||candidate.session_id!==sessionEvidence.rawSessionId||candidate.boundary_turn!==sessionEvidence.turn||candidate.boundary_seq!==sessionEvidence.endSeq||candidate.session_hash!==sessionEvidence.filesHash||candidate.session_hash!==evidence.sessionFilesSha256||candidate.ledger_hash!==evidence.historyFilesSha256||candidate.database_hash!==evidence.databaseSha256||candidate.controller_hash!==controllerFence.recordSha256||candidate.controller_hash!==evidence.recordSha256||candidate.backup_hash!==evidence.manifestSha256||!/^[a-f0-9]{64}$/.test(evidence.hostFilesSha256??'')||!/^[a-f0-9]{64}$/.test(evidence.hostLedgerSha256??'')||!/^[a-f0-9]{64}$/.test(evidence.hostFenceSha256??'')||!/^[a-f0-9]{64}$/.test(evidence.preopenFilesSha256??'')||!/^[a-f0-9]{64}$/.test(evidence.preopenManifestSha256??'')||!/^[a-f0-9]{64}$/.test(evidence.preopenSnapshotSha256??'')||candidate.host_hash!==evidence.hostReceiptSha256)throw Error('Cutover intent does not match the held evidence');
 function verifyBase(){try{assertSessionStableSync();if(controllerFence.identity?.controllerId&&(store.controllerId!==controllerFence.identity.controllerId||store.db.prepare("SELECT value FROM meta WHERE key='controllerId'").get()?.value!==controllerFence.identity.controllerId))return false;if(controllerFence.verifySync()!==true||verifyHostReceipt(candidate.host_hash,sessionEvidence)!==true||!verifyCutoverBackup(evidence)||sha(readFileSync(recordPath))!==candidate.controller_hash||historyEvidenceSnapshotSync(historyDirectory).sha256!==candidate.ledger_hash)return false;return true;}catch{return false;}}
 if(!verifyBase())throw Error('Cutover recovery evidence is unavailable');prepareCutoverRecoveryIntent(evidence,candidate);
 function verifyCommon(){return verifyBase()&&verifyCutoverRecoveryIntent(evidence,candidate);}
 const {pendingHash}=beginCutover(store,candidate,()=>verifyCommon()&&sha(store.db.serialize())===candidate.database_hash);let used=false;
 return Object.freeze({commit(){if(used)throw Error('Cutover attempt was already used');used=true;let observedPending=false;const verify=()=>{if(!verifyCommon())return false;if(!observedPending){if(sha(store.db.serialize())!==pendingHash)return false;observedPending=true;}return true;};try{return commitPreparedCutover(store,candidate,verify);}catch(error){invalidateCutoverGrant(store.db);throw error;}}});
}
