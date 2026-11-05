// Candidate building block only: callers must use this separately for each
// mutation transaction and again immediately before each outbound request.
// No observation is cached across operations or asynchronous boundaries.
import {win32} from 'node:path';
import {cutoverForSession,currentCutoverTurn,requireCutoverTurn} from './cutover-ledger.mjs';

const validPid=n=>Number.isSafeInteger(n)&&n>0&&n<=0xffffffff;
const validTicks=s=>typeof s==='string'&&/^[1-9]\d{16,18}$/.test(s)&&BigInt(s)<=3155378975999999999n;
const validPath=s=>typeof s==='string'&&s.length<=32767&&win32.isAbsolute(s)&&!/[\u0000-\u001f]/.test(s);
const samePath=(a,b)=>win32.normalize(a).toLowerCase()===win32.normalize(b).toLowerCase();
function snapshot(db,sessionId,turn,registration){
 const cutover=cutoverForSession(db,sessionId),hosts=db.prepare("SELECT * FROM search_session_host_generations WHERE session_id=? AND state='active'").all(sessionId),owner=db.prepare('SELECT * FROM search_turn_owners WHERE session_id=? AND turn=?').get(sessionId,turn),turns=cutover?currentCutoverTurn(db,sessionId).row:db.prepare('SELECT * FROM search_session_turns WHERE session_id=?').get(sessionId),active=db.prepare("SELECT * FROM search_turn_owners WHERE session_id=? AND state='active' AND turn>? ORDER BY turn").all(sessionId,cutover?.boundary_turn??0),manifest=db.prepare("SELECT value FROM meta WHERE key='searchTurnOwnershipManifest:v1'").get(),host=hosts[0];
 if(cutover)requireCutoverTurn(db,sessionId,turn,owner?.start_seq);
 if(hosts.length!==1||!owner||owner.host_id!==host.host_id||!validPid(host.pid)||!validTicks(host.start_time_utc_ticks)||!validPath(host.executable)||!['active','completed'].includes(owner.state)||!Number.isSafeInteger(owner.start_seq)||owner.start_seq<1)throw Error('Search Host identity is unverified');
 if(owner.state==='active'&&(active.length!==1||active[0].turn!==turn||owner.end_seq!==null||owner.end_event_hash!==null))throw Error('Search active owner differs');
 if(owner.state==='completed'&&(active.length!==0||!Number.isSafeInteger(owner.end_seq)||owner.end_seq<=owner.start_seq||!/^[a-f0-9]{64}$/.test(owner.end_event_hash??'')))throw Error('Search completed owner differs');
 if(turns&&(!Number.isSafeInteger(turns.latest)||(registration?turns.latest>turn:turns.latest!==turn)||(turns.stopped_at!==null&&(!registration||turns.stopped_at>=turn))))throw Error('Search turn changed or stopped');
 if(typeof manifest?.value!=='string')throw Error('Search owner revision is unavailable');
 return {host,owner,turns:turns??null,active,cutover,manifest:manifest.value};
}
export async function withObservedOwnerTransaction({store,sessionId,turn,probe,operation,registration=false}){
 if(!store?.db||typeof store.transaction!=='function'||typeof sessionId!=='string'||!Number.isSafeInteger(turn)||turn<1||typeof probe?.processes!=='function'||typeof operation!=='function')throw Error('Search Host observation is unavailable');
 const before=snapshot(store.db,sessionId,turn,registration);let rows;
 try{rows=await probe.processes([before.host.pid]);}catch{throw Error('Search Host identity observation failed');}
 const row=Array.isArray(rows)&&rows.length===1?rows[0]:null;
 if(!row||row.pid!==before.host.pid||row.startTimeUtcTicks!==before.host.start_time_utc_ticks||!validPath(row.executable)||!samePath(row.executable,before.host.executable))throw Error('Search Host birth identity differs');
 return store.transaction(()=>{
  const after=snapshot(store.db,sessionId,turn,registration);
  if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Search Host generation changed while observing');
  const result=operation({owner:after.owner,host:after.host});
  if(result&&typeof result.then==='function')throw Error('Search mutation must be synchronous within the transaction');
  return result;
 });
}
