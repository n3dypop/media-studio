// An owned DSH turn is not complete merely because pre-step or turn-stopping
// returned. Only the real persisted turn/end event can prove normal completion;
// unresolved search claims and legacy ownership remain on hold.
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {lstatSync,realpathSync} from 'node:fs';
import {isAbsolute,join,resolve,win32} from 'node:path';
import {assertOwnerManifest,updateOwnerManifest} from '../../controller/search/owner-manifest.mjs';
import {cutoverForSession,currentCutoverTurn,requireCutoverTurn} from '../../controller/search/cutover-ledger.mjs';
import {hasBinaryPrimaryKey} from '../../controller/schema-integrity.mjs';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
function identity(path,directory=false){const s=lstatSync(path);if(s.isSymbolicLink()||(directory?!s.isDirectory():!s.isFile())||(!directory&&s.nlink>1)||!same(resolve(realpathSync(path)),resolve(path)))throw Error('Turn owner path is unsafe');return {dev:s.dev,ino:s.ino};}
function sidecars(file){const found=[];for(const suffix of ['-wal','-shm'])try{found.push(identity(file+suffix));}catch(error){if(error.code!=='ENOENT')throw error;found.push(null);}if(found[0]&&!found[1])throw Error('Turn owner WAL identity is incomplete');}
const validSession=x=>typeof x==='string'&&/^[\x21-\x7e]{1,150}$/.test(x);
const validHost=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const validHash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const validTicks=x=>typeof x==='string'&&/^[1-9][0-9]{16,18}$/.test(x)&&BigInt(x)<=3155378975999999999n;
const isoUtc=x=>{if(typeof x!=='string')return false;try{return new Date(x).toISOString()===x;}catch{return false;}};
function hostSchema(db){
 if(db.prepare("SELECT value FROM meta WHERE key='searchSessionHosts:v1'").get()?.value!=='done')throw Error('Host generation migration is not complete');const columns=db.prepare('PRAGMA table_xinfo(search_session_host_generations)').all(),index=db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name='search_session_active_host'").get()?.sql,indexInfo=db.prepare('PRAGMA index_list(search_session_host_generations)').all().find(x=>x.name==='search_session_active_host'),indexKeys=db.prepare('PRAGMA index_xinfo(search_session_active_host)').all().filter(x=>x.key===1);
 if(columns.map(x=>x.name).join(',')!=='session_id,host_id,pid,state,start_time_utc_ticks,executable'||columns.some((c,i)=>String(c.type).toUpperCase()!==(i===2?'INTEGER':'TEXT')||c.notnull!==1||c.hidden!==0||c.pk!==(i===0?1:i===1?2:0)||(i>=4&&c.dflt_value!=="''"))||!hasBinaryPrimaryKey(db,'search_session_host_generations',['session_id','host_id'])||typeof index!=='string'||!/^CREATE\s+UNIQUE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?search_session_active_host\s+ON\s+search_session_host_generations\s*\(\s*session_id\s*\)\s+WHERE\s+state\s*=\s*'active'\s*$/i.test(index)||!indexInfo||indexInfo.unique!==1||indexInfo.partial!==1||indexKeys.length!==1||indexKeys[0].name!=='session_id'||indexKeys[0].coll!=='BINARY'||indexKeys[0].desc!==0||db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='trigger' AND tbl_name='search_session_host_generations'").get().n!==0||db.prepare('PRAGMA foreign_key_list(search_session_host_generations)').all().length!==0)throw Error('Host generation schema differs');
}
function validBirth(identity){return identity&&identity.pid===process.pid&&validTicks(identity.start_time_utc_ticks)&&typeof identity.executable==='string'&&win32.isAbsolute(identity.executable)&&win32.normalize(identity.executable).toLowerCase()===win32.normalize(process.execPath).toLowerCase();}
function ensureOwnHost(db,sessionId,hostId){hostSchema(db);const rows=db.prepare("SELECT * FROM search_session_host_generations WHERE session_id=? AND state='active'").all(sessionId),row=rows[0];if(rows.length!==1||row.host_id!==hostId||!validBirth({pid:row.pid,start_time_utc_ticks:row.start_time_utc_ticks,executable:row.executable}))throw Error('This Host generation is no longer active');}
function confirmedClaims(db,sessionId,turn,hostId,{allowUncertainAt=null}={}){
 const cutover=cutoverForSession(db,sessionId),claims=db.prepare('SELECT * FROM search_turn_owner_run_states WHERE session_id=? AND turn=? ORDER BY proposal_id').all(sessionId,turn),all=cutover?db.prepare('SELECT c.* FROM search_run_claims c JOIN search_cutover_proposals p ON p.proposal_id=c.proposal_id WHERE c.session_id=? AND p.session_id=? AND p.generation_id=?').all(sessionId,sessionId,cutover.generation_id):db.prepare('SELECT * FROM search_run_claims WHERE session_id=?').all(sessionId),relevant=[];
 for(const claim of all){const binding=db.prepare('SELECT * FROM search_proposal_turn_bindings WHERE proposal_id=?').get(claim.proposal_id);if(!binding||binding.session_id!==sessionId||binding.proposal_hash!==claim.proposal_hash||!validHash(binding.proposal_hash)||!validHash(binding.turn_hash)||!Number.isSafeInteger(binding.turn)||binding.turn<1)throw Error('Search claim has no valid turn binding');if(binding.turn===turn)relevant.push(claim);}
 if(claims.length!==relevant.length)throw Error('Search claim evidence is incomplete');
 const reconstructed=[];for(const row of claims){const claim=relevant.find(x=>x.proposal_id===row.proposal_id);if(!claim||row.host_id!==hostId||row.session_id!==sessionId||row.turn!==turn||row.run_id!==claim.run_id||db.prepare("SELECT value FROM meta WHERE key='searchTurnRunProcesses:v1'").get()?.value!=='done')throw Error('Search claim remains unresolved');
  const process=db.prepare('SELECT * FROM search_turn_owner_run_processes WHERE proposal_id=?').get(row.proposal_id);if(!process||process.run_id!==row.run_id||!validHost(process.controller_instance)||!Number.isSafeInteger(process.pid)||process.pid<1)throw Error('Search claim process evidence differs');
  if(row.state==='completed'){reconstructed.push(row);continue;}
  if(row.state!=='uncertain'||!isoUtc(allowUncertainAt))throw Error('Search claim remains unresolved');
  const audit=db.prepare('SELECT * FROM search_turn_owner_uncertain_claims WHERE proposal_id=?').get(row.proposal_id);
  if(!audit||audit.session_id!==sessionId||audit.turn!==turn||audit.host_id!==hostId||audit.run_id!==row.run_id||audit.run_id!==process.run_id||audit.controller_instance!==process.controller_instance||audit.pid!==process.pid||audit.recorded_at!==allowUncertainAt)throw Error('Uncertain search claim evidence differs');
  reconstructed.push({...row,state:'started'});
 }
 return digest(reconstructed);
}
function validateAbandoned(db,sessionId,row){
 const recovery=db.prepare('SELECT * FROM search_turn_owner_recoveries WHERE session_id=? AND turn=?').get(sessionId,row.turn),cutover=cutoverForSession(db,sessionId),stops=cutover?currentCutoverTurn(db,sessionId).row:db.prepare('SELECT latest,stopped_at FROM search_session_turns WHERE session_id=?').get(sessionId);
 if(!recovery||recovery.host_id!==row.host_id||recovery.start_seq!==row.start_seq||row.end_seq!==null||row.end_event_hash!==null||!(recovery.observed_latest===null||Number.isSafeInteger(recovery.observed_latest)&&recovery.observed_latest>=0&&recovery.observed_latest<=row.turn)||!(recovery.observed_stopped_at===null||Number.isSafeInteger(recovery.observed_stopped_at)&&recovery.observed_stopped_at>=0&&recovery.observed_stopped_at<=row.turn)||!isoUtc(recovery.recorded_at)||!validHash(recovery.claims_hash)||!stops||!Number.isSafeInteger(stops.latest)||stops.latest<row.turn||!Number.isSafeInteger(stops.stopped_at)||stops.stopped_at<row.turn||confirmedClaims(db,sessionId,row.turn,row.host_id,{allowUncertainAt:recovery.recorded_at})!==recovery.claims_hash)throw Error('Abandoned turn recovery evidence differs');
}
function legacySchema(db){
 if(db.prepare("SELECT value FROM meta WHERE key='searchTurnLegacy:v1'").get()?.value!=='done')throw Error('Legacy owner migration is not complete');
 for(const [name,names] of [['search_turn_owner_legacy_attestations','session_id,turn,host_id,start_seq,end_seq,event_count,events_hash,end_event_hash'],['search_turn_owner_legacy_migrations','session_id,turn,host_id,attestation_hash,observed_latest,observed_stopped_at,history_hash,recorded_at']]){const columns=db.prepare(`PRAGMA table_info(${name})`).all();if(columns.map(x=>x.name).join(',')!==names||columns[0]?.pk!==1||columns[1]?.pk!==2||db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='trigger' AND tbl_name=?").get(name).n!==0||db.prepare(`PRAGMA foreign_key_list(${name})`).all().length!==0)throw Error('Legacy owner schema differs');}
}
function validateLegacyBaseline(db,sessionId,turn){
 legacySchema(db);const migrations=db.prepare('SELECT * FROM search_turn_owner_legacy_migrations WHERE session_id=?').all(sessionId),m=migrations[0],a=db.prepare('SELECT * FROM search_turn_owner_legacy_attestations WHERE session_id=? AND turn=?').get(sessionId,turn-1),current=db.prepare('SELECT latest,stopped_at FROM search_session_turns WHERE session_id=?').get(sessionId);
 if(migrations.length!==1||!m||m.turn!==turn-1||!a||m.host_id!==a.host_id||!validHost(a.host_id)||!Number.isSafeInteger(a.start_seq)||a.start_seq<1||!Number.isSafeInteger(a.end_seq)||a.end_seq<=a.start_seq||a.event_count!==a.end_seq-a.start_seq+1||!validHash(a.events_hash)||!validHash(a.end_event_hash)||m.attestation_hash!==digest(a)||!validHash(m.history_hash)||!isoUtc(m.recorded_at)||!(m.observed_latest===null||Number.isSafeInteger(m.observed_latest)&&m.observed_latest>=0&&m.observed_latest<=m.turn)||m.observed_stopped_at!==null||(current&&(!Number.isSafeInteger(current.latest)||current.latest<0||current.latest>m.turn||current.stopped_at!==null))||(current?.latest??null)!==m.observed_latest||db.prepare('SELECT 1 FROM search_run_claims WHERE session_id=?').get(sessionId)||db.prepare("SELECT 1 FROM search_proposal_receipts WHERE session_id=? AND state='started'").get(sessionId))throw Error('Prior search turn ownership has no approved legacy baseline');
}
async function savedEvent({session,sessions,persistence,event}){
 if(await sessions.flush(session)!==true)throw Error('No session durability listener participated');await persistence.flush();
 const reader=await persistence.open(session.id,'read');let rows;try{if(reader.id!==session.id||reader.access!=='read')throw Error('Persisted session identity differs');rows=(await reader.read(event.seq,1))?.events;}finally{await reader.close();}
 if(!Array.isArray(rows)||rows.length!==1||digest(rows[0])!==digest(event))throw Error('The persisted turn boundary differs; keep search unresolved');
}
export async function durableStartedTurn({session,sessions,persistence,turn}){
 if(!session||typeof session.id!=='string'||typeof session.snapshotEvents!=='function'||typeof sessions?.flush!=='function'||typeof persistence?.flush!=='function'||typeof persistence?.open!=='function'||!Number.isSafeInteger(turn)||turn<1)throw Error('Turn persistence evidence is unavailable');
 const events=session.snapshotEvents(),starts=Array.isArray(events)?events.filter(x=>x.type==='turn/start'&&x.data?.turn===turn):[];
 if(starts.length!==1||!Number.isSafeInteger(starts[0].seq))throw Error('The owned turn has no unique start');await savedEvent({session,sessions,persistence,event:starts[0]});return {turn,startSeq:starts[0].seq};
}
export async function durableCompletedTurn({session,sessions,persistence,turn}){
 if(!session||typeof session.id!=='string'||typeof session.snapshotEvents!=='function'||typeof sessions?.flush!=='function'||typeof persistence?.flush!=='function'||typeof persistence?.open!=='function'||!Number.isSafeInteger(turn)||turn<1)throw Error('Turn persistence evidence is unavailable');
 const events=session.snapshotEvents();if(!Array.isArray(events))throw Error('Turn event history is unavailable');
 const starts=events.filter(x=>x.type==='turn/start'&&x.data?.turn===turn),ends=events.filter(x=>x.type==='turn/end'&&x.data?.turn===turn);
 if(starts.length!==1||ends.length!==1||!Number.isSafeInteger(starts[0].seq)||!Number.isSafeInteger(ends[0].seq)||ends[0].seq<=starts[0].seq||ends[0].data?.reason?.kind!=='completed')throw Error('The owned turn has no unique normal end; keep search unresolved');
 if(await sessions.flush(session)!==true)throw Error('No session durability listener participated');await persistence.flush();
 const reader=await persistence.open(session.id,'read');let startRows,endRows;
 try{if(reader.id!==session.id||reader.access!=='read')throw Error('Persisted session identity differs');startRows=(await reader.read(starts[0].seq,1))?.events;endRows=(await reader.read(ends[0].seq,1))?.events;}finally{await reader.close();}
 if(!Array.isArray(startRows)||startRows.length!==1||!Array.isArray(endRows)||endRows.length!==1||digest(startRows[0])!==digest(starts[0])||digest(endRows[0])!==digest(ends[0]))throw Error('The persisted turn boundary differs; keep search unresolved');
 return {turn,startSeq:starts[0].seq,endSeq:ends[0].seq,endEventHash:digest(ends[0])};
}

// For an existing session without owner rows, a maintainer may inspect this
// complete persisted turn range. Never persist or return the event bodies.
export async function durableLegacyTurnAttestation({session,sessions,persistence,turn}){
 if(!session||typeof session.id!=='string'||typeof session.snapshotEvents!=='function'||typeof sessions?.flush!=='function'||typeof persistence?.flush!=='function'||typeof persistence?.open!=='function'||!Number.isSafeInteger(turn)||turn<1)throw Error('Legacy turn evidence is unavailable');
 const all=session.snapshotEvents();if(!Array.isArray(all))throw Error('Legacy turn history is unavailable');const starts=all.filter(x=>x.type==='turn/start'&&x.data?.turn===turn),ends=all.filter(x=>x.type==='turn/end'&&x.data?.turn===turn);
 if(starts.length!==1||ends.length!==1||!Number.isSafeInteger(starts[0].seq)||!Number.isSafeInteger(ends[0].seq)||ends[0].seq<=starts[0].seq||ends[0].data?.reason?.kind!=='completed')throw Error('Legacy turn has no unique normal end');
 const range=all.filter(x=>Number.isSafeInteger(x.seq)&&x.seq>=starts[0].seq&&x.seq<=ends[0].seq);if(range.length!==ends[0].seq-starts[0].seq+1||range.some((x,i)=>x.seq!==starts[0].seq+i))throw Error('Legacy turn range is incomplete or reordered');
 if(await sessions.flush(session)!==true)throw Error('No session durability listener participated');await persistence.flush();const reader=await persistence.open(session.id,'read');
 try{if(reader.id!==session.id||reader.access!=='read')throw Error('Persisted session identity differs');for(const event of range){const saved=(await reader.read(event.seq,1))?.events;if(!Array.isArray(saved)||saved.length!==1||digest(saved[0])!==digest(event))throw Error('Legacy persisted turn range differs');}}finally{await reader.close();}
 return {turn,startSeq:starts[0].seq,endSeq:ends[0].seq,eventCount:range.length,eventsHash:digest(range),endEventHash:digest(ends[0])};
}

// The Controller must create and migrate the table, enforce ownership in its
// approval/send transactions, and provide administrative recovery before
// this can be enabled. This writer creates no DB, table, index or trigger.
export function pinTurnOwnerDatabase(runtimeRoot){
 if(typeof runtimeRoot!=='string'||!isAbsolute(runtimeRoot)||/^[\\/]{2}/.test(runtimeRoot))throw Error('Turn owner root must be local and absolute');
 const root=resolve(runtimeRoot),paths=[root,join(root,'data'),join(root,'data/controller'),join(root,'data/controller/controller.db')],initial=paths.map((p,i)=>identity(p,i<3)),file=paths[3];
 const unchanged=()=>{for(let i=0;i<paths.length;i++){const x=identity(paths[i],i<3);if(x.dev!==initial[i].dev||x.ino!==initial[i].ino)throw Error('Turn owner database generation changed');}};
 function transaction(fn){unchanged();sidecars(file);const db=new DatabaseSync(file);try{db.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;');if(db.prepare('PRAGMA synchronous').get()?.synchronous!==2||db.prepare('PRAGMA journal_mode').get()?.journal_mode?.toLowerCase()!=='wal')throw Error('Turn owner durability mode differs');db.exec('BEGIN IMMEDIATE;');unchanged();sidecars(file);assertOwnerManifest(db);
  if(db.prepare("SELECT value FROM meta WHERE key='searchTurnOwners:v1'").get()?.value!=='done')throw Error('Turn owner migration is not complete');const columns=db.prepare('PRAGMA table_info(search_turn_owners)').all();if(columns.map(x=>x.name).join(',')!=='session_id,turn,host_id,state,start_seq,end_seq,end_event_hash'||columns[0].pk!==1||columns[1].pk!==2||db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='trigger' AND tbl_name='search_turn_owners'").get().n!==0||db.prepare('PRAGMA foreign_key_list(search_turn_owners)').all().length!==0)throw Error('Turn owner schema differs');
  const result=fn(db);updateOwnerManifest(db);db.exec('COMMIT');unchanged();sidecars(file);return result;
 }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}finally{db.close();}}
 return Object.freeze({
  // The caller must obtain identity from the configured, hash-verified OS
  // probe before entering SQLite. A supplied PID alone is never birth proof.
  activate({sessionId,hostId,identity}){
   if(!validSession(sessionId)||!validHost(hostId)||!validBirth(identity))throw Error('Verified Host process birth is unavailable');
   return transaction(db=>{hostSchema(db);const rows=db.prepare('SELECT * FROM search_session_host_generations WHERE session_id=?').all(sessionId),active=rows.filter(x=>x.state==='active'),own=rows.find(x=>x.host_id===hostId);
    if(rows.some(x=>!validHost(x.host_id)||!Number.isSafeInteger(x.pid)||x.pid<1||!['active','superseded'].includes(x.state)||!validTicks(x.start_time_utc_ticks)||typeof x.executable!=='string'||!win32.isAbsolute(x.executable))||active.length>1)throw Error('Host generation evidence is malformed');
    if(own){if(own.state!=='active'||active.length!==1||own.pid!==identity.pid||own.start_time_utc_ticks!==identity.start_time_utc_ticks||win32.normalize(own.executable).toLowerCase()!==win32.normalize(identity.executable).toLowerCase())throw Error('A prior Host generation cannot be reused');return {sessionId,hostId,state:'active'};}
    if(active.length){const old=active[0];try{process.kill(old.pid,0);throw Error('The prior Host may still be alive');}catch(error){if(error?.code!=='ESRCH')throw Error('The prior Host may still be alive or its status is unknown');}const changed=db.prepare("UPDATE search_session_host_generations SET state='superseded' WHERE session_id=? AND host_id=? AND pid=? AND state='active'").run(sessionId,old.host_id,old.pid);if(changed.changes!==1)throw Error('The prior Host generation changed');}
    db.prepare("INSERT INTO search_session_host_generations(session_id,host_id,pid,state,start_time_utc_ticks,executable) VALUES(?,?,?,'active',?,?)").run(sessionId,hostId,identity.pid,identity.start_time_utc_ticks,identity.executable);return {sessionId,hostId,state:'active'};
   });
  },
  needsLegacyAttestation({sessionId,hostId,turn}){
   if(!validSession(sessionId)||!validHost(hostId)||!Number.isSafeInteger(turn)||turn<1)throw Error('Legacy owner identity is invalid');
   return transaction(db=>{ensureOwnHost(db,sessionId,hostId);legacySchema(db);return turn>1&&!db.prepare('SELECT 1 FROM search_turn_owners WHERE session_id=?').get(sessionId)&&!db.prepare('SELECT 1 FROM search_turn_owner_legacy_migrations WHERE session_id=?').get(sessionId)&&!cutoverForSession(db,sessionId);});
  },
  async begin({session,sessions,persistence,mapSessionId,turn,hostId}){
   const sessionId=mapSessionId?.(session?.id);if(!validSession(sessionId)||!validHost(hostId))throw Error('Turn owner identity is invalid');const started=await durableStartedTurn({session,sessions,persistence,turn});
   return transaction(db=>{ensureOwnHost(db,sessionId,hostId);const cutover=cutoverForSession(db,sessionId);if(cutover)requireCutoverTurn(db,sessionId,turn,started.startSeq);const rows=db.prepare('SELECT turn,host_id,state,start_seq,end_seq,end_event_hash FROM search_turn_owners WHERE session_id=? AND turn>? ORDER BY turn').all(sessionId,cutover?.boundary_turn??0);
    for(const row of rows){if(!Number.isSafeInteger(row.turn)||row.turn<1||!validHost(row.host_id)||!Number.isSafeInteger(row.start_seq)||row.start_seq<1)throw Error('An earlier search turn remains unresolved or malformed; maintenance must inspect it');if(row.state==='abandoned')validateAbandoned(db,sessionId,row);else if(row.state==='completed'&&Number.isSafeInteger(row.end_seq)&&row.end_seq>row.start_seq&&validHash(row.end_event_hash))confirmedClaims(db,sessionId,row.turn,row.host_id);else throw Error('An earlier search turn remains unresolved or malformed; maintenance must inspect it');}
    if(rows.length&&rows.at(-1).turn>=turn)throw Error('Turn owner generation is not newer');
    if(!rows.length&&turn!==1){if(cutoverForSession(db,sessionId))requireCutoverTurn(db,sessionId,turn,started.startSeq);else validateLegacyBaseline(db,sessionId,turn);}
    db.prepare("INSERT INTO search_turn_owners(session_id,turn,host_id,state,start_seq,end_seq,end_event_hash) VALUES(?,?,?,'active',?,NULL,NULL)").run(sessionId,turn,hostId,started.startSeq);return {sessionId,turn,hostId,state:'active'};
   });
  },
  async attestLegacy({session,sessions,persistence,mapSessionId,turn,hostId}){
   const sessionId=mapSessionId?.(session?.id);if(!validSession(sessionId)||!validHost(hostId))throw Error('Legacy owner identity is invalid');const evidence=await durableLegacyTurnAttestation({session,sessions,persistence,turn});
   return transaction(db=>{ensureOwnHost(db,sessionId,hostId);legacySchema(db);if(db.prepare('SELECT 1 FROM search_turn_owners WHERE session_id=?').get(sessionId)||db.prepare('SELECT 1 FROM search_turn_owner_legacy_migrations WHERE session_id=?').get(sessionId))throw Error('Session already has ownership or an approved legacy baseline');const row={session_id:sessionId,turn,host_id:hostId,start_seq:evidence.startSeq,end_seq:evidence.endSeq,event_count:evidence.eventCount,events_hash:evidence.eventsHash,end_event_hash:evidence.endEventHash},old=db.prepare('SELECT * FROM search_turn_owner_legacy_attestations WHERE session_id=? AND turn=?').get(sessionId,turn);if(old&&digest(old)!==digest(row))throw Error('Existing legacy attestation differs');if(!old)db.prepare('INSERT INTO search_turn_owner_legacy_attestations VALUES(?,?,?,?,?,?,?,?)').run(...Object.values(row));return {sessionId,turn,hostId,startSeq:evidence.startSeq,endSeq:evidence.endSeq,eventCount:evidence.eventCount,eventsHash:evidence.eventsHash,endEventHash:evidence.endEventHash};});
  },
  async complete({session,sessions,persistence,mapSessionId,turn,hostId}){
   const sessionId=mapSessionId?.(session?.id);if(!validSession(sessionId)||!validHost(hostId))throw Error('Turn owner identity is invalid');const evidence=await durableCompletedTurn({session,sessions,persistence,turn});
   return transaction(db=>{ensureOwnHost(db,sessionId,hostId);const cutover=cutoverForSession(db,sessionId);if(cutover)requireCutoverTurn(db,sessionId,turn,evidence.startSeq);confirmedClaims(db,sessionId,turn,hostId);const changed=db.prepare("UPDATE search_turn_owners SET state='completed',end_seq=?,end_event_hash=? WHERE session_id=? AND turn=? AND host_id=? AND state='active' AND start_seq=? AND end_seq IS NULL AND end_event_hash IS NULL").run(evidence.endSeq,evidence.endEventHash,sessionId,turn,hostId,evidence.startSeq);if(changed.changes!==1)throw Error('Turn owner changed or was not active');return {sessionId,turn,hostId,state:'completed',endSeq:evidence.endSeq};});
  }
 });
}
