import {createHash} from 'node:crypto';
import {hasBinaryPrimaryKey} from '../schema-integrity.mjs';
import {hasPendingCutoverGrant,inCutoverCommitScope} from './cutover-ledger.mjs';

const schemas={
  search_proposal_receipts:{definition:"session_id TEXT NOT NULL,request_id TEXT NOT NULL,payload_hash TEXT NOT NULL,proposal_id TEXT NOT NULL,proposal_hash TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('started','committed','abandoned')),PRIMARY KEY(session_id,request_id)",pk:['session_id','request_id']},
  search_proposal_abandons:{definition:'session_id TEXT NOT NULL,request_id TEXT NOT NULL,payload_hash TEXT NOT NULL,proposal_id TEXT NOT NULL,proposal_hash TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(session_id,request_id)',pk:['session_id','request_id']},
  search_approval_claims:{definition:'proposal_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,proposal_hash TEXT NOT NULL,targets_hash TEXT NOT NULL,claimed_at TEXT NOT NULL',pk:['proposal_id']},
  search_run_claims:{definition:'proposal_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,proposal_hash TEXT NOT NULL,run_id TEXT NOT NULL,claimed_at TEXT NOT NULL',pk:['proposal_id']},
  search_item_claims:{definition:'proposal_id TEXT NOT NULL,item_index INTEGER NOT NULL,session_id TEXT NOT NULL,proposal_hash TEXT NOT NULL,run_id TEXT NOT NULL,target_hash TEXT NOT NULL,claimed_at TEXT NOT NULL,PRIMARY KEY(proposal_id,item_index)',pk:['proposal_id','item_index']},
  search_proposal_cancels:{definition:'proposal_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,proposal_hash TEXT NOT NULL,accepted_at TEXT NOT NULL',pk:['proposal_id']},
  search_proposal_turn_bindings:{definition:'proposal_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,proposal_hash TEXT NOT NULL,turn INTEGER NOT NULL,turn_hash TEXT NOT NULL',pk:['proposal_id']},
  search_proposal_rejections:{definition:'session_id TEXT NOT NULL,request_id TEXT NOT NULL,payload_hash TEXT NOT NULL,http_status INTEGER NOT NULL,recorded_at TEXT NOT NULL,PRIMARY KEY(session_id,request_id)',pk:['session_id','request_id']},
};
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function validateSearchSessionTurns(db){
  const found=db.prepare("SELECT type FROM sqlite_master WHERE name='search_session_turns'").get(),columns=found?.type==='table'?db.prepare('PRAGMA table_xinfo(search_session_turns)').all():[];
  if(columns.length!==3||columns.some((c,i)=>c.name!==['session_id','latest','stopped_at'][i]||String(c.type).toUpperCase()!==(i===0?'TEXT':'INTEGER')||c.notnull!==(i===1?1:0)||c.hidden!==0||c.pk!==(i===0?1:0))||!hasBinaryPrimaryKey(db,'search_session_turns',['session_id']))throw Error('Search session turn schema is invalid');
}
function manifest(db){const data={};for(const [table,{pk}] of Object.entries(schemas))data[table]=db.prepare(`SELECT * FROM ${table} ORDER BY ${pk.join(',')}`).all();return JSON.stringify({sha256:sha(data),counts:Object.fromEntries(Object.entries(data).map(([key,rows])=>[key,rows.length]))});}
export function updateSearchLedgerManifest(store){const result=store.db.prepare("UPDATE meta SET value=? WHERE key='searchReceiptManifest:v1'").run(manifest(store.db));if(result.changes!==1)throw Error('Search receipt manifest is missing');}
export function initializeSearchLedger(store,{enableGenerationSchema=false,verifyMigrationFence=null}={}){
  if(typeof enableGenerationSchema!=='boolean'||verifyMigrationFence!==null&&typeof verifyMigrationFence!=='function')throw Error('Invalid search schema migration options');
  const db=store.db;store.transaction(()=>{
    const marker=db.prepare("SELECT value FROM meta WHERE key='searchReceiptSchema:v1'").get(),saved=db.prepare("SELECT value FROM meta WHERE key='searchReceiptManifest:v1'").get();
    const generationMarker=db.prepare("SELECT value FROM meta WHERE key='searchReceiptGenerations:v1'").get();
    if(marker&&marker.value!=='done'||marker&&!saved||saved&&!marker)throw Error('Search receipt marker or manifest is invalid');
    if(generationMarker&&(generationMarker.value!=='done'||!marker))throw Error('Search receipt generation marker is invalid');
    for(const [table,{definition,pk}] of Object.entries(schemas)){
      const found=db.prepare("SELECT type FROM sqlite_master WHERE name=?").get(table);if(!found){if(marker)throw Error('Search receipt table is missing after migration');db.exec(`CREATE TABLE ${table}(${definition})`);}else if(found.type!=='table')throw Error('Search receipt storage is not a table');
      const clean=definition.replace(/ CHECK\([^)]*\)/g,''),fields=clean.split(',PRIMARY KEY(')[0].split(',').map(part=>part.trim().split(/\s+/)),columns=db.prepare(`PRAGMA table_xinfo(${table})`).all();
      if(table==='search_proposal_receipts'&&generationMarker)fields.push(['generation_id','TEXT','NOT','NULL']);
      if(columns.length!==fields.length||columns.some((c,i)=>c.name!==fields[i][0]||String(c.type).toUpperCase()!==fields[i][1]||c.notnull!==(fields[i].includes('NOT')?1:0)||c.hidden!==0||c.pk!==(pk.indexOf(c.name)+1))||!hasBinaryPrimaryKey(db,table,pk))throw Error('Search receipt schema is invalid');
      if(table==='search_proposal_receipts'){const sql=db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(table)?.sql;if(typeof sql!=='string'||!sql.replace(/\s+/g,'').toLowerCase().includes("check(statein('started','committed','abandoned'))"))throw Error('Search receipt state constraint differs');}
    }
    const indexName=generationMarker?'search_proposal_pending_generation':'search_proposal_pending_session',index=db.prepare('SELECT type,sql FROM sqlite_master WHERE name=?').get(indexName),indexColumns=generationMarker?'session_id,generation_id':'session_id';
    if(!index){if(marker)throw Error('Search pending unique index is missing after migration');db.exec("CREATE UNIQUE INDEX search_proposal_pending_session ON search_proposal_receipts(session_id) WHERE state='started'");}
    else if(index.type!=='index'||typeof index.sql!=='string'||index.sql.replace(/\s+/g,'').toLowerCase()!==`createuniqueindex${indexName}onsearch_proposal_receipts(${indexColumns})wherestate='started'`)throw Error('Search pending unique index differs');
    const info=db.prepare('PRAGMA index_list(search_proposal_receipts)').all().find(item=>item.name===indexName),keys=db.prepare(`PRAGMA index_xinfo(${indexName})`).all().filter(item=>item.key===1),expectedKeys=indexColumns.split(',');
    if(!info||info.unique!==1||info.partial!==1||keys.length!==expectedKeys.length||keys.some((key,i)=>key.name!==expectedKeys[i]||key.coll!=='BINARY'||key.desc!==0))throw Error('Search pending unique index is invalid');
    const actual=manifest(db);if(saved&&saved.value!==actual)throw Error('Search receipt manifest differs');
    for(const row of db.prepare('SELECT * FROM search_proposal_receipts').all()){
      const abandon=db.prepare('SELECT * FROM search_proposal_abandons WHERE session_id=? AND request_id=?').get(row.session_id,row.request_id),rejection=db.prepare('SELECT 1 FROM search_proposal_rejections WHERE session_id=? AND request_id=?').get(row.session_id,row.request_id);
      if(!['started','committed','abandoned'].includes(row.state)||generationMarker&&row.generation_id!=='legacy'&&!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(row.generation_id??'')||!/^[a-f0-9]{64}$/.test(row.payload_hash??'')||!/^[a-f0-9]{64}$/.test(row.proposal_hash??'')||(row.state==='abandoned')!==Boolean(abandon)||rejection||(abandon&&(abandon.payload_hash!==row.payload_hash||abandon.proposal_hash!==row.proposal_hash||abandon.proposal_id!==row.proposal_id)))throw Error('Search proposal receipt evidence differs');
    }
    for(const row of db.prepare('SELECT * FROM search_proposal_abandons').all()){
      if(!db.prepare('SELECT 1 FROM search_proposal_receipts WHERE session_id=? AND request_id=?').get(row.session_id,row.request_id))throw Error('Search abandonment receipt origin is missing');
      const events=db.prepare("SELECT json FROM events WHERE run_id=? AND type='search_proposal_abandoned'").all(row.proposal_id);let data;try{if(events.length===1)data=JSON.parse(events[0].json);}catch{}
      if(events.length!==1||data?.sessionId!==row.session_id||data?.requestId!==row.request_id||data?.payloadHash!==row.payload_hash||data?.proposalHash!==row.proposal_hash)throw Error('Search abandonment receipt audit differs');
    }
    for(const event of db.prepare("SELECT run_id,json FROM events WHERE type='search_proposal_abandoned'").all()){let data;try{data=JSON.parse(event.json);}catch{}const row=data&&db.prepare('SELECT * FROM search_proposal_abandons WHERE session_id=? AND request_id=?').get(data.sessionId,data.requestId);if(!row||row.proposal_id!==event.run_id||row.payload_hash!==data.payloadHash||row.proposal_hash!==data.proposalHash)throw Error('Search abandonment audit has no matching receipt');}
    for(const row of db.prepare('SELECT * FROM search_proposal_rejections').all()){
      const events=db.prepare("SELECT json FROM events WHERE run_id=? AND type='search_proposal_rejected'").all(row.request_id).filter(event=>{try{return JSON.parse(event.json)?.sessionId===row.session_id;}catch{return false;}});let data;try{if(events.length===1)data=JSON.parse(events[0].json);}catch{}
      if(events.length!==1||data?.sessionId!==row.session_id||data?.requestId!==row.request_id||data?.payloadHash!==row.payload_hash||data?.httpStatus!==row.http_status||data?.recordedAt!==row.recorded_at)throw Error('Search rejection receipt audit differs');
    }
    for(const event of db.prepare("SELECT run_id,json FROM events WHERE type='search_proposal_rejected'").all()){let data;try{data=JSON.parse(event.json);}catch{}const row=data&&db.prepare('SELECT * FROM search_proposal_rejections WHERE session_id=? AND request_id=?').get(data.sessionId,data.requestId);if(!row||event.run_id!==row.request_id||data.payloadHash!==row.payload_hash||data.httpStatus!==row.http_status||data.recordedAt!==row.recorded_at)throw Error('Search rejection audit has no matching receipt');}
    if(!marker)db.prepare("INSERT INTO meta(key,value) VALUES('searchReceiptSchema:v1','done')").run();if(!saved)db.prepare("INSERT INTO meta(key,value) VALUES('searchReceiptManifest:v1',?)").run(actual);
    if(!generationMarker&&enableGenerationSchema){
      // No runtime caller supplies a verifier yet. Migration must happen only
      // while a verified old-Controller fence is independently held.
      if(typeof verifyMigrationFence!=='function'||!hasPendingCutoverGrant(db)||!inCutoverCommitScope(db)||verifyMigrationFence()!==true)throw Error('Search receipt migration fence or durable pending evidence is unavailable');
      // One transaction preserves the exact legacy rows and their original
      // manifest before replacing the admission uniqueness rule.
      db.exec("ALTER TABLE search_proposal_receipts ADD COLUMN generation_id TEXT NOT NULL DEFAULT 'legacy'; DROP INDEX search_proposal_pending_session; CREATE UNIQUE INDEX search_proposal_pending_generation ON search_proposal_receipts(session_id,generation_id) WHERE state='started'");
      db.prepare("INSERT INTO meta(key,value) VALUES('searchReceiptGenerations:v1','done')").run();updateSearchLedgerManifest(store);
    }
  });
}
