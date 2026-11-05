import {mkdirSync,readFileSync,readdirSync,writeFileSync,renameSync,lstatSync,existsSync,realpathSync} from 'node:fs';
import {resolve,join,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {isIP} from 'node:net';
import {readPublicPage,pageUrl} from './page.mjs';
import {withObservedOwnerTransaction} from './owner-observation.mjs';
import {initializeSearchLedger,updateSearchLedgerManifest,validateSearchSessionTurns} from './ledger-schema.mjs';
import {initializeOwnerManifest,assertOwnerManifest,updateOwnerManifest} from './owner-manifest.mjs';
import {initializeCutoverLedger,cutoverForSession,currentCutoverTurn,writeCutoverTurn,requireCutoverTurn,bindCutoverProposal,requireCutoverProposal} from './cutover-ledger.mjs';
import {hasBinaryPrimaryKey} from '../schema-integrity.mjs';
import {win32} from 'node:path';

export class SearchError extends Error {
  constructor(code,message,status=400){super(message);this.name='SearchError';this.code=code;this.status=status;}
}
const fail=(code,message,status)=>{throw new SearchError(code,message,status);};
const clone=v=>structuredClone(v);
const now=()=>new Date().toISOString();
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const proposalTurnHash=r=>hash({proposalId:r.id,sessionId:r.sessionId,proposalHash:r.proposalHash,turn:r.turn});
const terminal=new Set(['completed','cancelled','needs_attention']);
const idPattern=/^[a-f0-9-]{36}$/;
function assertProposalIntegrity(record){
  if(!record||!['queries','pages'].includes(record.kind)||!Array.isArray(record.items))fail('LEDGER_CORRUPT','Search proposal or items are invalid',503);
  const values=record.kind==='pages'?record.urls:record.queries,key=record.kind==='pages'?'url':'query';
  if(!Array.isArray(values)||values.length<1||values.length>(record.kind==='pages'?3:5)||new Set(values).size!==values.length||record.items.length!==values.length||values.some((value,i)=>typeof value!=='string'||record.items[i]?.[key]!==value))fail('LEDGER_CORRUPT','Search items differ from the exact proposed targets',503);
  const proposal=record.kind==='pages'?{kind:'pages',productionId:record.productionId,sessionId:record.sessionId,sourceProposalId:record.sourceProposalId,urls:record.urls,engine:record.engine,purpose:record.purpose}:{kind:'queries',productionId:record.productionId,sessionId:record.sessionId,queries:record.queries,engine:record.engine,purpose:record.purpose};
  if(record.proposalHash!==hash(proposal))fail('LEDGER_CORRUPT','Search proposal hash differs',503);
  if(record.turnHash!==undefined&&(!Number.isSafeInteger(record.turn)||record.turn<1||record.turnHash!==proposalTurnHash(record)))fail('LEDGER_CORRUPT','Search proposal turn hash differs',503);
  if(['approved','running'].includes(record.phase)&&!record.approval)fail('LEDGER_CORRUPT','Search approval evidence is missing',503);
  if(record.approval){const a=record.approval,approved=record.kind==='pages'?a.urls:a.queries;
    if(a.actor!=='user'||a.proposalHash!==record.proposalHash||a.engine!==record.engine||JSON.stringify(approved)!==JSON.stringify(values)||(record.kind==='pages'&&a.pageReadsAllowed!==true))fail('LEDGER_CORRUPT','Search approval differs from the proposed targets',503);
  }
}
function text(value,name,max){if(typeof value!=='string'||!value.trim()||value!==value.trim()||value.length>max||/[\u0000-\u001f\u007f]/.test(value))fail('INVALID_INPUT',`Invalid ${name}`);return value;}
function queryList(queries){
  if(!Array.isArray(queries)||queries.length<1||queries.length>5)fail('INVALID_QUERIES','Provide one to five explicit search queries');
  const result=queries.map(q=>text(q,'query',240));
  if(new Set(result).size!==result.length)fail('DUPLICATE_QUERY','Each approved query is sent once');
  // RustXNG's query parser can select engines, languages, external redirects and timeouts.
  // These controls must never bypass the engine/word set displayed for approval.
  if(result.some(q=>/(?:^|\s)[!:<]/u.test(q)))fail('QUERY_CONTROL_FORBIDDEN','RustXNG bang, language and timeout operators are not accepted');
  return result;
}
function publicResultUrl(value){
  try{const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.port)return null;
    const host=url.hostname.toLowerCase();if(!host.includes('.')||host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal')||isIP(host.replace(/^\[|\]$/g,'')))return null;
    return url.href;
  }catch{return null;}
}
async function boundedJson(response,maxBytes=1024*1024){
  if(!response.ok)throw new SearchError('UPSTREAM_HTTP',`RustXNG returned HTTP ${response.status}`,502);
  if(!response.body)throw new SearchError('UPSTREAM_EMPTY','RustXNG response has no body',502);
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes){await reader.cancel();throw new SearchError('UPSTREAM_TOO_LARGE','RustXNG response exceeds the response budget',502);}chunks.push(value);}}finally{reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new SearchError('UPSTREAM_JSON','RustXNG response is not valid JSON',502);}
}

/** Local approval ledger. Approval methods must be exposed only by the controller's user/admin route. */
export class SearchService {
  constructor({root,store=null,baseUrl='http://127.0.0.1:29483',enabled=true,fetchImpl=fetch,pageReader=readPublicPage,timeoutMs=20000,maxResults=5,requireTurnOwner=false,verifyHostIdentity=null,verifyLegacyQuiescence=null,ownerProbe=null,requireGatewayOpen=false,openHandshake=null}={}){
    if(!root)fail('ROOT_REQUIRED','A workspace root is required');
    if(typeof enabled!=='boolean')fail('INVALID_SEARCH_CONFIGURATION','Search enabled must be boolean');
    this.enabled=enabled;
    if(typeof requireTurnOwner!=='boolean'||(requireTurnOwner&&!store))fail('INVALID_SEARCH_CONFIGURATION','Durable turn ownership requires a receipt store');
    this.requireTurnOwner=requireTurnOwner;
    if(typeof requireGatewayOpen!=='boolean'||(requireGatewayOpen&&!requireTurnOwner))fail('INVALID_SEARCH_CONFIGURATION','Gateway confirmation requires turn ownership');this.requireGatewayOpen=requireGatewayOpen;this.openHandshake=openHandshake;
    if(verifyHostIdentity!==null&&typeof verifyHostIdentity!=='function')fail('INVALID_SEARCH_CONFIGURATION','Host identity verifier is invalid');
    this.verifyHostIdentity=verifyHostIdentity;
    this.ownerProbe=ownerProbe;this.ownerObservation=null;
    if(verifyLegacyQuiescence!==null&&typeof verifyLegacyQuiescence!=='function')fail('INVALID_SEARCH_CONFIGURATION','Legacy quiescence verifier is invalid');
    this.verifyLegacyQuiescence=verifyLegacyQuiescence;
    this.controllerInstanceId=randomUUID();
    const url=new URL(baseUrl);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)fail('INVALID_UPSTREAM','RustXNG must use an explicit loopback HTTP endpoint');
    if(store!==null&&(!store?.db||typeof store.transaction!=='function'))fail('INVALID_RECEIPT_STORE','Search receipt store is invalid');
    this.root=resolve(root);this.directory=join(this.root,'data','search');this.baseUrl=url.origin;this.fetchImpl=fetchImpl;this.pageReader=pageReader;this.store=store;
    this.timeoutMs=Math.max(100,Math.min(Number(timeoutMs)||20000,60000));this.maxResults=Math.max(1,Math.min(Number(maxResults)||5,5));this.records=new Map();this.active=new Map();
    for(const p of [this.root,join(this.root,'data'),this.directory])if(existsSync(p)&&lstatSync(p).isSymbolicLink())fail('UNSAFE_STORAGE','Search ledger must not use links');
    mkdirSync(this.directory,{recursive:true});
    this.assertLedgerDirectory();
    const priorTurnMarker=store?.db.prepare("SELECT value FROM meta WHERE key='searchSessionTurns:v1'").get(),priorTurnTable=store?.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='search_session_turns'").get();
    if(priorTurnMarker&&(priorTurnMarker.value!=='done'||!priorTurnTable))fail('LEDGER_CORRUPT','Durable search turn identity is invalid',503);
    if(store){initializeSearchLedger(store);store.db.exec('CREATE TABLE IF NOT EXISTS search_session_turns(session_id TEXT PRIMARY KEY,latest INTEGER NOT NULL,stopped_at INTEGER)');validateSearchSessionTurns(store.db);}
    if(store){this.initializeTurnOwners();store.transaction(()=>initializeCutoverLedger(store.db));}
    this.sessionStopsPath=join(this.directory,'session-stops.json');this.turns=new Map();this.persistenceFault=false;
    if(!priorTurnMarker&&existsSync(this.sessionStopsPath)){
      const state=lstatSync(this.sessionStopsPath);
      if(!state.isFile()||state.isSymbolicLink()||state.nlink!==1||state.size>2*1024*1024)fail('UNSAFE_STORAGE','Search session stop ledger must be a bounded regular file without links');
      let stops;try{stops=JSON.parse(readFileSync(this.sessionStopsPath,'utf8'));}catch{fail('LEDGER_CORRUPT','Search session stop ledger requires inspection',503);}
      if(![1,2].includes(stops.schema)||!Array.isArray(stops.sessions)||stops.sessions.length>10000)fail('LEDGER_CORRUPT','Search session stop ledger is invalid',503);
      for(const row of stops.sessions){
        // A legacy stopped session has no trustworthy turn. Keep it closed
        // rather than guessing that an incoming delayed turn is new.
        if(stops.schema===1){text(row,'sessionId',150);this.turns.set(row,{latest:0,stoppedAt:Number.MAX_SAFE_INTEGER});continue;}
        if(!row||typeof row!=='object')fail('LEDGER_CORRUPT','Invalid search turn record',503);
        text(row.sessionId,'sessionId',150);
        if(!Number.isSafeInteger(row.latest)||row.latest<0||!(row.stoppedAt===null||Number.isSafeInteger(row.stoppedAt)&&row.stoppedAt>=0)||this.turns.has(row.sessionId))fail('LEDGER_CORRUPT','Invalid search turn generation',503);
        this.turns.set(row.sessionId,{latest:row.latest,stoppedAt:row.stoppedAt});
      }
    }
    if(store)this.initializeDurableTurns();
    for(const name of readdirSync(this.directory)){
      if(!/^[a-f0-9-]{36}\.json$/.test(name))continue;
      const file=this.ledgerFile(name.slice(0,-5));
      let record;try{record=JSON.parse(readFileSync(file,'utf8'));}catch{fail('LEDGER_CORRUPT','Search ledger requires inspection',503);}
      if(record.schema!==1||record.id+'.json'!==name||!Array.isArray(record.items)||!['awaiting_approval','approved','running',...terminal].includes(record.phase))fail('LEDGER_CORRUPT','Search ledger has an unknown record',503);
      const proposal=record.kind==='pages'?{kind:'pages',productionId:record.productionId,sessionId:record.sessionId,sourceProposalId:record.sourceProposalId,urls:record.urls,engine:record.engine,purpose:record.purpose}:{kind:'queries',productionId:record.productionId,sessionId:record.sessionId,queries:record.queries,engine:record.engine,purpose:record.purpose};
      if(record.proposalHash!==hash(proposal))fail('LEDGER_CORRUPT','Search proposal hash differs',503);
      assertProposalIntegrity(record);
      // Treat a running ledger as uncertain in this instance without rewriting
      // it: another live Controller may still own and update that exact file.
      if(record.phase==='running'){record.phase='needs_attention';record.error={code:'RESTART_AFTER_SEND',message:'An interrupted search may have been sent. It will not be retried automatically.'};for(const item of record.items)if(item.state==='sent')item.state='uncertain';}
      this.records.set(record.id,record);
    }
  }
  assertLedgerDirectory(){
    for(const path of [this.root,join(this.root,'data'),this.directory]){let s;try{s=lstatSync(path);}catch{fail('UNSAFE_STORAGE','Search ledger directory is unavailable',503);}if(!s.isDirectory()||s.isSymbolicLink())fail('UNSAFE_STORAGE','Search ledger directory must not use links',503);}
    const actual=resolve(realpathSync(this.directory)),expected=resolve(this.directory),same=process.platform==='win32'?actual.toLowerCase()===expected.toLowerCase():actual===expected;
    if(!same)fail('UNSAFE_STORAGE','Search ledger directory resolves through a link',503);
  }
  ledgerFile(id,{missing=false}={}){
    if(!idPattern.test(String(id)))fail('INVALID_ID','Invalid search grant id');this.assertLedgerDirectory();const file=join(this.directory,id+'.json');
    let s;try{s=lstatSync(file);}catch(error){if(error.code==='ENOENT'&&missing)return file;fail('UNSAFE_STORAGE','Search record is unavailable',503);}
    if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>2*1024*1024)fail('UNSAFE_STORAGE','Search record must be a bounded regular file without links',503);
    return file;
  }
  checkLedgerFile(record){
    const file=this.ledgerFile(record.id);let saved;try{saved=JSON.parse(readFileSync(file,'utf8'));}catch{fail('LEDGER_CORRUPT','Search record cannot be read',503);}
    assertProposalIntegrity(saved);
    if(saved.id!==record.id||saved.sessionId!==record.sessionId||saved.productionId!==record.productionId||saved.proposalHash!==record.proposalHash||saved.turn!==record.turn||saved.turnHash!==record.turnHash||saved.requestId!==record.requestId||saved.requestPayloadHash!==record.requestPayloadHash)fail('LEDGER_CORRUPT','Search record identity changed',503);
  }
  save(record){
    assertProposalIntegrity(record);
    const write=()=>{
      if(this.store&&record.phase!=='cancelled'){
        if(record.turn===undefined&&record.phase==='awaiting_approval')this.ensureSessionOpen(record.sessionId);
        else this.ensureProposalTurn(record);
        if(this.store.db.prepare('SELECT proposal_id FROM search_proposal_cancels WHERE proposal_id=?').get(record.id))fail('SEARCH_CANCELLED','This proposal was stopped; stale writes are forbidden',409);
      }
      record.updatedAt=now();const target=this.ledgerFile(record.id,{missing:true});
      if(!idPattern.test(record.id)||!target.startsWith(this.directory+sep))fail('INVALID_ID','Invalid search grant id');
      const temporary=target+'.'+randomUUID()+'.partial';writeFileSync(temporary,JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});renameSync(temporary,target);this.records.set(record.id,record);
    };
    // Hold the same SQLite writer lock through the atomic rename so that a
    // concurrent durable stop/cancel cannot be overwritten by stale state.
    if(this.requireTurnOwner&&record.phase!=='cancelled')return this.observedOwnerTransaction(record.sessionId,record.turn,write);
    if(this.store&&record.phase!=='cancelled')return this.store.transaction(write);
    return write();
  }
  visible(record){
    if(record?.requestId===undefined)return true;
    if(!this.store)return false;
    const row=this.store.db.prepare('SELECT session_id,proposal_id,proposal_hash,payload_hash,state FROM search_proposal_receipts WHERE session_id=? AND request_id=?').get(record.sessionId,record.requestId);
    return Boolean(row&&row.state==='committed'&&row.session_id===record.sessionId&&row.proposal_id===record.id&&row.proposal_hash===record.proposalHash&&row.payload_hash===record.requestPayloadHash);
  }
  get(id){if(!idPattern.test(String(id)))fail('INVALID_ID','Invalid search grant id');const record=this.records.get(id);if(!record)fail('NOT_FOUND','Search grant not found',404);if(!this.visible(record))fail('REQUEST_UNKNOWN','Search proposal is not committed; no external action is permitted',409);assertProposalIntegrity(record);this.checkLedgerFile(record);return record;}
  owned(id,sessionId){const record=this.get(id);if(typeof sessionId!=='string'||record.sessionId!==sessionId)fail('SESSION_MISMATCH','Search grant belongs to another session',403);return record;}
  saveSessionStops(){
    this.assertLedgerDirectory();
    if(existsSync(this.sessionStopsPath)){const s=lstatSync(this.sessionStopsPath);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)fail('UNSAFE_STORAGE','Search session stop ledger must not use links');}
    const temporary=this.sessionStopsPath+'.'+randomUUID()+'.partial';
    writeFileSync(temporary,JSON.stringify({schema:2,sessions:[...this.turns].map(([sessionId,state])=>({sessionId,...state}))},null,2)+'\n',{flag:'wx',mode:0o600});renameSync(temporary,this.sessionStopsPath);
  }
  initializeDurableTurns(){
    const marker='searchSessionTurns:v1';
    this.store.transaction(()=>{
      const existing=this.store.db.prepare('SELECT value FROM meta WHERE key=?').get(marker);
      if(existing){if(existing.value!=='done')fail('LEDGER_CORRUPT','Search turn migration marker is invalid',503);return;}
      if(this.store.db.prepare('SELECT count(*) AS n FROM search_session_turns').get().n!==0)fail('LEDGER_CORRUPT','Unmarked durable search turns already exist',503);
      for(const [sessionId,state] of this.turns)this.store.db.prepare('INSERT INTO search_session_turns VALUES(?,?,?)').run(sessionId,state.latest,state.stoppedAt);
      this.store.db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(marker,'done');
    });
    this.turns.clear();
    for(const row of this.store.db.prepare('SELECT * FROM search_session_turns').all())this.acceptDurableTurn(row);
  }
  initializeTurnOwners(){
    this.store.transaction(()=>{
      const marker=this.store.db.prepare("SELECT value FROM meta WHERE key='searchTurnOwners:v1'").get();
      const existing=this.store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('search_turn_owners','search_turn_owner_run_states','search_turn_owner_recoveries')").all();
      if(marker&&(marker.value!=='done'||existing.length!==3))fail('LEDGER_CORRUPT','Search turn owner migration is incomplete',503);
      if(!marker&&existing.length)fail('LEDGER_CORRUPT','Unmarked search turn owner ledger exists',503);
      if(!marker){
        this.store.db.exec("CREATE TABLE search_turn_owners(session_id TEXT NOT NULL,turn INTEGER NOT NULL,host_id TEXT NOT NULL,state TEXT NOT NULL,start_seq INTEGER NOT NULL,end_seq INTEGER,end_event_hash TEXT,PRIMARY KEY(session_id,turn)); CREATE TABLE search_turn_owner_run_states(proposal_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,turn INTEGER NOT NULL,host_id TEXT NOT NULL,run_id TEXT NOT NULL,state TEXT NOT NULL); CREATE TABLE search_turn_owner_recoveries(session_id TEXT NOT NULL,turn INTEGER NOT NULL,host_id TEXT NOT NULL,start_seq INTEGER NOT NULL,observed_latest INTEGER,observed_stopped_at INTEGER,claims_hash TEXT NOT NULL,recorded_at TEXT NOT NULL,PRIMARY KEY(session_id,turn));");
        this.store.db.prepare("INSERT INTO meta(key,value) VALUES('searchTurnOwners:v1','done')").run();
      }
      const schemas=[['search_turn_owners','session_id,turn,host_id,state,start_seq,end_seq,end_event_hash',[1,2]],['search_turn_owner_run_states','proposal_id,session_id,turn,host_id,run_id,state',[1]],['search_turn_owner_recoveries','session_id,turn,host_id,start_seq,observed_latest,observed_stopped_at,claims_hash,recorded_at',[1,2]]];
      for(const [name,names,keys] of schemas){const columns=this.store.db.prepare(`PRAGMA table_info(${name})`).all();if(columns.map(c=>c.name).join(',')!==names||columns.filter(c=>c.pk).map(c=>c.pk).join(',')!==keys.join(',')||!hasBinaryPrimaryKey(this.store.db,name,keys.map(k=>columns.find(c=>c.pk===k)?.name))||this.store.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='trigger' AND tbl_name=?").get(name).n!==0||this.store.db.prepare(`PRAGMA foreign_key_list(${name})`).all().length!==0)fail('LEDGER_CORRUPT','Search turn owner schema differs',503);}
      const processMarker=this.store.db.prepare("SELECT value FROM meta WHERE key='searchTurnRunProcesses:v1'").get(),processTables=this.store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('search_turn_owner_run_processes','search_turn_owner_uncertain_claims')").all();
      if(processMarker&&(processMarker.value!=='done'||processTables.length!==2)||!processMarker&&processTables.length)fail('LEDGER_CORRUPT','Search run process migration differs',503);
      if(!processMarker){this.store.db.exec('CREATE TABLE search_turn_owner_run_processes(proposal_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,controller_instance TEXT NOT NULL,pid INTEGER NOT NULL); CREATE TABLE search_turn_owner_uncertain_claims(proposal_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,turn INTEGER NOT NULL,host_id TEXT NOT NULL,run_id TEXT NOT NULL,controller_instance TEXT NOT NULL,pid INTEGER NOT NULL,recorded_at TEXT NOT NULL)');this.store.db.prepare("INSERT INTO meta(key,value) VALUES('searchTurnRunProcesses:v1','done')").run();}
      for(const [name,names] of [['search_turn_owner_run_processes','proposal_id,run_id,controller_instance,pid'],['search_turn_owner_uncertain_claims','proposal_id,session_id,turn,host_id,run_id,controller_instance,pid,recorded_at']]){const columns=this.store.db.prepare(`PRAGMA table_info(${name})`).all();if(columns.map(c=>c.name).join(',')!==names||columns.filter(c=>c.pk).map(c=>c.pk).join(',')!=='1'||!hasBinaryPrimaryKey(this.store.db,name,['proposal_id'])||this.store.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='trigger' AND tbl_name=?").get(name).n!==0||this.store.db.prepare(`PRAGMA foreign_key_list(${name})`).all().length!==0)fail('LEDGER_CORRUPT','Search run process schema differs',503);}
      const legacyMarker=this.store.db.prepare("SELECT value FROM meta WHERE key='searchTurnLegacy:v1'").get(),legacyTables=this.store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('search_turn_owner_legacy_attestations','search_turn_owner_legacy_migrations')").all();
      if(legacyMarker&&(legacyMarker.value!=='done'||legacyTables.length!==2)||!legacyMarker&&legacyTables.length)fail('LEDGER_CORRUPT','Search legacy migration differs',503);
      if(!legacyMarker){this.store.db.exec('CREATE TABLE search_turn_owner_legacy_attestations(session_id TEXT NOT NULL,turn INTEGER NOT NULL,host_id TEXT NOT NULL,start_seq INTEGER NOT NULL,end_seq INTEGER NOT NULL,event_count INTEGER NOT NULL,events_hash TEXT NOT NULL,end_event_hash TEXT NOT NULL,PRIMARY KEY(session_id,turn)); CREATE TABLE search_turn_owner_legacy_migrations(session_id TEXT NOT NULL,turn INTEGER NOT NULL,host_id TEXT NOT NULL,attestation_hash TEXT NOT NULL,observed_latest INTEGER,observed_stopped_at INTEGER,history_hash TEXT NOT NULL,recorded_at TEXT NOT NULL,PRIMARY KEY(session_id,turn));');this.store.db.prepare("INSERT INTO meta(key,value) VALUES('searchTurnLegacy:v1','done')").run();}
      for(const [name,names] of [['search_turn_owner_legacy_attestations','session_id,turn,host_id,start_seq,end_seq,event_count,events_hash,end_event_hash'],['search_turn_owner_legacy_migrations','session_id,turn,host_id,attestation_hash,observed_latest,observed_stopped_at,history_hash,recorded_at']]){const columns=this.store.db.prepare(`PRAGMA table_info(${name})`).all();if(columns.map(c=>c.name).join(',')!==names||columns.filter(c=>c.pk).map(c=>c.pk).join(',')!=='1,2'||!hasBinaryPrimaryKey(this.store.db,name,['session_id','turn'])||this.store.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='trigger' AND tbl_name=?").get(name).n!==0||this.store.db.prepare(`PRAGMA foreign_key_list(${name})`).all().length!==0)fail('LEDGER_CORRUPT','Search legacy evidence schema differs',503);}
      const hostMarker=this.store.db.prepare("SELECT value FROM meta WHERE key='searchSessionHosts:v1'").get(),hostTable=this.store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='search_session_host_generations'").get();
      if(hostMarker&&(hostMarker.value!=='done'||!hostTable)||!hostMarker&&hostTable)fail('LEDGER_CORRUPT','Search Host generation migration differs',503);
      if(!hostMarker){this.store.db.exec("CREATE TABLE search_session_host_generations(session_id TEXT NOT NULL,host_id TEXT NOT NULL,pid INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('active','superseded')),PRIMARY KEY(session_id,host_id)); CREATE UNIQUE INDEX search_session_active_host ON search_session_host_generations(session_id) WHERE state='active';");this.store.db.prepare("INSERT INTO meta(key,value) VALUES('searchSessionHosts:v1','done')").run();}
      const birthMarker=this.store.db.prepare("SELECT value FROM meta WHERE key='searchSessionHostBirth:v1'").get(),beforeBirth=this.store.db.prepare('PRAGMA table_xinfo(search_session_host_generations)').all();
      if(birthMarker?.value!=='done'&&birthMarker)fail('LEDGER_CORRUPT','Search Host birth migration marker differs',503);
      if(!birthMarker){if(beforeBirth.map(c=>c.name).join(',')!=='session_id,host_id,pid,state')fail('LEDGER_CORRUPT','Unmarked Host birth schema differs',503);this.store.db.exec("ALTER TABLE search_session_host_generations ADD COLUMN start_time_utc_ticks TEXT NOT NULL DEFAULT ''; ALTER TABLE search_session_host_generations ADD COLUMN executable TEXT NOT NULL DEFAULT ''");this.store.db.prepare("INSERT INTO meta(key,value) VALUES('searchSessionHostBirth:v1','done')").run();}
      const hostColumns=this.store.db.prepare('PRAGMA table_xinfo(search_session_host_generations)').all(),hostIndex=this.store.db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name='search_session_active_host'").get(),indexInfo=this.store.db.prepare('PRAGMA index_list(search_session_host_generations)').all().find(x=>x.name==='search_session_active_host'),indexKeys=this.store.db.prepare('PRAGMA index_xinfo(search_session_active_host)').all().filter(x=>x.key===1);
      if(hostColumns.map(c=>c.name).join(',')!=='session_id,host_id,pid,state,start_time_utc_ticks,executable'||hostColumns.some((c,i)=>String(c.type).toUpperCase()!==(i===2?'INTEGER':'TEXT')||c.notnull!==1||c.hidden!==0||c.pk!==(i===0?1:i===1?2:0)||(i>=4&&c.dflt_value!=="''"))||!hasBinaryPrimaryKey(this.store.db,'search_session_host_generations',['session_id','host_id'])||!hostIndex?.sql||!/^CREATE UNIQUE INDEX search_session_active_host ON search_session_host_generations\(session_id\) WHERE state='active'$/i.test(hostIndex.sql)||!indexInfo||indexInfo.unique!==1||indexInfo.partial!==1||indexKeys.length!==1||indexKeys[0].name!=='session_id'||indexKeys[0].coll!=='BINARY'||indexKeys[0].desc!==0||this.store.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='trigger' AND tbl_name='search_session_host_generations'").get().n!==0||this.store.db.prepare('PRAGMA foreign_key_list(search_session_host_generations)').all().length!==0)fail('LEDGER_CORRUPT','Search Host generation schema differs',503);
      // Explicit type/nullability checks complement the owner PK and names.
      const typed={search_turn_owners:['TEXT,INTEGER,TEXT,TEXT,INTEGER,INTEGER,TEXT',[5,6]]};
      typed.search_turn_owner_run_states=['TEXT,TEXT,INTEGER,TEXT,TEXT,TEXT',[0]];
      typed.search_turn_owner_recoveries=['TEXT,INTEGER,TEXT,INTEGER,INTEGER,INTEGER,TEXT,TEXT',[4,5]];
      typed.search_turn_owner_run_processes=['TEXT,TEXT,TEXT,INTEGER',[0]];
      typed.search_turn_owner_uncertain_claims=['TEXT,TEXT,INTEGER,TEXT,TEXT,TEXT,INTEGER,TEXT',[0]];
      typed.search_turn_owner_legacy_attestations=['TEXT,INTEGER,TEXT,INTEGER,INTEGER,INTEGER,TEXT,TEXT',[]];
      typed.search_turn_owner_legacy_migrations=['TEXT,INTEGER,TEXT,TEXT,INTEGER,INTEGER,TEXT,TEXT',[4,5]];
      for(const [name,[types,nullable]] of Object.entries(typed)){const expected=types.split(','),columns=this.store.db.prepare(`PRAGMA table_xinfo(${name})`).all();if(columns.length!==expected.length||columns.some((c,i)=>String(c.type).toUpperCase()!==expected[i]||c.hidden!==0||c.notnull!==(nullable.includes(i)?0:1)))fail('LEDGER_CORRUPT','Search owner column type or nullability differs',503);}
      initializeOwnerManifest(this.store.db);
    });
  }
  ensureOwner(sessionId,turn,hostId){
    if(!this.requireTurnOwner)return;
    try{assertOwnerManifest(this.store.db);}catch{fail('TURN_OWNER_UNKNOWN','Search turn ownership manifest is unavailable or differs',503);}
    let cutover;try{cutover=cutoverForSession(this.store.db,sessionId);}catch{fail('TURN_OWNER_UNKNOWN','Search cutover evidence is unavailable',503);}
    const active=this.store.db.prepare("SELECT * FROM search_turn_owners WHERE session_id=? AND state='active' AND turn>?").all(sessionId,cutover?.boundary_turn??0);
    const r=this.store.db.prepare('SELECT * FROM search_turn_owners WHERE session_id=? AND turn=?').get(sessionId,turn);
    if(cutover)try{requireCutoverTurn(this.store.db,sessionId,turn,r?.start_seq);}catch{fail('TURN_OWNER_UNKNOWN','Search turn is before the cutover boundary',503);}
    const validActive=r?.state==='active'&&active.length===1&&active[0].turn===turn&&r.end_seq===null&&r.end_event_hash===null;
    const validCompleted=r?.state==='completed'&&active.length===0&&Number.isSafeInteger(r.end_seq)&&r.end_seq>r.start_seq&&/^[a-f0-9]{64}$/.test(r.end_event_hash??'');
    if((!validActive&&!validCompleted)||typeof r.host_id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(r.host_id)||!Number.isSafeInteger(r.start_seq)||r.start_seq<1||(hostId!==undefined&&(r.host_id!==hostId||!validActive)))fail('TURN_OWNER_UNKNOWN','Search turn ownership is unresolved; maintenance must inspect it',503);
    const hostRows=this.store.db.prepare("SELECT * FROM search_session_host_generations WHERE session_id=? AND state='active'").all(sessionId),host=hostRows[0];
    if(hostRows.length!==1||host.host_id!==r.host_id||!Number.isSafeInteger(host.pid)||host.pid<1||typeof host.start_time_utc_ticks!=='string'||!/^[1-9]\d{0,23}$/.test(host.start_time_utc_ticks)||typeof host.executable!=='string'||!win32.isAbsolute(host.executable)||/[\u0000-\u001f]/.test(host.executable))fail('TURN_OWNER_UNKNOWN','The current Host generation birth identity is not verified',503);
    // PID existence alone cannot establish process identity after PID reuse.
    // Until a birth-identity verifier is explicitly wired, strict operation is closed.
    let verified=false;try{verified=this.ownerObservation!==null&&JSON.stringify(this.ownerObservation)===JSON.stringify(host);}catch{}
    if(!verified)fail('TURN_OWNER_UNKNOWN','The current Host birth identity is unavailable or cannot be verified',503);
    return r;
  }
  async observedOwnerTransaction(sessionId,turn,operation,{registration=false}={}){
    try{return await withObservedOwnerTransaction({store:this.store,sessionId,turn,probe:this.ownerProbe,registration,operation:({host})=>{
      const previous=this.ownerObservation;this.ownerObservation=host;
      try{return operation();}finally{this.ownerObservation=previous;}
    }});}catch(error){if(error instanceof SearchError)throw error;fail('TURN_OWNER_UNKNOWN','Search Host identity could not be verified; keep the request on hold',503);}
  }
  inspectTurnOwnerInTransaction(sessionId,turn){
    try{assertOwnerManifest(this.store.db);}catch{fail('TURN_OWNER_UNKNOWN','Search turn ownership manifest is unavailable or differs',503);}
    text(sessionId,'sessionId',150);if(!Number.isSafeInteger(turn)||turn<1)fail('INVALID_TURN','A valid turn is required',400);
    const cutover=cutoverForSession(this.store.db,sessionId);if(cutover&&turn<=cutover.boundary_turn)fail('TURN_OWNER_UNKNOWN','Legacy owner evidence is quarantined',409);
    const owner=this.store.db.prepare('SELECT * FROM search_turn_owners WHERE session_id=? AND turn=?').get(sessionId,turn);
    if(!owner||owner.state!=='active'||owner.end_seq!==null||owner.end_event_hash!==null||!Number.isSafeInteger(owner.start_seq)||owner.start_seq<1||typeof owner.host_id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(owner.host_id))fail('TURN_OWNER_UNKNOWN','Active turn ownership cannot be verified',409);
    const active=this.store.db.prepare("SELECT turn FROM search_turn_owners WHERE session_id=? AND state='active' AND turn>?").all(sessionId,cutover?.boundary_turn??0);
    if(active.length!==1||active[0].turn!==turn)fail('TURN_OWNER_UNKNOWN','Turn ownership is ambiguous',409);
    const current=currentCutoverTurn(this.store.db,sessionId)?.row??(!cutover?this.store.db.prepare('SELECT * FROM search_session_turns WHERE session_id=?').get(sessionId):null);
    if(current&&(!Number.isSafeInteger(current.latest)||current.latest<0||!(current.stopped_at===null||Number.isSafeInteger(current.stopped_at)&&current.stopped_at>=0&&current.stopped_at<=turn)||current.latest>turn))fail('TURN_OWNER_UNKNOWN','The observed search turn differs',409);
    const claims=this.store.db.prepare('SELECT * FROM search_turn_owner_run_states WHERE session_id=? AND turn=? ORDER BY proposal_id').all(sessionId,turn);
    const processes=[];
    for(const c of claims){const claim=this.store.db.prepare('SELECT * FROM search_run_claims WHERE proposal_id=?').get(c.proposal_id),binding=this.store.db.prepare('SELECT * FROM search_proposal_turn_bindings WHERE proposal_id=?').get(c.proposal_id),processInfo=this.store.db.prepare('SELECT * FROM search_turn_owner_run_processes WHERE proposal_id=?').get(c.proposal_id);
      if(c.host_id!==owner.host_id||!['started','completed'].includes(c.state)||!claim||claim.session_id!==sessionId||claim.run_id!==c.run_id||!binding||binding.session_id!==sessionId||binding.turn!==turn||binding.proposal_hash!==claim.proposal_hash||!processInfo||processInfo.run_id!==c.run_id||!Number.isSafeInteger(processInfo.pid)||processInfo.pid<1||typeof processInfo.controller_instance!=='string'||!/^[a-f0-9-]{36}$/.test(processInfo.controller_instance))fail('TURN_OWNER_UNKNOWN','Search claim ownership or Controller process evidence differs',409);
      processes.push(processInfo);
    }
    const allClaims=this.store.db.prepare('SELECT * FROM search_run_claims WHERE session_id=?').all(sessionId);
    for(const c of allClaims){const b=this.store.db.prepare('SELECT * FROM search_proposal_turn_bindings WHERE proposal_id=?').get(c.proposal_id);if(!b||b.session_id!==sessionId||b.proposal_hash!==c.proposal_hash||!Number.isSafeInteger(b.turn)||b.turn<1)fail('TURN_OWNER_UNKNOWN','A search claim has no valid turn binding',409);}
    const relevant=this.store.db.prepare('SELECT c.proposal_id FROM search_run_claims c JOIN search_proposal_turn_bindings b ON b.proposal_id=c.proposal_id WHERE c.session_id=? AND b.turn=?').all(sessionId,turn);
    if(relevant.length!==claims.length||relevant.some(c=>!claims.some(x=>x.proposal_id===c.proposal_id)))fail('TURN_OWNER_UNKNOWN','Search claim evidence is incomplete',409);
    return {sessionId,turn,hostId:owner.host_id,startSeq:owner.start_seq,observedLatest:current?.latest??null,observedStoppedAt:current?.stopped_at??null,claimsHash:hash(claims),processEvidenceHash:hash(processes),pendingClaims:claims.filter(c=>c.state!=='completed').length,pendingProcesses:claims.filter(c=>c.state==='started').map(c=>{const p=processes.find(x=>x.proposal_id===c.proposal_id);return {proposalId:c.proposal_id,runId:c.run_id,pid:p.pid,controllerInstance:p.controller_instance};})};
  }
  inspectTurnOwner(sessionId,turn){if(!this.store||!this.requireTurnOwner)fail('TURN_OWNER_UNAVAILABLE','Durable turn ownership is not enabled',503);return this.store.transaction(()=>this.inspectTurnOwnerInTransaction(sessionId,turn));}
  inspectLegacyTurnInTransaction(sessionId,turn){
    try{assertOwnerManifest(this.store.db);}catch{fail('LEGACY_EVIDENCE_UNKNOWN','Search turn ownership manifest is unavailable or differs',503);}
    text(sessionId,'sessionId',150);if(!Number.isSafeInteger(turn)||turn<1)fail('INVALID_TURN','A valid legacy turn is required',400);
    const a=this.store.db.prepare('SELECT * FROM search_turn_owner_legacy_attestations WHERE session_id=? AND turn=?').get(sessionId,turn);
    if(!a||typeof a.host_id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(a.host_id)||!Number.isSafeInteger(a.start_seq)||a.start_seq<1||!Number.isSafeInteger(a.end_seq)||a.end_seq<=a.start_seq||a.event_count!==a.end_seq-a.start_seq+1||!/^[a-f0-9]{64}$/.test(a.events_hash??'')||!/^[a-f0-9]{64}$/.test(a.end_event_hash??''))fail('LEGACY_EVIDENCE_UNKNOWN','Saved DSH legacy turn evidence is missing or invalid',409);
    if(this.store.db.prepare('SELECT 1 FROM search_turn_owners WHERE session_id=?').get(sessionId)||this.store.db.prepare('SELECT 1 FROM search_turn_owner_legacy_migrations WHERE session_id=?').get(sessionId))fail('LEGACY_EVIDENCE_UNKNOWN','This session already has ownership or migration evidence',409);
    const current=this.store.db.prepare('SELECT * FROM search_session_turns WHERE session_id=?').get(sessionId);
    if(current&&(!Number.isSafeInteger(current.latest)||current.latest<0||current.latest>turn||current.stopped_at!==null))fail('LEGACY_EVIDENCE_UNKNOWN','Existing search turn or stop cannot be reconciled automatically',409);
    if(this.store.db.prepare('SELECT 1 FROM search_run_claims WHERE session_id=?').get(sessionId)||this.store.db.prepare("SELECT 1 FROM search_proposal_receipts WHERE session_id=? AND state='started'").get(sessionId))fail('LEGACY_EVIDENCE_UNKNOWN','A legacy search claim or unresolved proposal needs separate maintenance',409);
    const history=[];
    for(const name of readdirSync(this.directory).sort()){
      if(!/^[a-f0-9-]{36}\.json$/.test(name))continue;
      const file=this.ledgerFile(name.slice(0,-5));let record;try{record=JSON.parse(readFileSync(file,'utf8'));assertProposalIntegrity(record);}catch{fail('LEGACY_EVIDENCE_UNKNOWN','Saved search history is not verifiable',409);}
      if(record.sessionId!==sessionId)continue;
      if(!['completed','cancelled'].includes(record.phase))fail('LEGACY_EVIDENCE_UNKNOWN','Legacy search is not known to have finished',409);
      history.push({id:record.id,phase:record.phase,recordHash:hash(record)});
    }
    return {sessionId,turn,hostId:a.host_id,attestationHash:hash(a),observedLatest:current?.latest??null,observedStoppedAt:current?.stopped_at??null,historyHash:hash(history)};
  }
  inspectLegacyTurn(sessionId,turn){if(!this.store||!this.requireTurnOwner)fail('TURN_OWNER_UNAVAILABLE','Durable turn ownership is not enabled',503);return this.store.transaction(()=>this.inspectLegacyTurnInTransaction(sessionId,turn));}
  migrateLegacyTurn(input){
    if(!this.store||!this.requireTurnOwner)fail('TURN_OWNER_UNAVAILABLE','Durable turn ownership is not enabled',503);
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='attestationHash,historyHash,hostId,observedLatest,observedStoppedAt,sessionId,turn'||!/^[a-f0-9]{64}$/.test(input.attestationHash??'')||!/^[a-f0-9]{64}$/.test(input.historyHash??''))fail('INVALID_INPUT','Exact inspected legacy evidence is required',400);
    return this.store.transaction(()=>{const observed=this.inspectLegacyTurnInTransaction(input.sessionId,input.turn);if(Object.keys(observed).some(key=>observed[key]!==input[key]))fail('LEGACY_EVIDENCE_CHANGED','Legacy evidence changed; inspect again',409);
      let quiescent=false;try{quiescent=this.verifyLegacyQuiescence?.(observed)===true;}catch{}
      if(!quiescent)fail('LEGACY_EVIDENCE_UNKNOWN','Legacy Controller quiescence is not verified; migration remains on hold',409);
      const recordedAt=now();this.store.db.prepare('INSERT INTO search_turn_owner_legacy_migrations VALUES(?,?,?,?,?,?,?,?)').run(input.sessionId,input.turn,input.hostId,input.attestationHash,input.observedLatest,input.observedStoppedAt,input.historyHash,recordedAt);
      updateOwnerManifest(this.store.db);
      return {...input,state:'legacy-baseline-approved',recordedAt};
    });
  }
  abandonTurnOwner(input){
    if(!this.store||!this.requireTurnOwner)fail('TURN_OWNER_UNAVAILABLE','Durable turn ownership is not enabled',503);
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='claimsHash,hostId,observedLatest,observedStoppedAt,processEvidenceHash,sessionId,startSeq,turn'||!/^[a-f0-9]{64}$/.test(input.claimsHash??'')||!/^[a-f0-9]{64}$/.test(input.processEvidenceHash??''))fail('INVALID_INPUT','Exact inspected turn ownership evidence is required',400);
    return this.store.transaction(()=>{
      const current=this.inspectTurnOwnerInTransaction(input.sessionId,input.turn);
      if(current.hostId!==input.hostId||current.startSeq!==input.startSeq||current.observedLatest!==input.observedLatest||current.observedStoppedAt!==input.observedStoppedAt||current.claimsHash!==input.claimsHash||current.processEvidenceHash!==input.processEvidenceHash)fail('TURN_OWNER_CHANGED','Turn ownership or claims changed; inspect again',409);
      for(const p of current.pendingProcesses){try{process.kill(p.pid,0);fail('TURN_CLAIM_UNCERTAIN','The claim Controller process still exists; do not reopen the turn',409);}catch(error){if(error instanceof SearchError)throw error;if(error?.code!=='ESRCH')fail('TURN_CLAIM_UNCERTAIN','The claim Controller process status is unknown; do not reopen the turn',409);}}
      const latest=Math.max(current.observedLatest??0,input.turn),stopped=Math.max(current.observedStoppedAt??0,input.turn),recordedAt=now();
      for(const p of current.pendingProcesses){
        this.store.db.prepare('INSERT INTO search_turn_owner_uncertain_claims VALUES(?,?,?,?,?,?,?,?)').run(p.proposalId,input.sessionId,input.turn,input.hostId,p.runId,p.controllerInstance,p.pid,recordedAt);
        const marked=this.store.db.prepare("UPDATE search_turn_owner_run_states SET state='uncertain' WHERE proposal_id=? AND session_id=? AND turn=? AND host_id=? AND run_id=? AND state='started'").run(p.proposalId,input.sessionId,input.turn,input.hostId,p.runId);if(marked.changes!==1)fail('TURN_OWNER_CHANGED','Search claim changed',409);
      }
      this.writeTurn(input.sessionId,latest,stopped);
      this.store.db.prepare('INSERT INTO search_turn_owner_recoveries VALUES(?,?,?,?,?,?,?,?)').run(input.sessionId,input.turn,input.hostId,input.startSeq,input.observedLatest,input.observedStoppedAt,input.claimsHash,recordedAt);
      const changed=this.store.db.prepare("UPDATE search_turn_owners SET state='abandoned' WHERE session_id=? AND turn=? AND host_id=? AND state='active' AND start_seq=? AND end_seq IS NULL AND end_event_hash IS NULL").run(input.sessionId,input.turn,input.hostId,input.startSeq);
      if(changed.changes!==1)fail('TURN_OWNER_CHANGED','Turn owner changed',409);
      updateOwnerManifest(this.store.db);
      return {...input,state:'abandoned',uncertainClaims:current.pendingClaims,recordedAt};
    });
  }
  acceptDurableTurn(row){
    if(!row||typeof row.session_id!=='string'||!row.session_id||row.session_id.length>150||!Number.isSafeInteger(row.latest)||row.latest<0||!(row.stopped_at===null||Number.isSafeInteger(row.stopped_at)&&row.stopped_at>=0))fail('LEDGER_CORRUPT','Saved search turn is invalid',503);
    const state={latest:row.latest,stoppedAt:row.stopped_at};this.turns.set(row.session_id,state);return state;
  }
  currentTurn(sessionId){
    if(!this.store)return this.turns.get(sessionId);
    const current=currentCutoverTurn(this.store.db,sessionId),row=current?current.row:this.store.db.prepare('SELECT * FROM search_session_turns WHERE session_id=?').get(sessionId);
    if(!row){this.turns.delete(sessionId);return undefined;}return this.acceptDurableTurn(row);
  }
  writeTurn(sessionId,latest,stoppedAt){const current=currentCutoverTurn(this.store.db,sessionId);if(current){writeCutoverTurn(this.store.db,sessionId,latest,stoppedAt);return;}this.store.db.prepare('INSERT INTO search_session_turns VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET latest=excluded.latest,stopped_at=excluded.stopped_at').run(sessionId,latest,stoppedAt);}
  ensureSessionOpen(sessionId){if(this.persistenceFault)fail('LEDGER_WRITE_FAILED','Search ledger persistence failed; search is blocked until inspected',503);const state=this.currentTurn(sessionId);if(state&&state.stoppedAt!==null)fail('SESSION_STOPPED','The conversation was stopped; a new user turn is required',409);}
  // The trusted DSH pre-step hook calls this only on an explicit user turn.
  registerUserTurn(sessionId,turn,hostId){
    if(this.persistenceFault)fail('LEDGER_WRITE_FAILED','Search ledger persistence failed; search is blocked until inspected',503);
    text(sessionId,'sessionId',150);if(!Number.isSafeInteger(turn)||turn<1)fail('INVALID_TURN','A positive user-turn number is required');
    if(this.requireTurnOwner)return this.observedOwnerTransaction(sessionId,turn,()=>{
      this.ensureOwner(sessionId,turn,hostId);
      if(typeof hostId!=='string'||!hostId)fail('TURN_OWNER_UNKNOWN','The current Host identity is required',503);
      const previous=this.currentTurn(sessionId),count=this.store.db.prepare('SELECT count(*) AS n FROM search_session_turns').get().n;
      if(!previous&&count>=10000)fail('LEDGER_FULL','Search session ledger requires inspection',503);
      if(previous&&turn<previous.latest)fail('STALE_TURN','The user turn is older than the current turn',409);
      if(previous?.stoppedAt!==null&&previous?.stoppedAt!==undefined&&turn<=previous.stoppedAt)fail('SESSION_STOPPED','The stopped turn cannot be reopened',409);
      this.writeTurn(sessionId,turn,null);
      this.turns.set(sessionId,{latest:turn,stoppedAt:null});
    },{registration:true});
    if(this.store){
      let state;try{state=this.store.transaction(()=>{
        this.ensureOwner(sessionId,turn,hostId);
        if(this.requireTurnOwner&&(typeof hostId!=='string'||!hostId))fail('TURN_OWNER_UNKNOWN','The current Host identity is required',503);
        const previous=this.currentTurn(sessionId),count=this.store.db.prepare('SELECT count(*) AS n FROM search_session_turns').get().n;
        if(!previous&&count>=10000)fail('LEDGER_FULL','Search session ledger requires inspection',503);
        if(previous&&turn<previous.latest)fail('STALE_TURN','The user turn is older than the current turn',409);
        if(previous?.stoppedAt!==null&&previous?.stoppedAt!==undefined&&turn<=previous.stoppedAt)fail('SESSION_STOPPED','The stopped turn cannot be reopened',409);
        this.writeTurn(sessionId,turn,null);
        return {latest:turn,stoppedAt:null};
      });}catch(error){if(!(error instanceof SearchError))this.persistenceFault=true;throw error;}
      this.turns.set(sessionId,state);return;
    }
    const previous=this.turns.get(sessionId);
    if(!previous&&this.turns.size>=10000)fail('LEDGER_FULL','Search session ledger requires inspection',503);
    if(previous&&turn<previous.latest)fail('STALE_TURN','The user turn is older than the current turn',409);
    if(previous?.stoppedAt!==null&&previous?.stoppedAt!==undefined&&turn<=previous.stoppedAt)fail('SESSION_STOPPED','The stopped turn cannot be reopened',409);
    if(previous&&turn===previous.latest&&previous.stoppedAt===null)return;
    this.turns.set(sessionId,{latest:turn,stoppedAt:null});try{this.saveSessionStops();}catch(error){if(previous)this.turns.set(sessionId,previous);else this.turns.delete(sessionId);throw error;}
  }
  ensureCurrentTurn(sessionId,turn){
    this.ensureTurnNumber(sessionId,turn);
    this.ensureOwner(sessionId,turn);
  }
  ensureTurnNumber(sessionId,turn){this.ensureSessionOpen(sessionId);const state=this.currentTurn(sessionId);if(!state||!Number.isSafeInteger(turn)||turn<1||turn!==state.latest)fail('STALE_TURN','Search must belong to the current explicit user turn',409);}
  ensureProposalTurn(record){
    this.ensureCurrentTurn(record.sessionId,record.turn);
    if(!this.store)return;
    try{requireCutoverProposal(this.store.db,record);}catch{fail('SEARCH_CUTOVER_UNAVAILABLE','This legacy or unbound search proposal cannot be sent',409);}
    const binding=this.store.db.prepare('SELECT * FROM search_proposal_turn_bindings WHERE proposal_id=?').get(record.id);
    if(!binding||binding.session_id!==record.sessionId||binding.proposal_hash!==record.proposalHash||binding.turn!==record.turn||binding.turn_hash!==record.turnHash||record.turnHash!==proposalTurnHash(record))fail('TURN_BINDING_UNKNOWN','Search proposal turn evidence is missing or differs; inspect without sending',503);
  }
  ensureProposalSendable(record){this.ensureProposalTurn(record);if(this.store?.db.prepare('SELECT 1 FROM search_proposal_cancels WHERE proposal_id=?').get(record.id))fail('SEARCH_CANCELLED','This search proposal was stopped',409);}
  saveProposal(record,{requestId,requestPayloadHash}={}){
    if(!this.store){if(requestId!==undefined)fail('RECEIPT_STORE_UNAVAILABLE','Search request receipts are unavailable; no proposal was sent',503);this.save(record);return clone(record);}
    if(record.turn!==undefined)record.turnHash=proposalTurnHash(record);
    const owner=record.sessionId,id=requestId??randomUUID(),payloadHash=requestPayloadHash??hash({legacy:true,proposalHash:record.proposalHash,requestId:id});
    if(typeof id!=='string'||!/^[-a-zA-Z0-9_]{16,100}$/.test(id)||typeof payloadHash!=='string'||!/^[a-f0-9]{64}$/.test(payloadHash))fail('INVALID_REQUEST_ID','Invalid search request identity',400);
    const admit=()=>{
      if(this.store.db.prepare('SELECT 1 FROM search_proposal_rejections WHERE session_id=? AND request_id=?').get(owner,id))fail('REQUEST_REJECTED','This exact request identity was fenced against admission; inspect the rejection',409);
      const old=this.store.db.prepare('SELECT * FROM search_proposal_receipts WHERE session_id=? AND request_id=?').get(owner,id);
      if(old){if(old.payload_hash!==payloadHash||old.proposal_hash!==record.proposalHash)fail('REQUEST_UNKNOWN','The request identity was already recorded with different input; do not resend',503);if(old.state!=='committed')fail('REQUEST_UNKNOWN','Search proposal remains unresolved; do not resend',503);try{requireCutoverProposal(this.store.db,{id:old.proposal_id,sessionId:owner,proposalHash:old.proposal_hash});}catch{fail('SEARCH_CUTOVER_UNAVAILABLE','Legacy request cannot be reused after cutover',409);}return {existing:true};}
      if(record.turn===undefined)this.ensureSessionOpen(owner);else this.ensureCurrentTurn(owner,record.turn);
      let generation;try{generation=cutoverForSession(this.store.db,owner)?.generation_id??'legacy';}catch{fail('SEARCH_CUTOVER_UNAVAILABLE','Search cutover evidence cannot be verified',503);}
      const generationSchema=this.store.db.prepare("SELECT value FROM meta WHERE key='searchReceiptGenerations:v1'").get()?.value==='done';
      if(!generationSchema&&generation!=='legacy')fail('SEARCH_CUTOVER_UNAVAILABLE','Receipt generation migration is unavailable',503);
      if(generationSchema){if(this.store.db.prepare("SELECT request_id FROM search_proposal_receipts WHERE session_id=? AND generation_id=? AND state='started'").get(owner,generation))fail('REQUEST_UNKNOWN','A search proposal remains unresolved in this generation; do not submit another',409);this.store.db.prepare('INSERT INTO search_proposal_receipts(session_id,request_id,payload_hash,proposal_id,proposal_hash,state,generation_id) VALUES(?,?,?,?,?,?,?)').run(owner,id,payloadHash,record.id,record.proposalHash,'started',generation);}
      else{if(this.store.db.prepare("SELECT request_id FROM search_proposal_receipts WHERE session_id=? AND state='started'").get(owner))fail('REQUEST_UNKNOWN','A search proposal remains unresolved; do not submit another',409);this.store.db.prepare('INSERT INTO search_proposal_receipts VALUES(?,?,?,?,?,?)').run(owner,id,payloadHash,record.id,record.proposalHash,'started');}
      if(record.turn!==undefined)this.store.db.prepare('INSERT INTO search_proposal_turn_bindings VALUES(?,?,?,?,?)').run(record.id,owner,record.proposalHash,record.turn,record.turnHash);
      try{bindCutoverProposal(this.store.db,record);}catch{fail('SEARCH_CUTOVER_UNAVAILABLE','A new proposal cannot be bound to the current cutover',409);}
      updateSearchLedgerManifest(this.store);
      return {existing:false};
    };
    if(this.requireTurnOwner)return (async()=>{
      const admission=await this.observedOwnerTransaction(owner,record.turn,admit);
      if(admission.existing){try{return this.findProposalByRequest(owner,id).proposal;}catch{fail('SEARCH_PROPOSAL_UNKNOWN','The earlier search proposal could not be verified; do not resend',503);}}
      try{
        record.requestId=id;record.requestPayloadHash=payloadHash;await this.save(record);
        await this.observedOwnerTransaction(owner,record.turn,()=>{this.ensureProposalTurn(record);const result=this.store.db.prepare("UPDATE search_proposal_receipts SET state='committed' WHERE session_id=? AND request_id=? AND payload_hash=? AND proposal_id=? AND proposal_hash=? AND state='started'").run(owner,id,payloadHash,record.id,record.proposalHash);if(result.changes!==1)throw Error('Search receipt changed during save');updateSearchLedgerManifest(this.store);});
        return clone(record);
      }catch{fail('SEARCH_PROPOSAL_UNKNOWN','Search proposal admission was recorded but its final state is unknown; do not resend',503);}
    })();
    const admission=this.store.transaction(admit);
    if(admission.existing){try{return this.findProposalByRequest(owner,id).proposal;}catch{fail('SEARCH_PROPOSAL_UNKNOWN','The earlier search proposal could not be verified; do not resend',503);}}
    try{
      record.requestId=id;record.requestPayloadHash=payloadHash;this.save(record);
      this.store.transaction(()=>{if(record.turn===undefined)this.ensureSessionOpen(owner);else this.ensureProposalTurn(record);const result=this.store.db.prepare("UPDATE search_proposal_receipts SET state='committed' WHERE session_id=? AND request_id=? AND payload_hash=? AND proposal_id=? AND proposal_hash=? AND state='started'").run(owner,id,payloadHash,record.id,record.proposalHash);if(result.changes!==1)throw Error('Search receipt changed during save');updateSearchLedgerManifest(this.store);});
      return clone(record);
    }catch(error){fail('SEARCH_PROPOSAL_UNKNOWN','Search proposal admission was recorded but its final state is unknown; do not resend',503);}
  }
  rejectUnadmittedProposal(sessionId,requestId,payloadHash,status){
    if(!this.store)fail('RECEIPT_STORE_UNAVAILABLE','Search rejection evidence is unavailable',503);
    text(sessionId,'sessionId',150);
    if(typeof requestId!=='string'||!/^[-a-zA-Z0-9_]{16,100}$/.test(requestId)||!/^[a-f0-9]{64}$/.test(payloadHash??'')||!Number.isInteger(status)||status<400||status>499)fail('INVALID_INPUT','Search rejection identity is invalid',400);
    return this.store.transaction(()=>{
      if(this.store.db.prepare('SELECT 1 FROM search_proposal_receipts WHERE session_id=? AND request_id=?').get(sessionId,requestId))fail('REQUEST_UNKNOWN','The search may have been admitted; do not classify as rejected',503);
      const old=this.store.db.prepare('SELECT * FROM search_proposal_rejections WHERE session_id=? AND request_id=?').get(sessionId,requestId);
      if(old){if(old.payload_hash!==payloadHash)fail('REQUEST_UNKNOWN','Request identity differs from a recorded fence',503);return this.rejectionReceipt(old,sessionId,requestId);}
      const recordedAt=now();this.store.db.prepare('INSERT INTO search_proposal_rejections VALUES(?,?,?,?,?)').run(sessionId,requestId,payloadHash,status,recordedAt);
      this.store.event(requestId,'search_proposal_rejected',{sessionId,requestId,payloadHash,httpStatus:status,recordedAt});updateSearchLedgerManifest(this.store);
      return {operation:'search-proposal',sessionId,requestId,payloadHash,state:'rejected',reason:'rejected-before-admission',httpStatus:status,recordedAt};
    });
  }
  rejectionReceipt(row,sessionId,requestId){
    if(!row||row.session_id!==sessionId||row.request_id!==requestId||!/^[a-f0-9]{64}$/.test(row.payload_hash??'')||!Number.isInteger(row.http_status)||row.http_status<400||row.http_status>499||typeof row.recorded_at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.recorded_at)||!Number.isFinite(Date.parse(row.recorded_at))||new Date(row.recorded_at).toISOString()!==row.recorded_at)fail('LEDGER_CORRUPT','Search rejection evidence is invalid',503);
    const events=this.store.db.prepare("SELECT json FROM events WHERE run_id=? AND type='search_proposal_rejected'").all(requestId).filter(event=>{try{return JSON.parse(event.json)?.sessionId===sessionId;}catch{return false;}});let data;try{if(events.length===1)data=JSON.parse(events[0].json);}catch{}
    if(events.length!==1||data?.requestId!==requestId||data?.payloadHash!==row.payload_hash||data?.httpStatus!==row.http_status||data?.recordedAt!==row.recorded_at)fail('LEDGER_CORRUPT','Search rejection audit differs',503);
    return {operation:'search-proposal',sessionId,requestId,payloadHash:row.payload_hash,state:'rejected',reason:'rejected-before-admission',httpStatus:row.http_status,recordedAt:row.recorded_at};
  }
  findProposalByRequest(sessionId,requestId){
    if(!this.store)fail('RECEIPT_STORE_UNAVAILABLE','Search request receipts are unavailable',503);
    text(sessionId,'sessionId',150);if(typeof requestId!=='string'||!/^[-a-zA-Z0-9_]{16,100}$/.test(requestId))fail('INVALID_REQUEST_ID','Invalid search request identity',400);
    const row=this.store.db.prepare('SELECT * FROM search_proposal_receipts WHERE session_id=? AND request_id=?').get(sessionId,requestId);
    const rejection=this.store.db.prepare('SELECT * FROM search_proposal_rejections WHERE session_id=? AND request_id=?').get(sessionId,requestId);
    if(row&&rejection)fail('LEDGER_CORRUPT','Search admission and rejection both exist',503);
    if(rejection)return {receipt:this.rejectionReceipt(rejection,sessionId,requestId)};
    if(!row)fail('REQUEST_NOT_OBSERVED','Search request not observed; absence does not prove rejection',404);
    if(row.session_id!==sessionId||!/^[a-f0-9]{64}$/.test(row.payload_hash??'')||!/^[a-f0-9]{64}$/.test(row.proposal_hash??'')||!idPattern.test(row.proposal_id??'')||!['started','committed','abandoned'].includes(row.state))fail('LEDGER_CORRUPT','Search request receipt is invalid',503);
    const abandoned=this.store.db.prepare('SELECT * FROM search_proposal_abandons WHERE session_id=? AND request_id=?').get(sessionId,requestId);
    if(row.state==='abandoned'&&(!abandoned||abandoned.payload_hash!==row.payload_hash||abandoned.proposal_id!==row.proposal_id||abandoned.proposal_hash!==row.proposal_hash||typeof abandoned.created_at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(abandoned.created_at)||!Number.isFinite(Date.parse(abandoned.created_at))||new Date(abandoned.created_at).toISOString()!==abandoned.created_at)||row.state!=='abandoned'&&abandoned)fail('LEDGER_CORRUPT','Search abandonment record differs',503);
    const receipt={requestId,sessionId,payloadHash:row.payload_hash,proposalId:row.proposal_id,proposalHash:row.proposal_hash,state:row.state,...(row.state==='abandoned'?{createdAt:abandoned.created_at}:{})};
    if(row.state==='started'||row.state==='abandoned')return {receipt};
    let record;
    try{const path=this.ledgerFile(row.proposal_id);record=JSON.parse(readFileSync(path,'utf8'));}catch{fail('LEDGER_CORRUPT','Saved search proposal cannot be verified',503);}
    const proposal=record?.kind==='pages'?{kind:'pages',productionId:record.productionId,sessionId:record.sessionId,sourceProposalId:record.sourceProposalId,urls:record.urls,engine:record.engine,purpose:record.purpose}:{kind:'queries',productionId:record?.productionId,sessionId:record?.sessionId,queries:record?.queries,engine:record?.engine,purpose:record?.purpose};
    if(record?.schema!==1||record.id!==row.proposal_id||record.sessionId!==sessionId||record.requestId!==requestId||record.requestPayloadHash!==row.payload_hash||record.proposalHash!==row.proposal_hash||hash(proposal)!==row.proposal_hash||!Array.isArray(record.items)||!['awaiting_approval','approved','running',...terminal].includes(record.phase))fail('LEDGER_CORRUPT','Saved search proposal differs from its receipt',503);
    assertProposalIntegrity(record);
    // Another Controller instance may have committed after this instance was
    // constructed. Load only the validated disk record; never replace an
    // object currently owned by this instance's in-flight outbound request.
    if(!this.active.has(record.id))this.records.set(record.id,clone(record));
    return {proposal:clone(record),receipt};
  }
  abandonProposal(input){
    if(!this.store)fail('RECEIPT_STORE_UNAVAILABLE','Search request receipts are unavailable',503);
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='payloadHash,proposalHash,proposalId,requestId,sessionId')fail('INVALID_INPUT','Exact search receipt evidence is required',400);
    const {sessionId,requestId,payloadHash,proposalId,proposalHash}=input;text(sessionId,'sessionId',150);
    if(typeof requestId!=='string'||!/^[-a-zA-Z0-9_]{16,100}$/.test(requestId)||!/^[a-f0-9]{64}$/.test(payloadHash??'')||!/^[a-f0-9]{64}$/.test(proposalHash??'')||!idPattern.test(proposalId??''))fail('INVALID_INPUT','Search receipt evidence is invalid',400);
    return this.store.transaction(()=>{
      const row=this.store.db.prepare('SELECT * FROM search_proposal_receipts WHERE session_id=? AND request_id=?').get(sessionId,requestId),old=this.store.db.prepare('SELECT * FROM search_proposal_abandons WHERE session_id=? AND request_id=?').get(sessionId,requestId);
      if(!row||row.payload_hash!==payloadHash||row.proposal_id!==proposalId||row.proposal_hash!==proposalHash)fail('REQUEST_MISMATCH','Search receipt ownership or evidence differs',409);
      try{requireCutoverProposal(this.store.db,{id:proposalId,sessionId,proposalHash});}catch{fail('SEARCH_CUTOVER_UNAVAILABLE','Legacy search evidence is quarantined',409);}
      if(row.state==='abandoned'){
        if(!old||old.payload_hash!==payloadHash||old.proposal_id!==proposalId||old.proposal_hash!==proposalHash)fail('LEDGER_CORRUPT','Prior search abandonment differs',503);
        return {receipt:{...input,state:'abandoned',createdAt:old.created_at},created:false};
      }
      if(row.state!=='started'||old)fail('REQUEST_CHANGED','Only the exact pending search proposal can be abandoned',409);
      const result=this.store.db.prepare("UPDATE search_proposal_receipts SET state='abandoned' WHERE session_id=? AND request_id=? AND payload_hash=? AND proposal_id=? AND proposal_hash=? AND state='started'").run(sessionId,requestId,payloadHash,proposalId,proposalHash);
      if(result.changes!==1)fail('REQUEST_CHANGED','Search receipt changed during recovery',409);
      const createdAt=now();this.store.db.prepare('INSERT INTO search_proposal_abandons VALUES(?,?,?,?,?,?)').run(sessionId,requestId,payloadHash,proposalId,proposalHash,createdAt);
      this.store.event(proposalId,'search_proposal_abandoned',{sessionId,requestId,payloadHash,proposalHash});
      updateSearchLedgerManifest(this.store);
      return {receipt:{...input,state:'abandoned',createdAt},created:true};
    });
  }
  propose({productionId=null,sessionId,queries,engine='duckduckgo',purpose,turn,requestId,requestPayloadHash}){
    if(!this.enabled)fail('SEARCH_DISABLED','資料検索は無効です。画像生成は利用できます。',503);
    if(productionId!==null)text(productionId,'productionId',100);text(sessionId,'sessionId',150);text(purpose,'purpose',500);
    if(turn!==undefined){if(this.requireTurnOwner)this.ensureTurnNumber(sessionId,turn);else this.ensureCurrentTurn(sessionId,turn);}else this.ensureSessionOpen(sessionId);
    if(engine!=='duckduckgo')fail('ENGINE_NOT_ALLOWED','Only the explicitly configured DuckDuckGo engine is available');
    queries=queryList(queries);
    const proposal={kind:'queries',productionId,sessionId,queries,engine,purpose};
    const record={schema:1,id:randomUUID(),...proposal,...(turn===undefined?{}:{turn}),proposalHash:hash(proposal),phase:'awaiting_approval',createdAt:now(),updatedAt:now(),approvedAt:null,approval:null,items:queries.map(query=>({query,state:'unsent',sentAt:null,completedAt:null,results:[]})),error:null};
    return this.saveProposal(record,{requestId,requestPayloadHash});
  }
  proposePageReads({productionId=null,sessionId,sourceProposalId,urls,purpose,turn,requestId,requestPayloadHash}){
    if(!this.enabled)fail('SEARCH_DISABLED','資料検索は無効です。画像生成は利用できます。',503);
    if(productionId!==null)text(productionId,'productionId',100);text(sessionId,'sessionId',150);
    if(turn!==undefined){if(this.requireTurnOwner)this.ensureTurnNumber(sessionId,turn);else this.ensureCurrentTurn(sessionId,turn);}else this.ensureSessionOpen(sessionId);
    text(purpose,'purpose',500);
    const source=this.owned(sourceProposalId,sessionId);
    if(source.kind!=='queries'||source.phase!=='completed'||source.productionId!==productionId)fail('SOURCE_NOT_COMPLETED','Page reads require a completed search from the same session and production scope',409);
    if(!Array.isArray(urls)||urls.length<1||urls.length>3||new Set(urls).size!==urls.length)fail('INVALID_URLS','Provide one to three distinct search-result URLs');
    const returned=new Set(source.items.flatMap(item=>item.results.map(result=>result.url)));
    for(const url of urls){if(!returned.has(url))fail('URL_NOT_RETURNED','Only exact URLs returned by the approved search can be proposed',403);pageUrl(url);}
    const proposal={kind:'pages',productionId,sessionId,sourceProposalId,urls:clone(urls),engine:'website-fetch',purpose};
    const record={schema:1,id:randomUUID(),...proposal,...(turn===undefined?{}:{turn}),proposalHash:hash(proposal),phase:'awaiting_approval',createdAt:now(),updatedAt:now(),approvedAt:null,approval:null,items:urls.map(url=>({url,state:'unsent',sentAt:null,completedAt:null,results:[]})),error:null};
    return this.saveProposal(record,{requestId,requestPayloadHash});
  }
  list({productionId,sessionId}={}){return [...this.records.values()].filter(r=>(!productionId||r.productionId===productionId)&&(!sessionId||r.sessionId===sessionId)&&this.visible(r)).map(record=>{assertProposalIntegrity(record);this.checkLedgerFile(record);return clone(record);});}
  status(id,{sessionId}={}){return clone(sessionId===undefined?this.get(id):this.owned(id,sessionId));}
  async registerGateway({sessionId,hostId,port}){if(!this.requireGatewayOpen||typeof this.openHandshake?.register!=='function')fail('SEARCH_GATEWAY_UNAVAILABLE','Search gateway confirmation is unavailable; local work can continue',503);try{return await this.openHandshake.register({sessionId,hostId,port});}catch{fail('SEARCH_GATEWAY_UNAVAILABLE','Search gateway confirmation is unavailable; local work can continue',503);}}
  async confirmGateway(record,operation,signal){if(!this.requireGatewayOpen)return;if(typeof this.openHandshake?.requireOpen!=='function')fail('SEARCH_GATEWAY_UNAVAILABLE','Search gateway confirmation is unavailable; local work can continue',503);try{if(await this.openHandshake.requireOpen({sessionId:record.sessionId,turn:record.turn,operation,proposalId:record.id,signal})!==true)throw Error('not open');}catch{fail('SEARCH_GATEWAY_UNAVAILABLE','Search gateway confirmation is unavailable; local work can continue',503);}}
  approve(id,{queries,urls,engine,actor,proposalHash}={}){
    if(!this.enabled)fail('SEARCH_DISABLED','資料検索は無効です。画像生成は利用できます。',503);
    const record=this.get(id);if(this.requireTurnOwner)this.ensureTurnNumber(record.sessionId,record.turn);else this.ensureProposalTurn(record);if(record.phase!=='awaiting_approval')fail('NOT_AWAITING_APPROVAL','This proposal cannot be approved',409);
    if(actor!=='user')fail('USER_APPROVAL_REQUIRED','Only an authenticated user approval is accepted',403);
    if((record.kind==='pages'?JSON.stringify(urls)!==JSON.stringify(record.urls):JSON.stringify(queries)!==JSON.stringify(record.queries))||engine!==record.engine||(proposalHash!==undefined&&proposalHash!==record.proposalHash))fail('APPROVAL_MISMATCH','The displayed query/URL set or engine differs from the proposal',409);
    const admit=()=>{
      this.ensureProposalSendable(record);
      if(this.store.db.prepare('SELECT proposal_id FROM search_approval_claims WHERE proposal_id=?').get(id))fail('APPROVAL_UNKNOWN','This proposal has already been accepted for approval; inspect it without retrying',503);
      this.store.db.prepare('INSERT INTO search_approval_claims VALUES(?,?,?,?,?)').run(id,record.sessionId,record.proposalHash,hash({engine:record.engine,values:record.kind==='pages'?record.urls:record.queries}),now());
      updateSearchLedgerManifest(this.store);
    };
    if(this.requireTurnOwner)return (async()=>{
      await this.confirmGateway(record,'approve');
      await this.observedOwnerTransaction(record.sessionId,record.turn,admit);
      record.approvedAt=now();record.approval={actor,proposalHash:record.proposalHash,...(record.kind==='pages'?{urls:clone(urls)}:{queries:clone(queries)}),engine,pageReadsAllowed:record.kind==='pages'};record.phase='approved';
      try{await this.save(record);}catch{fail('APPROVAL_UNKNOWN','Search approval was recorded but its final state is unknown; inspect without retrying',503);}return clone(record);
    })();
    if(this.store)this.store.transaction(admit);
    record.approvedAt=now();record.approval={actor,proposalHash:record.proposalHash,...(record.kind==='pages'?{urls:clone(urls)}:{queries:clone(queries)}),engine,pageReadsAllowed:record.kind==='pages'};record.phase='approved';
    try{this.save(record);}catch(error){if(this.store)fail('APPROVAL_UNKNOWN','Search approval was recorded but its final state is unknown; inspect without retrying',503);throw error;}return clone(record);
  }
  claimRun(record){
    if(!this.store)fail('RECEIPT_STORE_UNAVAILABLE','Search dispatch requires the Controller receipt store',503);
    const runId=randomUUID();
    const action=()=>{
      this.ensureProposalSendable(record);
      const approval=this.store.db.prepare('SELECT * FROM search_approval_claims WHERE proposal_id=?').get(record.id);
      const targetsHash=hash({engine:record.engine,values:record.kind==='pages'?record.urls:record.queries});
      if((record.requestId!==undefined&&!approval)||(approval&&(approval.session_id!==record.sessionId||approval.proposal_hash!==record.proposalHash||approval.targets_hash!==targetsHash)))fail('APPROVAL_UNKNOWN','Search approval ownership or targets cannot be verified',503);
      if(this.store.db.prepare('SELECT proposal_id FROM search_run_claims WHERE proposal_id=?').get(record.id))fail('SEARCH_ALREADY_CLAIMED','This approved search may already have started; do not resend',503);
      this.store.db.prepare('INSERT INTO search_run_claims VALUES(?,?,?,?,?)').run(record.id,record.sessionId,record.proposalHash,runId,now());
      updateSearchLedgerManifest(this.store);
      if(this.requireTurnOwner){const owner=this.ensureOwner(record.sessionId,record.turn);this.store.db.prepare("INSERT INTO search_turn_owner_run_states VALUES(?,?,?,?,?,'started')").run(record.id,record.sessionId,record.turn,owner.host_id,runId);this.store.db.prepare('INSERT INTO search_turn_owner_run_processes VALUES(?,?,?,?)').run(record.id,runId,this.controllerInstanceId,process.pid);updateOwnerManifest(this.store.db);}
    };
    if(this.requireTurnOwner)return (async()=>{await this.confirmGateway(record,'claim');await this.observedOwnerTransaction(record.sessionId,record.turn,action);return runId;})();
    this.store.transaction(action);return runId;
  }
  claimItem(record,index,runId){
    if(!Number.isSafeInteger(index)||index<0||index>=record.items.length)fail('LEDGER_CORRUPT','Invalid search item index',503);
    const action=()=>{
      this.ensureProposalSendable(record);
      const run=this.store.db.prepare('SELECT * FROM search_run_claims WHERE proposal_id=?').get(record.id);
      if(!run||run.run_id!==runId||run.session_id!==record.sessionId||run.proposal_hash!==record.proposalHash)fail('SEARCH_OWNERSHIP_UNKNOWN','Search run ownership is not confirmed',503);
      const approval=this.store.db.prepare('SELECT * FROM search_approval_claims WHERE proposal_id=?').get(record.id),targetsHash=hash({engine:record.engine,values:record.kind==='pages'?record.urls:record.queries});
      if((record.requestId!==undefined&&!approval)||(approval&&(approval.session_id!==record.sessionId||approval.proposal_hash!==record.proposalHash||approval.targets_hash!==targetsHash)))fail('APPROVAL_UNKNOWN','Search approval ownership or targets cannot be verified',503);
      if(this.store.db.prepare('SELECT proposal_id FROM search_item_claims WHERE proposal_id=? AND item_index=?').get(record.id,index))fail('SEARCH_ALREADY_CLAIMED','This search item may already have been sent; do not resend',503);
      const item=record.items[index],target=record.kind==='pages'?item.url:item.query;
      this.store.db.prepare('INSERT INTO search_item_claims VALUES(?,?,?,?,?,?,?)').run(record.id,index,record.sessionId,record.proposalHash,runId,hash({kind:record.kind,target,engine:record.engine}),now());
      updateSearchLedgerManifest(this.store);
    };
    if(this.requireTurnOwner)return (async()=>{await this.confirmGateway(record,'claim');return this.observedOwnerTransaction(record.sessionId,record.turn,action);})();
    this.store.transaction(action);
  }
  cancel(id){
    const record=this.get(id);if(this.store)try{requireCutoverProposal(this.store.db,record);}catch{fail('SEARCH_CUTOVER_UNAVAILABLE','Legacy search evidence is quarantined',409);}if(terminal.has(record.phase))return clone(record);
    // Abort local work even if persisting the stop later fails.
    this.active.get(id)?.abort(new Error('Search cancelled'));
    if(this.store)this.store.transaction(()=>{
      const old=this.store.db.prepare('SELECT * FROM search_proposal_cancels WHERE proposal_id=?').get(id);
      if(old&&(old.session_id!==record.sessionId||old.proposal_hash!==record.proposalHash))fail('LEDGER_CORRUPT','Search cancellation ownership differs',503);
      if(!old){this.store.db.prepare('INSERT INTO search_proposal_cancels VALUES(?,?,?,?)').run(id,record.sessionId,record.proposalHash,now());updateSearchLedgerManifest(this.store);}
      for(const claim of this.store.db.prepare('SELECT * FROM search_item_claims WHERE proposal_id=?').all(id)){
        if(claim.session_id!==record.sessionId||claim.proposal_hash!==record.proposalHash||!Number.isSafeInteger(claim.item_index)||claim.item_index<0||claim.item_index>=record.items.length)fail('LEDGER_CORRUPT','Search item claim differs during cancellation',503);
        if(record.items[claim.item_index].state==='unsent')record.items[claim.item_index].state='uncertain';
      }
    });
    record.phase='cancelled';record.cancelledAt=now();try{this.save(record);}catch(error){this.persistenceFault=true;throw error;}return clone(record);
  }
  cancelProduction(productionId){return this.list({productionId}).filter(r=>{if(!this.store)return true;try{requireCutoverProposal(this.store.db,r);return true;}catch{return false;}}).map(r=>this.cancel(r.id));}
  cancelTurn(sessionId,turn){
    text(sessionId,'sessionId',150);
    // A user-turn registration may still be in flight when cancellation is
    // received. Persist the stop first so that the late registration cannot
    // reopen the same turn. Older-than-observed stops remain forbidden.
    if(!Number.isSafeInteger(turn)||turn<1)fail('INVALID_TURN','A positive user-turn number is required',400);
    return this.cancelSession(sessionId,turn);
  }
  validateStopTurn(sessionId,turn){
    text(sessionId,'sessionId',150);
    if(turn!==undefined&&(!Number.isSafeInteger(turn)||turn<1))fail('INVALID_TURN','A valid stopped turn is required');
    if(this.store){const generation=cutoverForSession(this.store.db,sessionId);if(generation&&(turn!==undefined&&turn<=generation.boundary_turn||turn===undefined&&!this.currentTurn(sessionId)))fail('STALE_TURN','A legacy or unavailable turn cannot stop the new search generation',409);}
    if(turn!==undefined&&turn<(this.currentTurn(sessionId)?.latest??0))fail('STALE_TURN','The stop request refers to an older conversation turn',409);
  }
  cancelSession(sessionId,turn){
    let failure;const cancelled=[];
    try{this.validateStopTurn(sessionId,turn);}catch(error){if(error instanceof SearchError&&[400,409].includes(error.status))throw error;this.persistenceFault=true;failure=error;}
    if(this.store&&!failure){
      try{const state=this.store.transaction(()=>{
        const previous=this.currentTurn(sessionId),count=this.store.db.prepare('SELECT count(*) AS n FROM search_session_turns').get().n;
        if(!previous&&count>=10000)fail('LEDGER_FULL','Search session ledger requires inspection',503);
        if(turn!==undefined&&turn<(previous?.latest??0))fail('STALE_TURN','The stop request refers to an older conversation turn',409);
        const latest=Math.max(previous?.latest??0,turn??0),stoppedAt=Math.max(previous?.stoppedAt??0,latest||Number.MAX_SAFE_INTEGER);
        this.writeTurn(sessionId,latest,stoppedAt);
        return {latest,stoppedAt};
      });this.turns.set(sessionId,state);}catch(error){if(error instanceof SearchError&&error.status===409)throw error;this.persistenceFault=true;failure=error;}
    }else if(!this.store&&!failure){
      const previous=this.turns.get(sessionId);if(!previous&&this.turns.size>=10000)fail('LEDGER_FULL','Search session ledger requires inspection',503);
      const latest=Math.max(previous?.latest??0,turn??0),stoppedAt=Math.max(previous?.stoppedAt??0,latest||Number.MAX_SAFE_INTEGER);
      this.turns.set(sessionId,{latest,stoppedAt});try{this.saveSessionStops();}catch(error){this.persistenceFault=true;failure=error;}
    }
    // Even if persistence failed, stop all owned outbound work immediately.
    for(const [id,controller] of this.active){const record=this.records.get(id);if(record?.sessionId===sessionId)controller.abort(new Error('Search session cancelled'));}
    for(const record of this.records.values())if(record.sessionId===sessionId&&this.visible(record))try{if(this.store)try{requireCutoverProposal(this.store.db,record);}catch{continue;}cancelled.push(this.cancel(record.id));}catch(error){failure??=error;}
    if(failure)throw failure;
    return cancelled;
  }
  async run(id,{sessionId,signal}={}){
    if(!this.enabled)fail('SEARCH_DISABLED','資料検索は無効です。画像生成は利用できます。',503);
    const record=this.owned(id,sessionId);
    if(this.requireTurnOwner)await this.observedOwnerTransaction(sessionId,record.turn,()=>this.ensureProposalTurn(record));else this.ensureProposalTurn(record);
    if(record.phase!=='approved'||!record.approval||record.items.some(x=>x.state!=='unsent'))fail('SEARCH_NOT_RUNNABLE','Only an unused, explicitly approved search grant can run',409);
    if(signal?.aborted){this.cancel(id);return clone(record);}
    const runId=await this.claimRun(record),controller=new AbortController();const abort=()=>{controller.abort(new Error('Search cancelled'));try{this.cancel(id);}catch{this.persistenceFault=true;}};signal?.addEventListener('abort',abort,{once:true});this.active.set(id,controller);if(signal?.aborted)abort();
    try{
      if(record.phase!=='cancelled'){record.phase='running';await this.save(record);}
      for(let index=0;index<record.items.length;index++){
        const item=record.items[index];
        if(record.phase==='cancelled'||controller.signal.aborted)break;
        if(!this.requireTurnOwner)this.ensureProposalTurn(record);
        assertProposalIntegrity(record);
        // Commit intent before the first byte is sent. Uncertainty is never treated as permission to retry.
        await this.claimItem(record,index,runId);
        item.state='sent';item.sentAt=now();await this.save(record);
        // The exact item and user approval are rechecked immediately before
        // external I/O; a corrupted item is never sent.
        assertProposalIntegrity(record);
        if(this.requireTurnOwner)await this.observedOwnerTransaction(sessionId,record.turn,()=>this.ensureProposalSendable(record));else this.ensureProposalSendable(record);
        await this.confirmGateway(record,'fetch',controller.signal);
        if(record.phase==='cancelled'||controller.signal.aborted)break;
        const requestSignal=AbortSignal.any([controller.signal,AbortSignal.timeout(this.timeoutMs)]);
        if(record.kind==='pages'){
          const page=await this.pageReader(item.url,{signal:requestSignal});item.results=[{...page,engine:'website-fetch'}];
        }else{
          const url=new URL('/search',this.baseUrl);url.searchParams.set('q',item.query);url.searchParams.set('format','json');url.searchParams.set('engines',record.engine);url.searchParams.set('categories','general');url.searchParams.set('max_results',String(this.maxResults));url.searchParams.set('include_raw_content','0');
          const response=await this.fetchImpl(url,{method:'GET',redirect:'error',headers:{Accept:'application/json'},signal:requestSignal});
          const body=await boundedJson(response);
          if(!Array.isArray(body.results))throw new SearchError('UPSTREAM_CONTRACT','RustXNG results are missing',502);
          if(Array.isArray(body.unresponsive_engines)&&body.unresponsive_engines.length)throw new SearchError('UPSTREAM_ENGINE_FAILURE','The approved engine reported a failure',502);
          if(body.results.some(r=>r.engine!==record.engine||!Array.isArray(r.engines)||r.engines.some(e=>e!==record.engine)))throw new SearchError('UPSTREAM_ENGINE_MISMATCH','RustXNG returned an unapproved or unknown engine',502);
          item.results=body.results.slice(0,this.maxResults).flatMap(result=>{const url=publicResultUrl(result.url);return url?[{title:String(result.title??'').slice(0,240),url,content:String(result.content??'').slice(0,700),engine:record.engine,retrievedAt:now()}]:[];});
        }
        item.state='completed';item.completedAt=now();item.resultCount=item.results.length;await this.save(record);
      }
      if(record.phase!=='cancelled'){
        record.phase='completed';record.completedAt=now();await this.save(record);
        if(this.requireTurnOwner)await this.observedOwnerTransaction(record.sessionId,record.turn,()=>{
          const owner=this.ensureOwner(record.sessionId,record.turn),claim=this.store.db.prepare('SELECT * FROM search_run_claims WHERE proposal_id=?').get(record.id);
          if(!claim||claim.session_id!==record.sessionId||claim.proposal_hash!==record.proposalHash||claim.run_id!==runId||record.items.some(item=>item.state!=='completed'))fail('SEARCH_OWNERSHIP_UNKNOWN','Search completion cannot be verified',503);
          const changed=this.store.db.prepare("UPDATE search_turn_owner_run_states SET state='completed' WHERE proposal_id=? AND session_id=? AND turn=? AND host_id=? AND run_id=? AND state='started'").run(record.id,record.sessionId,record.turn,owner.host_id,runId);
          if(changed.changes!==1)fail('SEARCH_OWNERSHIP_UNKNOWN','Search completion owner differs',503);
          updateOwnerManifest(this.store.db);
        });
      }
    }catch(error){
      for(const item of record.items)if(item.state==='sent')item.state='uncertain';
      if(record.phase!=='cancelled'){record.phase='needs_attention';record.error={code:error instanceof SearchError?error.code:(error?.name==='TimeoutError'?'SEARCH_TIMEOUT':'SEARCH_UNCERTAIN'),message:'Search did not finish with a verified response. No automatic retry or provider fallback was made.'};}
      try{await this.save(record);}catch(saveError){if(!(saveError instanceof SearchError&&['SESSION_STOPPED','STALE_TURN','SEARCH_CANCELLED'].includes(saveError.code)))throw saveError;}
    }finally{signal?.removeEventListener('abort',abort);this.active.delete(id);}
    return clone(record);
  }
}
