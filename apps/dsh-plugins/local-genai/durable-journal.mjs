// Private durable admission journal. This module does not issue requests,
// validate Controller responses, or infer that a result reached the DSH user.
// Callers must provide verified receipt hashes and separately establish delivery
// before acknowledging. Unacknowledged intents never expire automatically.
import { DatabaseSync } from 'node:sqlite';
import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { lstatSync,readFileSync } from 'node:fs';
import { lstat, mkdir, realpath, open, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { noLinks } from '../shared/runtime-files.mjs';

const idPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const shaPattern=/^[a-f0-9]{64}$/;
const sessionPattern=/^[\x21-\x7e]{1,160}$/;
const sourceKinds=new Set(['controller-response','verified-controller-read']);
const outcomes=new Set(['applied','rejected']);
const operations=new Set(['create','cancel','asset-import','workflow-draft','moss-pe-start','moss-pe-decision','moss-pe-reconcile','qwen-pe-start','qwen-pe-decision','qwen-pe-reconcile','prepared-render','render','evaluate','feedback','iteration','search-proposal']);
const toolPattern=/^[a-z][a-z0-9_]{0,95}$/;
const provisionText=id=>`media-studio-durable-journal-v1:${id}\n`;
const schemaSql={
  intents:`CREATE TABLE intents(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,lane TEXT NOT NULL CHECK(lane IN ('normal','cancel')),operation TEXT NOT NULL,request_id TEXT,input_hash TEXT NOT NULL,correlation_hash TEXT,target_id TEXT,call_id_hash TEXT,tool_name TEXT,turn INTEGER,step INTEGER,parent_intent_id TEXT,delivery_call_id_hash TEXT,delivery_tool_name TEXT,delivery_turn INTEGER,delivery_step INTEGER,state TEXT NOT NULL CHECK(state IN ('intent','receipt','acknowledged')),receipt_hash TEXT,receipt_source TEXT,outcome TEXT,ack_nonce_hash TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`,
  delivery_claims:`CREATE TABLE delivery_claims(session_id TEXT NOT NULL,call_id_hash TEXT NOT NULL,intent_id TEXT NOT NULL,PRIMARY KEY(session_id,call_id_hash))`,
  journal_identity:`CREATE TABLE journal_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation TEXT NOT NULL)`,
  journal_manifest:`CREATE TABLE journal_manifest(singleton INTEGER PRIMARY KEY CHECK(singleton=1),digest TEXT NOT NULL)`,
  session_request_id:`CREATE UNIQUE INDEX session_request_id ON intents(session_id,request_id) WHERE request_id IS NOT NULL`,
  session_open_normal:`CREATE UNIQUE INDEX session_open_normal ON intents(session_id) WHERE lane='normal' AND state!='acknowledged'`,
  session_open_cancel_target:`CREATE UNIQUE INDEX session_open_cancel_target ON intents(session_id,target_id) WHERE lane='cancel' AND state!='acknowledged'`,
  session_normal_call:`CREATE UNIQUE INDEX session_normal_call ON intents(session_id,call_id_hash) WHERE call_id_hash IS NOT NULL AND lane='normal'`,
  session_cancel_call_target:`CREATE UNIQUE INDEX session_cancel_call_target ON intents(session_id,call_id_hash,target_id) WHERE call_id_hash IS NOT NULL AND lane='cancel'`,
  session_delivery_call:`CREATE UNIQUE INDEX session_delivery_call ON intents(session_id,delivery_call_id_hash) WHERE delivery_call_id_hash IS NOT NULL`,
};
function normalizeSql(sql){
  let out='',quoted=false;const text=String(sql??'');
  for(let i=0;i<text.length;i++){const c=text[i];if(c==="'"){out+=c;if(quoted&&text[i+1]==="'"){out+=text[++i];continue;}quoted=!quoted;continue;}if(quoted)out+=c;else if(!/\s/.test(c))out+=c.toLowerCase();}
  return out.replace(/^(createtable|createuniqueindex)ifnotexists/,'$1');
}
function assertJournalSchema(db,{allowMissingIdentity=false}={}){
  for(const [name,expected] of Object.entries(schemaSql)){
    const row=db.prepare('SELECT type,sql FROM sqlite_schema WHERE name=?').get(name),type=['intents','delivery_claims','journal_identity','journal_manifest'].includes(name)?'table':'index';
    if(['journal_identity','journal_manifest'].includes(name)&&!row&&allowMissingIdentity)continue;
    if(row?.type!==type||normalizeSql(row.sql)!==normalizeSql(expected))throw Error(`Durable journal schema is missing or inconsistent: ${name}`);
  }
  for(const table of ['intents','delivery_claims','journal_identity','journal_manifest']){
    if(allowMissingIdentity&&['journal_identity','journal_manifest'].includes(table)&&!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table))continue;
    if(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND tbl_name=? LIMIT 1").get(table)||db.prepare(`PRAGMA foreign_key_list(${table})`).all().length)throw Error(`Durable journal has unexpected dependencies: ${table}`);
  }
  if(db.prepare('SELECT 1 FROM intents i WHERE i.delivery_call_id_hash IS NOT NULL AND NOT EXISTS (SELECT 1 FROM delivery_claims d WHERE d.session_id=i.session_id AND d.call_id_hash=i.delivery_call_id_hash AND d.intent_id=i.id) LIMIT 1').get()||db.prepare('SELECT 1 FROM delivery_claims d LEFT JOIN intents i ON i.id=d.intent_id AND i.session_id=d.session_id WHERE i.id IS NULL LIMIT 1').get())throw Error('Durable journal delivery claims are inconsistent');
}
function journalDigest(db){const intents=db.prepare('SELECT * FROM intents ORDER BY rowid').all(),claims=db.prepare('SELECT * FROM delivery_claims ORDER BY session_id,call_id_hash').all();return createHash('sha256').update(JSON.stringify({intents,claims})).digest('hex');}
function assertJournalManifest(db){const rows=db.prepare('SELECT singleton,digest FROM journal_manifest').all();if(rows.length!==1||rows[0].singleton!==1||rows[0].digest!==journalDigest(db))throw Error('Durable journal state manifest differs');}
function updateJournalManifest(db){if(db.prepare('UPDATE journal_manifest SET digest=? WHERE singleton=1').run(journalDigest(db)).changes!==1)throw Error('Durable journal state manifest is missing');}
async function ordinaryFile(path){try{const st=await lstat(path);if(!st.isFile()||st.isSymbolicLink()||st.nlink>1)throw Error('Journal file must be an ordinary file without hard links');return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function createProvisionMarker(path,id){const file=await open(path,'wx');try{await file.writeFile(provisionText(id),'utf8');await file.sync();}finally{await file.close();}}
function assertProvisionMarker(path,id){try{const st=lstatSync(path);if(!st.isFile()||st.isSymbolicLink()||st.nlink>1||st.size>128||readFileSync(path,'utf8')!==provisionText(id))throw Error('marker differs');}catch{throw Error('Durable journal provisioning marker is unavailable or changed');}}
function validSession(value){if(typeof value!=='string'||!sessionPattern.test(value))throw Error('Invalid session identity');return value;}
function validId(value){if(typeof value!=='string'||!idPattern.test(value))throw Error('Invalid journal identity');return value;}
function validHash(value){if(typeof value!=='string'||!shaPattern.test(value))throw Error('Invalid proof hash');return value;}
function exactKeys(input,allowed){if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!allowed.includes(k)))throw Error('Invalid journal input');}
function rowValue(row){return row?{id:row.id,sessionId:row.session_id,lane:row.lane,operation:row.operation,requestId:row.request_id,inputHash:row.input_hash,correlationHash:row.correlation_hash,targetId:row.target_id,callIdHash:row.call_id_hash,toolName:row.tool_name,turn:row.turn,step:row.step,parentIntentId:row.parent_intent_id,deliveryCallIdHash:row.delivery_call_id_hash,deliveryToolName:row.delivery_tool_name,deliveryTurn:row.delivery_turn,deliveryStep:row.delivery_step,state:row.state,receiptHash:row.receipt_hash,receiptSource:row.receipt_source,outcome:row.outcome,createdAt:row.created_at,updatedAt:row.updated_at}:null;}

async function databasePath(runtimeRoot){
  if(typeof runtimeRoot!=='string'||!isAbsolute(runtimeRoot)||/^[\\/]{2}/.test(runtimeRoot))throw Error('Absolute local runtime root is required');
  const root=resolve(runtimeRoot),actual=resolve(await realpath(root));
  const same=process.platform==='win32'?actual.toLowerCase()===root.toLowerCase():actual===root;
  if(!same)throw Error('Redirected runtime root is unsupported');
  await noLinks(root,root);
  const data=join(root,'data');await noLinks(root,data);
  if(!(await lstat(data)).isDirectory())throw Error('Runtime data directory is unavailable');
  const directory=join(data,'dsh-mutations');
  try{await mkdir(directory);}catch(error){if(error.code!=='EEXIST')throw error;}
  await noLinks(root,directory);
  if(!(await lstat(directory)).isDirectory())throw Error('Journal directory is unavailable');
  const path=join(directory,'intents.sqlite'),markerPath=join(data,'media-studio-durable-provision');
  for(const file of [path,path+'-wal',path+'-shm',markerPath]){
    await noLinks(root,file,{missing:true});
    try{const st=await lstat(file);if(!st.isFile()||st.nlink>1)throw Error('Journal file must be an ordinary file without hard links');}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  return {path,markerPath,existed:await ordinaryFile(path),markerExisted:await ordinaryFile(markerPath)};
}

export async function openMutationJournal(runtimeRoot){
  const {path,markerPath,existed,markerExisted}=await databasePath(runtimeRoot);
  let generation=markerExisted?(await readFile(markerPath,'utf8')).match(/^media-studio-durable-journal-v1:([a-f0-9-]{36})\n$/)?.[1]:null;
  if(markerExisted&&(!generation||!idPattern.test(generation)))throw Error('Durable journal provisioning marker is inconsistent');
  if(markerExisted&&!existed)throw Error('Previously provisioned durable journal is missing; do not recreate it');
  if(!markerExisted&&!existed){generation=randomUUID();await createProvisionMarker(markerPath,generation);}
  const db=new DatabaseSync(path);
  try{
    db.exec('PRAGMA busy_timeout=3000;');
    const journal=db.prepare('PRAGMA journal_mode=WAL').get()?.journal_mode;
    if(typeof journal!=='string'||journal.toLowerCase()!=='wal')throw Error('Durable WAL mode is unavailable');
    db.exec('PRAGMA synchronous=FULL;');
    if(db.prepare('PRAGMA synchronous').get()?.synchronous!==2)throw Error('Durable synchronous mode is unavailable');
    const version=db.prepare('PRAGMA user_version').get().user_version;
    if(version!==4&&!(version===0&&!existed))throw Error('Unsupported or unverified mutation journal version; preserve it for maintenance');
    if(version===4){
      db.exec('BEGIN IMMEDIATE');assertJournalSchema(db,{allowMissingIdentity:!markerExisted});
      const identity=db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='journal_identity'").get();
      const manifest=db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='journal_manifest'").get();
      if(identity&&!markerExisted)throw Error('Durable journal provisioning marker is missing; preserve it for maintenance');
      if(Boolean(identity)!==Boolean(manifest))throw Error('Durable journal generation and manifest are inconsistent');
      if(!identity){generation=randomUUID();db.exec(schemaSql.journal_identity);db.prepare('INSERT INTO journal_identity VALUES (1,?)').run(generation);db.exec(schemaSql.journal_manifest);db.prepare('INSERT INTO journal_manifest VALUES (1,?)').run(journalDigest(db));}
      else {const rows=db.prepare('SELECT singleton,generation FROM journal_identity').all();if(rows.length!==1||rows[0].singleton!==1||!idPattern.test(rows[0].generation??'')||(generation!==null&&generation!==rows[0].generation))throw Error('Durable journal generation differs from provisioning marker');generation=rows[0].generation;}
      assertJournalSchema(db);assertJournalManifest(db);db.exec('COMMIT');
    }
    else {db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS intents(
        id TEXT PRIMARY KEY,session_id TEXT NOT NULL,lane TEXT NOT NULL CHECK(lane IN ('normal','cancel')),
        operation TEXT NOT NULL,request_id TEXT,input_hash TEXT NOT NULL,correlation_hash TEXT,target_id TEXT,
        call_id_hash TEXT,tool_name TEXT,turn INTEGER,step INTEGER,
        parent_intent_id TEXT,delivery_call_id_hash TEXT,delivery_tool_name TEXT,delivery_turn INTEGER,delivery_step INTEGER,
        state TEXT NOT NULL CHECK(state IN ('intent','receipt','acknowledged')),
        receipt_hash TEXT,receipt_source TEXT,outcome TEXT,ack_nonce_hash TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS session_request_id ON intents(session_id,request_id) WHERE request_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS session_open_normal ON intents(session_id) WHERE lane='normal' AND state!='acknowledged';
      CREATE UNIQUE INDEX IF NOT EXISTS session_open_cancel_target ON intents(session_id,target_id) WHERE lane='cancel' AND state!='acknowledged';
      CREATE TABLE IF NOT EXISTS delivery_claims(session_id TEXT NOT NULL,call_id_hash TEXT NOT NULL,intent_id TEXT NOT NULL,PRIMARY KEY(session_id,call_id_hash));
      CREATE TABLE journal_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation TEXT NOT NULL);
      CREATE TABLE journal_manifest(singleton INTEGER PRIMARY KEY CHECK(singleton=1),digest TEXT NOT NULL);
      `);
    db.prepare('INSERT INTO journal_identity VALUES (1,?)').run(generation);
    db.prepare('INSERT INTO journal_manifest VALUES (1,?)').run(journalDigest(db));
    db.exec(`DROP INDEX IF EXISTS session_call_id;
      INSERT OR IGNORE INTO delivery_claims(session_id,call_id_hash,intent_id) SELECT session_id,delivery_call_id_hash,id FROM intents WHERE delivery_call_id_hash IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS session_normal_call ON intents(session_id,call_id_hash) WHERE call_id_hash IS NOT NULL AND lane='normal';
      CREATE UNIQUE INDEX IF NOT EXISTS session_cancel_call_target ON intents(session_id,call_id_hash,target_id) WHERE call_id_hash IS NOT NULL AND lane='cancel';
      CREATE UNIQUE INDEX IF NOT EXISTS session_delivery_call ON intents(session_id,delivery_call_id_hash) WHERE delivery_call_id_hash IS NOT NULL;
      PRAGMA user_version=4; COMMIT;`);}
    assertJournalSchema(db);assertJournalManifest(db);
    if(!markerExisted&&existed)await createProvisionMarker(markerPath,generation);
    assertProvisionMarker(markerPath,generation);
  }catch(error){try{db.exec('ROLLBACK');}catch{}db.close();throw error;}
  let closed=false;
  const ensureOpen=()=>{if(closed)throw Error('Mutation journal is closed');assertProvisionMarker(markerPath,generation);};
  const transact=fn=>{
    ensureOpen();db.exec('BEGIN IMMEDIATE');
    try{assertJournalSchema(db);assertJournalManifest(db);const result=fn();updateJournalManifest(db);db.exec('COMMIT');return result;}
    catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
  };
  const readSnapshot=fn=>{ensureOpen();db.exec('BEGIN');try{assertJournalSchema(db);assertJournalManifest(db);const value=fn();db.exec('COMMIT');return value;}catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}};
  const get=(sessionId,id)=>rowValue(db.prepare('SELECT * FROM intents WHERE session_id=? AND id=?').get(sessionId,id));
  return Object.freeze({
    begin(input){
      exactKeys(input,['sessionId','lane','operation','requestId','inputHash','correlationHash','targetId','callIdHash','toolName','turn','step','parentIntentId']);
      const sessionId=validSession(input.sessionId),lane=input.lane;
      if(!['normal','cancel'].includes(lane)||!operations.has(input.operation)||(lane==='cancel')!==(input.operation==='cancel'))throw Error('Invalid operation or lane');
      const requestId=input.requestId??null,correlationHash=input.correlationHash??null,targetId=input.targetId??null;
      if(requestId!==null)validId(requestId);
      validHash(input.inputHash);if(correlationHash!==null)validHash(correlationHash);
      validHash(input.callIdHash);
      if(typeof input.toolName!=='string'||!toolPattern.test(input.toolName)||!Number.isSafeInteger(input.turn)||input.turn<1||!Number.isSafeInteger(input.step)||input.step<1)throw Error('Invalid DSH call identity');
      if(targetId!==null)validId(targetId);if(lane==='cancel'&&targetId===null)throw Error('Cancellation requires an owned target identity');
      const parentId=input.parentIntentId??null;if(parentId!==null){validId(parentId);if(lane!=='cancel')throw Error('Only a cancellation can have an internal parent');}
      return transact(()=>{
        if(lane==='normal'&&db.prepare("SELECT id FROM intents WHERE session_id=? AND state!='acknowledged' LIMIT 1").get(sessionId))throw Error('A previous mutation remains unresolved');
        if(db.prepare('SELECT intent_id FROM delivery_claims WHERE session_id=? AND call_id_hash=? LIMIT 1').get(sessionId,input.callIdHash))throw Error('UNIQUE constraint: DSH delivery call already used');
        const anyCall=db.prepare('SELECT id FROM intents WHERE session_id=? AND call_id_hash=? LIMIT 1').get(sessionId,input.callIdHash);
        const sameCall=db.prepare('SELECT * FROM intents WHERE session_id=? AND call_id_hash=? AND lane=\'normal\'').get(sessionId,input.callIdHash);
        if(parentId!==null){
          if(!sameCall||sameCall.id!==parentId||sameCall.target_id!==targetId||sameCall.tool_name!==input.toolName||sameCall.turn!==input.turn||sameCall.step!==input.step||!['prepared-render','render','moss-pe-start','qwen-pe-start'].includes(sameCall.operation))throw Error('Internal cancellation parent or owned target differs');
        }else if(anyCall)throw Error('UNIQUE constraint: DSH call already used; same-call cancellation requires its owned parent');
        const id=randomUUID(),now=new Date().toISOString();
        db.prepare('INSERT INTO intents (id,session_id,lane,operation,request_id,input_hash,correlation_hash,target_id,call_id_hash,tool_name,turn,step,parent_intent_id,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,sessionId,lane,input.operation,requestId,input.inputHash,correlationHash,targetId,input.callIdHash,input.toolName,input.turn,input.step,parentId,'intent',now,now);
        return get(sessionId,id);
      });
    },
    pending(sessionId){validSession(sessionId);return readSnapshot(()=>db.prepare("SELECT * FROM intents WHERE session_id=? AND state!='acknowledged' ORDER BY rowid").all(sessionId).map(rowValue));},
    get(sessionId,id){return readSnapshot(()=>get(validSession(sessionId),validId(id)));},
    recordReceipt(input){
      exactKeys(input,['sessionId','id','receiptHash','source','outcome']);
      const sessionId=validSession(input.sessionId),id=validId(input.id),hash=validHash(input.receiptHash);
      if(!sourceKinds.has(input.source)||!outcomes.has(input.outcome))throw Error('Invalid receipt proof');
      return transact(()=>{
        const old=get(sessionId,id);if(!old)throw Error('Journal operation is not owned by this session');
        if(!old.callIdHash||!old.toolName||!Number.isSafeInteger(old.turn)||!Number.isSafeInteger(old.step))throw Error('Legacy intent has no durable DSH call identity');
        if(old.state==='acknowledged')throw Error('Journal receipt is already acknowledged');
        if(old.state==='receipt'&&(old.receiptHash!==hash||old.outcome!==input.outcome||input.source!=='verified-controller-read'))throw Error('Receipt reissue requires the same proof from a fresh verified Controller read');
        const ackNonce=randomBytes(32).toString('base64url');
        const ackNonceHash=createHash('sha256').update(ackNonce).digest('hex');
        db.prepare("UPDATE intents SET state='receipt',receipt_hash=?,receipt_source=?,outcome=?,ack_nonce_hash=?,updated_at=? WHERE id=? AND session_id=? AND state IN ('intent','receipt')").run(hash,input.source,input.outcome,ackNonceHash,new Date().toISOString(),id,sessionId);
        // The nonce is returned once to the caller, not persisted as plaintext.
        // A new nonce requires the same verified Controller read to be repeated.
        return {receipt:get(sessionId,id),ackNonce};
      });
    },
    bindReconciledReceipt(input){
      exactKeys(input,['sessionId','id','requestId','inputHash','operation','targetId','receiptHash','previousReceiptHash','previousDeliveryCallIdHash','source','outcome','callIdHash','toolName','turn','step']);
      const sessionId=validSession(input.sessionId),id=validId(input.id),requestId=validId(input.requestId),inputHash=validHash(input.inputHash),receiptHash=validHash(input.receiptHash),callIdHash=validHash(input.callIdHash),targetId=input.targetId??null;
      if(targetId!==null)validId(targetId);
      if(input.previousReceiptHash!=null)validHash(input.previousReceiptHash);
      if(input.previousDeliveryCallIdHash!=null)validHash(input.previousDeliveryCallIdHash);
      const allowed={create:'local_production_reconcile_create','asset-import':'local_asset_reconcile','workflow-draft':'local_workflow_reconcile','prepared-render':'local_render_reconcile',render:'local_render_reconcile',evaluate:'local_production_action_reconcile',iteration:'local_production_action_reconcile',feedback:'local_production_action_reconcile','search-proposal':'local_search_reconcile','moss-pe-start':'local_pe_receipt_reconcile','moss-pe-decision':'local_pe_receipt_reconcile','moss-pe-reconcile':'local_pe_receipt_reconcile','qwen-pe-start':'local_pe_receipt_reconcile','qwen-pe-decision':'local_pe_receipt_reconcile','qwen-pe-reconcile':'local_pe_receipt_reconcile',cancel:'local_cancel_reconcile'};
      if(input.source!=='verified-controller-read'||!outcomes.has(input.outcome)||allowed[input.operation]!==input.toolName||!Number.isSafeInteger(input.turn)||input.turn<1||!Number.isSafeInteger(input.step)||input.step<1)throw Error('Invalid reconciliation proof or delivery identity');
      return transact(()=>{
        const old=get(sessionId,id);
        if(!old||!['intent','receipt'].includes(old.state)||old.deliveryCallIdHash!==(input.previousDeliveryCallIdHash??null)||!old.callIdHash||old.callIdHash===callIdHash||old.operation!==input.operation||old.requestId!==requestId||old.inputHash!==inputHash||old.targetId!==targetId||(old.state==='intent'&&(input.previousReceiptHash!=null||old.deliveryCallIdHash!==null))||(old.state==='receipt'&&(old.receiptHash!==input.previousReceiptHash||old.outcome!==input.outcome)))throw Error('Original pending operation does not match the verified receipt');
        if(input.operation==='cancel'&&old.lane!=='cancel')throw Error('Cancellation recovery lane differs');
        if(input.operation!=='cancel'&&old.lane!=='normal')throw Error('Reconciliation lane differs');
        if(db.prepare('SELECT id FROM intents WHERE session_id=? AND call_id_hash=? LIMIT 1').get(sessionId,callIdHash)||db.prepare('SELECT intent_id FROM delivery_claims WHERE session_id=? AND call_id_hash=? LIMIT 1').get(sessionId,callIdHash))throw Error('Delivery call is already bound');
        const ackNonce=randomBytes(32).toString('base64url'),nonceHash=createHash('sha256').update(ackNonce).digest('hex');
        db.prepare('INSERT INTO delivery_claims(session_id,call_id_hash,intent_id) VALUES(?,?,?)').run(sessionId,callIdHash,id);
        const changed=db.prepare("UPDATE intents SET state='receipt',receipt_hash=?,receipt_source=?,outcome=?,ack_nonce_hash=?,delivery_call_id_hash=?,delivery_tool_name=?,delivery_turn=?,delivery_step=?,updated_at=? WHERE id=? AND session_id=? AND state IN ('intent','receipt') AND delivery_call_id_hash IS ?").run(receiptHash,input.source,input.outcome,nonceHash,callIdHash,input.toolName,input.turn,input.step,new Date().toISOString(),id,sessionId,input.previousDeliveryCallIdHash??null);
        if(changed.changes!==1)throw Error('Original operation changed while binding delivery');
        return {receipt:get(sessionId,id),ackNonce};
      });
    },
    acknowledge(input){
      exactKeys(input,['sessionId','id','receiptHash','ackNonce']);
      const sessionId=validSession(input.sessionId),id=validId(input.id),hash=validHash(input.receiptHash);
      if(typeof input.ackNonce!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(input.ackNonce))throw Error('A valid delivery nonce is required');
      const nonceHash=createHash('sha256').update(input.ackNonce).digest('hex');
      return transact(()=>{
        const old=db.prepare('SELECT * FROM intents WHERE session_id=? AND id=?').get(sessionId,id);
        if(!old||!old.call_id_hash||!old.tool_name||!Number.isSafeInteger(old.turn)||!Number.isSafeInteger(old.step)||old.receipt_hash!==hash||old.ack_nonce_hash!==nonceHash||old.state!=='receipt')throw Error('A matching unacknowledged receipt and delivery nonce are required');
        db.prepare("UPDATE intents SET state='acknowledged',ack_nonce_hash=NULL,updated_at=? WHERE id=? AND session_id=? AND state='receipt'").run(new Date().toISOString(),id,sessionId);
        return get(sessionId,id);
      });
    },
    close(){if(!closed){db.close();closed=true;}},
  });
}
