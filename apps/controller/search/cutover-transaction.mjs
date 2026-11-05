import {initializeSearchLedger} from './ledger-schema.mjs';
import {recordCutover,withCutoverCommitScope} from './cutover-ledger.mjs';
import {RunStore} from '../store.mjs';

// No production route or maintenance command calls this candidate yet. The
// caller must have committed beginCutover() and must hold verified Controller,
// Host and backup fences throughout this single SQLite write transaction.
export function commitPreparedCutover(store,row,verify){
 if(!(store instanceof RunStore)||store.transaction!==RunStore.prototype.transaction||!store.db||store.db.isTransaction||typeof verify!=='function')throw Error('Cutover transaction is unavailable');
 const result=store.transaction(()=>withCutoverCommitScope(store.db,()=>{
  const nested={db:store.db,transaction:fn=>fn()};
  initializeSearchLedger(nested,{enableGenerationSchema:true,verifyMigrationFence:verify});
  recordCutover(store.db,row,verify);
  return {state:'committed',sessionId:row.session_id,generationId:row.generation_id};
 }));
 if(store.db.isTransaction)throw Error('Cutover transaction did not commit');
 return result;
}
