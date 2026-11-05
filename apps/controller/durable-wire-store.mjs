// Candidate Controller-owned proof storage. Only call record after the exact
// authenticated inference request has reached Strata and a complete verified
// tool-call SSE stream has been observed. This class does not perform either
// observation, does not contact a model and is not wired to a live endpoint.
import {ensureCoreTables} from './schema-integrity.mjs';
const sha=/^[a-f0-9]{64}$/,uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function validSession(sessionId){if(typeof sessionId!=='string'||!/^[\x21-\x7e]{1,160}$/.test(sessionId))throw Error('Invalid wire evidence session');return sessionId;}
function validHash(value){if(typeof value!=='string'||!sha.test(value))throw Error('Invalid wire evidence hash');return value;}
function check(row,sessionId){
  if(!row||row.sessionId!==sessionId||!uuid.test(row.intentId??''))throw Error('Invalid wire receipt identity');
  for(const key of ['receiptHash','receiptNonceHash','priorCallIdHash'])validHash(row[key]);
}
export class DurableWireStore {
  constructor(store){
    if(!store?.db||typeof store.transaction!=='function')throw Error('Controller transaction store is required');this.store=store;this.db=store.db;
    this.store.transaction(()=>ensureCoreTables(this.db,{marker:'durableWireCoreSchema:v1',tables:[{
      name:'durable_wire_evidence',create:'CREATE TABLE durable_wire_evidence(session_id TEXT NOT NULL,intent_id TEXT NOT NULL,receipt_hash TEXT NOT NULL,nonce_hash TEXT NOT NULL,prior_call_hash TEXT NOT NULL,next_call_hash TEXT NOT NULL,PRIMARY KEY(session_id,intent_id,receipt_hash,nonce_hash,prior_call_hash,next_call_hash))',
      columns:[['session_id','TEXT',1,1],['intent_id','TEXT',1,2],['receipt_hash','TEXT',1,3],['nonce_hash','TEXT',1,4],['prior_call_hash','TEXT',1,5],['next_call_hash','TEXT',1,6]],primary:['session_id','intent_id','receipt_hash','nonce_hash','prior_call_hash','next_call_hash'],
    }]}));
  }
  record({sessionId,receipts,nextCallIdHashes}){
    validSession(sessionId);if(!Array.isArray(receipts)||receipts.length>16||!Array.isArray(nextCallIdHashes)||nextCallIdHashes.length<1||nextCallIdHashes.length>16||new Set(nextCallIdHashes).size!==nextCallIdHashes.length)throw Error('Invalid wire evidence batch');
    for(const row of receipts)check(row,sessionId);for(const next of nextCallIdHashes)validHash(next);
    if(new Set(receipts.map(x=>x.intentId)).size!==receipts.length)throw Error('Duplicate wire receipt');
    return this.store.transaction(()=>{let n=0;for(const row of receipts)for(const next of nextCallIdHashes){const result=this.db.prepare('INSERT OR IGNORE INTO durable_wire_evidence VALUES(?,?,?,?,?,?)').run(sessionId,row.intentId,row.receiptHash,row.receiptNonceHash,row.priorCallIdHash,next);n+=result.changes;}return n;});
  }
  has({sessionId,intentId,receiptHash,receiptNonceHash,priorCallIdHash,nextCallIdHash}){
    validSession(sessionId);check({sessionId,intentId,receiptHash,receiptNonceHash,priorCallIdHash},sessionId);validHash(nextCallIdHash);
    return Boolean(this.db.prepare('SELECT 1 FROM durable_wire_evidence WHERE session_id=? AND intent_id=? AND receipt_hash=? AND nonce_hash=? AND prior_call_hash=? AND next_call_hash=?').get(sessionId,intentId,receiptHash,receiptNonceHash,priorCallIdHash,nextCallIdHash));
  }
}
