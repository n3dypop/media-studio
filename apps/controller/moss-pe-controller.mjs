// Production-bound PE orchestration. MOSS and Qwen use separate run kinds,
// license/availability gates and disabled-by-default HTTP exposure. PE runs
// must be routed here rather than through the image RunEngine.
import {createHash,randomUUID} from 'node:crypto';
import {ApiError,digest,normalizeRequest,terminalPhases} from './store.mjs';
import {MOSS_OFFICIAL_IDS,QWEN21_OFFICIAL_IDS} from './media-modes.mjs';
import {validateSession} from './productions.mjs';
import {MossPeStage} from './moss-pe-stage.mjs';
import {buildMossPromptEnhancer,inspectMossPromptEnhancer} from './moss-prompt-enhancer.mjs';
import {QWEN_PE_CONTRACT,assertQwenPeInputDimensions} from './qwen21-prompt-enhancer.mjs';
import {inputRgbaBytesFloor} from './input-memory-floor.mjs';
import {GateError} from './resource-gate.mjs';
import {readExternalPrompt} from './external-prompts.mjs';
import {scheduleOwnedLaunch} from './owned-launch.mjs';
import {hasBinaryPrimaryKey} from './schema-integrity.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const now=()=>new Date().toISOString();
const sha256=value=>createHash('sha256').update(value).digest('hex');
const errorText=e=>String(e?.message??e).slice(0,1000);
const text=(x,max,label)=>{if(typeof x!=='string'||!x.trim()||x.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(x))throw new ApiError(400,`${label} is invalid`);return x;};
const requirements=(p,run)=>[{kind:'user-request',requirement:p.brief.request},{kind:'source-prompt',requirement:run.spec.prompt},...['invariants','requiredConditions','avoid'].flatMap(kind=>(p.brief[kind]??[]).map(requirement=>({kind,requirement})))];
const peReceiptSchemas={
  pe_start_receipts:'session_id TEXT NOT NULL,request_id TEXT NOT NULL,run_id TEXT NOT NULL,production_id TEXT NOT NULL,family TEXT NOT NULL,payload_hash TEXT NOT NULL,expected_revision INTEGER NOT NULL,production_revision INTEGER NOT NULL,production_event_seq INTEGER NOT NULL,PRIMARY KEY(session_id,request_id)',
  pe_decision_receipts:'session_id TEXT NOT NULL,request_id TEXT NOT NULL,run_id TEXT NOT NULL,production_id TEXT NOT NULL,family TEXT NOT NULL,payload_hash TEXT NOT NULL,expected_revision INTEGER NOT NULL,production_revision INTEGER NOT NULL,decision_hash TEXT NOT NULL,run_event_seq INTEGER NOT NULL,production_event_seq INTEGER NOT NULL,PRIMARY KEY(session_id,request_id)',
  pe_reconcile_receipts:'session_id TEXT NOT NULL,request_id TEXT NOT NULL,run_id TEXT NOT NULL,production_id TEXT NOT NULL,family TEXT NOT NULL,payload_hash TEXT NOT NULL,receipt_hash TEXT NOT NULL,event_seq INTEGER NOT NULL,receipt_json TEXT NOT NULL,PRIMARY KEY(session_id,request_id)',
};

export class MossPeCoordinator{
  constructor({store,productions,adapter,gate,assets,verifyEpoch,pollIntervalMs=1500,timeoutMs=900000,family='moss',licenseCheck=null}){
    if(!store||!productions||!adapter||!gate||typeof verifyEpoch!=='function'||!Number.isSafeInteger(pollIntervalMs)||pollIntervalMs<1||!Number.isSafeInteger(timeoutMs)||timeoutMs<1)throw new TypeError('Invalid MOSS PE coordinator dependencies');
    if(!['moss','qwen'].includes(family)||family==='qwen'&&typeof licenseCheck!=='function')throw new TypeError('PE family and Qwen license check are required');
    Object.assign(this,{store,productions,adapter,gate,assets,verifyEpoch,pollIntervalMs,timeoutMs,family,licenseCheck});
    this.kind=family==='qwen'?'qwen-pe':'moss-pe';this.stateKey=family==='qwen'?'qwenPe':'mossPe';this.decisionKey=family==='qwen'?'qwenPeDecision':'mossPeDecision';
    this.store.transaction(()=>{const hadReceiptMarker=Boolean(this.store.db.prepare("SELECT 1 FROM meta WHERE key='peReceiptSchema:v1'").get());this.initializeReceiptTables();this.initializeLegacyOrigins(hadReceiptMarker);this.verifyReceiptTables();});
    this.work=new Set();
    this.stage=new MossPeStage({store,adapter,gate,assets,checkEpoch:run=>this.checkEpoch(run),stateKey:this.stateKey,...(family==='qwen'?{contract:QWEN_PE_CONTRACT}:{})});
  }
  async checkEpoch(run){const epoch=await this.verifyEpoch();if(!run.serverEpoch||digest(epoch)!==digest(run.serverEpoch))throw Error('ComfyUI epoch changed; PE was not retried or released');return epoch;}
  async availability(mode='t2i'){
    try{
      const scope=`official-${this.family}-prompt-enhancement`;
      if(this.family==='qwen'){
        if(!['t2i','edit'].includes(mode)||await this.licenseCheck()!==true)return {available:false,scope,reason:'license-or-mode-unconfirmed'};
        const sessionId='availability-fixture',id='11111111-1111-4111-8111-111111111111',hash='a'.repeat(64),prefix=sha256(sessionId).slice(0,24);
        const inputAssets=mode==='edit'?[{id,purpose:'input',sha256:hash,width:512,height:512,comfyInputName:`controller-assets/${prefix}/${id}-${hash}.png`}]:[];
        const options={mode,prompt:'Availability check only',seed:'0',inputAssets,sessionId},built=QWEN_PE_CONTRACT.build(options);
        const inspection=QWEN_PE_CONTRACT.inspect(built.graph,options,await this.adapter.request('/object_info'));
        return {available:inspection.ready,scope,mode,qualification:'static-schema-only',...(inspection.ready?{}:{reason:'nodes-or-model-unavailable'})};
      }
      const options={prompt:'Availability check only',seed:'0'},built=buildMossPromptEnhancer(options);
      const inspection=inspectMossPromptEnhancer(built.graph,options,await this.adapter.request('/object_info'));
      return {available:inspection.ready,scope,qualification:'static-schema-only',...(inspection.ready?{}:{reason:'nodes-or-model-unavailable'})};
    }catch{return {available:false,scope:`official-${this.family}-prompt-enhancement`,reason:'availability-unconfirmed'};}
  }
  get(id,session){
    validateSession(session);const run=this.store.get(id);
    if(!run||run.kind!==this.kind||run.sessionId!==session)throw new ApiError(404,'PE run is not owned by this session');
    this.productions.get(run.productionId,session);return run;
  }
  verifyOriginInTransaction(id,session){
    const run=this.get(id,session),p=this.productions.get(run.productionId,session),stored=this.store.db.prepare('SELECT id,request_id,payload_hash,phase FROM runs WHERE id=?').get(id),origin=this.store.db.prepare('SELECT session_id,request_id,payload_hash FROM productions WHERE id=?').get(p.id);
    const created=this.store.db.prepare("SELECT seq,json FROM events WHERE run_id=? AND type='production_created'").all(p.id),runCreated=this.store.db.prepare("SELECT seq,json FROM events WHERE run_id=? AND type='created'").all(id),requests=this.store.db.prepare('SELECT seq,json FROM events WHERE run_id=? AND type=?').all(p.id,`${this.family}_pe_requested`);
    let creation,runData;try{if(created.length===1)creation=JSON.parse(created[0].json);if(runCreated.length===1)runData=JSON.parse(runCreated[0].json);}catch{}
    const matches=requests.filter(item=>{try{return JSON.parse(item.json)?.runId===id;}catch{return false;}});let request;try{if(matches.length===1)request=JSON.parse(matches[0].json);}catch{}
    if(!p.brief||typeof p.brief!=='object'||Array.isArray(p.brief)||!run.spec||typeof run.spec!=='object'||Array.isArray(run.spec)||p.id!==run.productionId||p.sessionId!==session||origin?.session_id!==session||origin.request_id!==p.requestId||origin.payload_hash!==p.briefHash||digest(p.brief)!==p.briefHash||created.length!==1||creation?.briefHash!==p.briefHash||
      run.id!==id||run.sessionId!==session||run.kind!==this.kind||stored?.id!==id||stored.request_id!==run.requestId||stored.phase!==run.phase||stored.payload_hash!==digest(run.spec)||run.specHash!==stored.payload_hash||run.spec.task!==this.kind||run.spec.productionId!==p.id||run.spec.briefHash!==p.briefHash||typeof run.spec.prompt!=='string'||!Number.isSafeInteger(run.productionRevision)||run.productionRevision<1||!Number.isSafeInteger(p.revision)||p.revision<run.productionRevision||!Array.isArray(p.promptEnhancements)||p.promptEnhancements.filter(x=>x===id).length!==1||
      runCreated.length!==1||runData?.specHash!==stored.payload_hash||matches.length!==1||request?.runId!==id||request?.revision!==run.productionRevision||request?.reason!==run.spec.reason||request?.originalPromptSha256!==sha256(run.spec.prompt)||created[0].seq>=matches[0].seq||matches[0].seq>=runCreated[0].seq)throw new ApiError(409,'The original PE run, production or audit evidence differs');
    return {run,production:p,payloadHash:stored.payload_hash,productionEventSeq:matches[0].seq,runCreatedSeq:runCreated[0].seq};
  }
  receiptManifest(){const data={};for(const table of Object.keys(peReceiptSchemas))data[table]=this.store.db.prepare(`SELECT * FROM ${table} ORDER BY session_id,request_id`).all();return JSON.stringify({sha256:digest(data),counts:Object.fromEntries(Object.entries(data).map(([key,rows])=>[key,rows.length]))});}
  initializeReceiptTables(){
    const db=this.store.db,marker=db.prepare("SELECT value FROM meta WHERE key='peReceiptSchema:v1'").get(),saved=db.prepare("SELECT value FROM meta WHERE key='peReceiptManifest:v1'").get();
    if(marker&&marker.value!=='done'||marker&&!saved||saved&&!marker)throw Error('PE receipt schema marker or manifest is invalid');
    if(!marker&&!saved&&db.prepare("SELECT 1 FROM meta WHERE key IN ('peLegacySnapshot:v1:moss','peLegacySnapshot:v1:qwen','peLegacyManifest:v1:moss','peLegacyManifest:v1:qwen') LIMIT 1").get())throw Error('PE receipt migration evidence is missing from an initialized database');
    if(!marker&&!saved&&db.prepare("SELECT 1 FROM events WHERE type IN ('moss_pe_reconcile_requested','qwen_pe_reconcile_requested') LIMIT 1").get())throw Error('PE receipt migration evidence is missing despite a saved reconciliation event');
    for(const [table,definition] of Object.entries(peReceiptSchemas)){
      const found=db.prepare("SELECT type FROM sqlite_master WHERE name=?").get(table);
      if(!found){if(marker)throw Error('PE receipt table is missing after migration');db.exec(`CREATE TABLE ${table}(${definition})`);}else if(found.type!=='table')throw Error('PE receipt storage is not a table');
      const expected=definition.split(',PRIMARY KEY(')[0].split(',').map(part=>part.trim().split(/\s+/)),columns=db.prepare(`PRAGMA table_xinfo(${table})`).all();
      if(columns.length!==expected.length||columns.some((col,i)=>col.name!==expected[i][0]||String(col.type).toUpperCase()!==expected[i][1]||col.notnull!==1||col.hidden!==0||col.pk!==(i===0?1:i===1?2:0))||!hasBinaryPrimaryKey(db,table,['session_id','request_id']))throw Error('PE receipt schema is invalid');
    }
    const actual=this.receiptManifest();if(saved&&saved.value!==actual)throw Error('PE receipt manifest differs');
    if(!marker)db.prepare("INSERT INTO meta(key,value) VALUES('peReceiptSchema:v1','done')").run();if(!saved)db.prepare("INSERT INTO meta(key,value) VALUES('peReceiptManifest:v1',?)").run(actual);
  }
  updateReceiptManifest(){const updated=this.store.db.prepare("UPDATE meta SET value=? WHERE key='peReceiptManifest:v1'").run(this.receiptManifest());if(updated.changes!==1)throw Error('PE receipt manifest is missing');}
  verifyReceiptTables(){
    for(const [table,method] of [['pe_start_receipts','findStartInTransaction'],['pe_decision_receipts','findDecisionInTransaction'],['pe_reconcile_receipts','findReconcileInTransaction']]){
      for(const row of this.store.db.prepare(`SELECT * FROM ${table}`).all()){
        if(!['moss','qwen'].includes(row.family))throw Error('PE receipt family is invalid');const view=Object.create(this);view.family=row.family;view.kind=`${row.family}-pe`;view.stateKey=row.family==='qwen'?'qwenPe':'mossPe';view.decisionKey=row.family==='qwen'?'qwenPeDecision':'mossPeDecision';
        try{const result=view[method](table==='pe_start_receipts'?row.production_id:row.run_id,row.session_id,row.request_id);if(!result?.receipt)throw Error('receipt unavailable');}catch{throw Error('PE receipt source evidence differs');}
      }
    }
  }
  initializeLegacyOrigins(hadReceiptMarker=false){
    const key=`peLegacySnapshot:v1:${this.family}`;
      const db=this.store.db,families=['moss','qwen'],markers=new Map(families.map(f=>[f,db.prepare('SELECT value FROM meta WHERE key=?').get(`peLegacySnapshot:v1:${f}`)])),table=db.prepare("SELECT type FROM sqlite_master WHERE name='pe_legacy_origins'").get();
      if(hadReceiptMarker&&![...markers.values()].some(Boolean))throw new Error('PE legacy migration evidence is missing from an initialized database');
      for(const marker of markers.values())if(marker&&marker.value!=='done')throw new Error('PE legacy migration marker is invalid');
      if(!table){if([...markers.values()].some(Boolean))throw new Error('PE legacy snapshot table is missing after migration');db.exec('CREATE TABLE pe_legacy_origins(run_id TEXT PRIMARY KEY,family TEXT NOT NULL,session_id TEXT NOT NULL,production_id TEXT NOT NULL,request_id TEXT NOT NULL,payload_hash TEXT NOT NULL)');}
      else if(table.type!=='table')throw new Error('PE legacy snapshot is not a table');
      const columns=db.prepare('PRAGMA table_xinfo(pe_legacy_origins)').all(),names=['run_id','family','session_id','production_id','request_id','payload_hash'];
      if(columns.length!==names.length||columns.some((col,i)=>col.name!==names[i]||String(col.type).toUpperCase()!=='TEXT'||col.hidden!==0||col.pk!==(i===0?1:0)||col.notnull!==(i===0?0:1))||!hasBinaryPrimaryKey(db,'pe_legacy_origins',['run_id']))throw new Error('PE legacy snapshot schema is invalid');
      const rows=db.prepare('SELECT run_id,family,session_id,production_id,request_id,payload_hash FROM pe_legacy_origins ORDER BY run_id').all();
      for(const row of rows){
        if(!families.includes(row.family)||!markers.get(row.family)||typeof row.run_id!=='string'||typeof row.session_id!=='string'||!row.session_id||typeof row.production_id!=='string'||typeof row.request_id!=='string'||!/^[a-f0-9]{64}$/.test(row.payload_hash??''))throw new Error('PE legacy snapshot row is invalid');
        const view=Object.create(this);view.family=row.family;view.kind=`${row.family}-pe`;
        let evidence;try{evidence=view.verifyOriginInTransaction(row.run_id,row.session_id);}catch{throw new Error('PE legacy snapshot origin cannot be verified');}
        if(evidence.run.requestId!==row.request_id||evidence.production.id!==row.production_id||evidence.payloadHash!==row.payload_hash||db.prepare('SELECT 1 FROM pe_start_receipts WHERE session_id=? AND request_id=?').get(row.session_id,row.request_id))throw new Error('PE legacy snapshot origin differs from its saved evidence');
      }
      const manifest=f=>{const familyRows=rows.filter(row=>row.family===f);return JSON.stringify({count:familyRows.length,sha256:digest(familyRows)});};
      for(const f of families){const manifestKey=`peLegacyManifest:v1:${f}`,saved=db.prepare('SELECT value FROM meta WHERE key=?').get(manifestKey),marker=markers.get(f);
        if(saved&&(!marker||saved.value!==manifest(f)))throw new Error('PE legacy snapshot manifest differs');
        if(marker&&!saved)throw new Error('PE legacy snapshot manifest is missing after migration');
      }
      const marker=markers.get(this.family);if(marker)return;
      for(const row of this.store.db.prepare('SELECT id,json FROM runs').all()){
        let run;try{run=JSON.parse(row.json);}catch{continue;}
        if(run?.kind!==this.kind||typeof run.sessionId!=='string'||typeof run.requestId!=='string')continue;
        if(this.store.db.prepare('SELECT 1 FROM pe_start_receipts WHERE session_id=? AND request_id=?').get(run.sessionId,run.requestId))continue;
        let evidence;try{evidence=this.verifyOriginInTransaction(row.id,run.sessionId);}catch(error){if(error instanceof ApiError||error instanceof SyntaxError)continue;throw error;}
        this.store.db.prepare('INSERT INTO pe_legacy_origins VALUES(?,?,?,?,?,?)').run(row.id,this.family,run.sessionId,run.productionId,run.requestId,evidence.payloadHash);
      }
      this.store.db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(key,'done');
      const finalRows=db.prepare('SELECT run_id,family,session_id,production_id,request_id,payload_hash FROM pe_legacy_origins WHERE family=? ORDER BY run_id').all(this.family);
      db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(`peLegacyManifest:v1:${this.family}`,JSON.stringify({count:finalRows.length,sha256:digest(finalRows)}));
  }
  verifyReceiptOriginInTransaction(id,session){
    const evidence=this.verifyOriginInTransaction(id,session),{run,production,payloadHash}=evidence;
    const receipt=this.store.db.prepare('SELECT * FROM pe_start_receipts WHERE session_id=? AND request_id=?').get(session,run.requestId);
    if(receipt){const verified=this.findStartInTransaction(production.id,session,run.requestId);if(!verified||verified.run.id!==id)throw new ApiError(409,'Original PE receipt does not match');return evidence;}
    const legacy=this.store.db.prepare('SELECT * FROM pe_legacy_origins WHERE run_id=?').get(id);
    if(!legacy||legacy.family!==this.family||legacy.session_id!==session||legacy.production_id!==production.id||legacy.request_id!==run.requestId||legacy.payload_hash!==payloadHash)throw new ApiError(409,'PE run has no trusted start receipt or legacy origin');
    return evidence;
  }
  find(productionId,session,requestId){
    this.productions.get(productionId,session);
    if(typeof requestId!=='string'||!/^[-a-zA-Z0-9_]{16,100}$/.test(requestId))throw new ApiError(400,'Invalid PE request ID');
    const row=this.store.db.prepare('SELECT json FROM runs WHERE request_id=?').get(requestId);
    if(!row)throw new ApiError(404,'PE request not observed; absence does not prove rejection');
    const candidate=JSON.parse(row.json),run=this.get(candidate.id,session);
    if(run.productionId!==productionId)throw new ApiError(404,'PE request not owned by this production');
    return run;
  }
  findStartInTransaction(productionId,session,requestId){
    const run=this.find(productionId,session,requestId),p=this.productions.get(productionId,session),row=this.store.db.prepare('SELECT * FROM pe_start_receipts WHERE session_id=? AND request_id=?').get(session,requestId);
    if(run||row)this.productions.assertMutationNotRejected(session,'pe-start',requestId);
    // A pre-receipt PE remains readable by the existing API but cannot be
    // claimed as a receipt-bound operation after an uncertain send.
    if(!row)return null;
    const stored=this.store.db.prepare('SELECT request_id,payload_hash FROM runs WHERE id=?').get(run.id),origin=this.store.db.prepare('SELECT session_id,request_id,payload_hash FROM productions WHERE id=?').get(p.id);
    const created=this.store.db.prepare("SELECT seq,json FROM events WHERE run_id=? AND type='production_created'").all(p.id),runCreated=this.store.db.prepare("SELECT seq,json FROM events WHERE run_id=? AND type='created'").all(run.id),selected=this.store.db.prepare('SELECT run_id,type,json FROM events WHERE seq=?').get(row.production_event_seq),requested=this.store.db.prepare('SELECT seq,json FROM events WHERE run_id=? AND type=?').all(p.id,`${this.family}_pe_requested`);
    let creation,runData,eventData;try{if(created.length===1)creation=JSON.parse(created[0].json);if(runCreated.length===1)runData=JSON.parse(runCreated[0].json);eventData=JSON.parse(selected?.json);}catch{}
    const matchingRequested=requested.filter(item=>{try{return JSON.parse(item.json)?.runId===run.id;}catch{return false;}});
    if(row.run_id!==run.id||row.production_id!==p.id||row.family!==this.family||p.id!==productionId||p.sessionId!==session||origin?.session_id!==session||origin.request_id!==p.requestId||!p.brief||typeof p.brief!=='object'||Array.isArray(p.brief)||digest(p.brief)!==p.briefHash||origin.payload_hash!==p.briefHash||created.length!==1||creation?.briefHash!==p.briefHash||created[0].seq>=row.production_event_seq||
      run.id!==row.run_id||run.sessionId!==session||run.productionId!==productionId||run.kind!==this.kind||run.requestId!==requestId||!run.spec||typeof run.spec!=='object'||Array.isArray(run.spec)||run.spec.task!==this.kind||run.spec.productionId!==productionId||run.spec.briefHash!==p.briefHash||stored?.request_id!==requestId||stored.payload_hash!==digest(run.spec)||run.specHash!==stored.payload_hash||
      !Number.isSafeInteger(row.expected_revision)||row.expected_revision<0||row.production_revision!==row.expected_revision+1||run.productionRevision!==row.production_revision||!Number.isSafeInteger(p.revision)||p.revision<row.production_revision||!/^[a-f0-9]{64}$/.test(row.payload_hash??'')||!Array.isArray(p.promptEnhancements)||p.promptEnhancements.filter(x=>x===run.id).length!==1||
      !selected||selected.run_id!==p.id||selected.type!==`${this.family}_pe_requested`||matchingRequested.length!==1||matchingRequested[0].seq!==row.production_event_seq||eventData?.runId!==run.id||eventData?.revision!==row.production_revision||eventData?.reason!==run.spec.reason||typeof run.spec.prompt!=='string'||eventData?.originalPromptSha256!==sha256(run.spec.prompt)||runCreated.length!==1||runData?.specHash!==stored.payload_hash||runCreated[0].seq<=row.production_event_seq)throw new ApiError(409,'Saved PE start evidence differs; keep the request unresolved');
    const cancellationReceipt=p.revision!==row.production_revision?this.productions.cancellationAfterEventInTransaction(p,session,row.production_revision,row.production_event_seq):null;
    return {run,production:p,receipt:{requestId,sessionId:session,productionId,runId:run.id,family:this.family,payloadHash:row.payload_hash,expectedRevision:row.expected_revision,productionRevision:row.production_revision},...(cancellationReceipt?{cancellationReceipt}:{})};
  }
  findStartReceipt(productionId,session,requestId){
    this.store.db.exec('BEGIN');try{const result=this.findStartInTransaction(productionId,session,requestId);this.store.db.exec('COMMIT');return result;}catch(error){this.store.db.exec('ROLLBACK');throw error;}
  }
  create(productionId,session,input){
    validateSession(session);const p=this.productions.get(productionId,session);
    const mode=p.brief.mode??'t2i';
    if(!(this.family==='qwen'?QWEN21_OFFICIAL_IDS:MOSS_OFFICIAL_IDS).includes(p.brief.modelProfile)||!(this.family==='qwen'?['t2i','edit']:['t2i','layout']).includes(mode))throw new ApiError(400,'PE family and production mode do not match');
    const prompt=text(input?.prompt,6000,'prompt'),reason=text(input?.reason,2000,'reason');
    const seed=input?.seed??'42',inputAssetId=input?.inputAssetId??null;
    const thinking=input?.thinking??false,maxLength=input?.maxLength??4096;
    if(this.family==='qwen'&&(typeof thinking!=='boolean'||!Number.isSafeInteger(maxLength)||maxLength<1||maxLength>32768)||this.family==='moss'&&(input?.thinking!==undefined||input?.maxLength!==undefined))throw new ApiError(400,'Invalid PE thinking or token limit');
    const allowedIds=p.brief.inputAssetIds??(p.brief.inputAssetId?[p.brief.inputAssetId]:[]);
    const inputAssetIds=input?.inputAssetIds??[];
    if(this.family==='qwen'&&(!Array.isArray(inputAssetIds)||inputAssetId!==null||JSON.stringify(inputAssetIds)!==JSON.stringify(mode==='edit'?allowedIds:[])))throw new ApiError(400,'Qwen PE inputs must match the ordered production generator inputs');
    if(this.family==='qwen'&&inputAssetIds.length){
      if(!this.assets||typeof this.assets.get!=='function')throw new ApiError(409,'Owned Qwen PE image metadata unavailable');
      const selected=inputAssetIds.map(id=>this.assets.get(id,session));
      try{inputRgbaBytesFloor(selected);assertQwenPeInputDimensions(selected);}catch(error){throw new ApiError(400,errorText(error));}
    }
    if(this.family==='moss'&&input?.inputAssetIds!==undefined)throw new ApiError(400,'MOSS PE accepts one input image');
    if(this.family==='moss'&&inputAssetId!==((p.brief.peInputAssetIds??[])[0]??null))throw new ApiError(400,'PE image must match the explicitly designated PE-only input in this production');
    const normalized=normalizeRequest({requestId:input?.requestId,prompt,seed,modelProfile:p.brief.modelProfile});
    const spec={...normalized.spec,prompt,task:this.kind,productionId,briefHash:p.briefHash,reason,...(this.family==='qwen'?{inputAssetIds,peMode:mode,thinking,maxLength}:{inputAssetId})};
    const result=this.store.create({...normalized,spec},{beforeCreate:()=>this.productions.assertMutationNotRejected(session,'pe-start',normalized.requestId),decorate:run=>{
      const current=this.productions.get(productionId,session);this.productions.check(current,input.expectedRevision);
      if(current.briefHash!==p.briefHash)throw new ApiError(409,'Production brief changed');
      current.promptEnhancements??=[];current.promptEnhancements.push(run.id);current.revision++;
      this.productions.write(current,`${this.family}_pe_requested`,{runId:run.id,reason,originalPromptSha256:sha256(prompt)});
      const eventSeq=this.store.db.prepare('SELECT last_insert_rowid() AS value').get().value;
      this.store.db.prepare('INSERT INTO pe_start_receipts VALUES(?,?,?,?,?,?,?,?,?)').run(session,normalized.requestId,run.id,productionId,this.family,digest(input),input.expectedRevision,current.revision,eventSeq);
      this.updateReceiptManifest();
      return {kind:this.kind,productionId,sessionId:session,productionRevision:current.revision};
    }});
    try{
      if(result.run.kind!==this.kind||result.run.productionId!==productionId||result.run.sessionId!==session)throw new Error('Request ID belongs to another task');
      const receipt=this.findStartReceipt(productionId,session,normalized.requestId);
      if(receipt&&receipt.receipt.payloadHash!==digest(input))throw new Error('PE request ID is bound to different input');
      return {...result,production:this.productions.get(productionId,session),...(receipt?{receipt:receipt.receipt,...(receipt.cancellationReceipt?{cancellationReceipt:receipt.cancellationReceipt}:{})}:{})};
    }catch{
      // store.create may have committed before any following read or receipt
      // verification. Never label a post-commit failure a definite refusal.
      throw new ApiError(503,'PE start may already be recorded. Do not resend; inspect the original request and production.');
    }
  }
  launch(id,{recovery=false}={}){
    if(this.work.has(id))return;
    this.work.add(id);
    let execution;
    try{execution=this.execute(id,{recovery});}catch(error){execution=Promise.reject(error);}
    const work=Promise.resolve(execution).catch(async error=>{
      let run=this.store.get(id);if(!run||terminalPhases.has(run.phase))return;
      const gate=this.gate.status();
      if(!run.pePreSubmit&&!run[this.stateKey]&&gate.generationRunId!==id&&gate.blocked===false&&['core','none'].includes(gate.owner))return this.store.update(id,{phase:run.cancelRequested?'cancelled':'failed',error:run.cancelRequested?null:errorText(error)},`${this.family}_pe_preflight_failed`);
      if(!run[this.stateKey]&&run.pePreSubmit){
        try{return await this.recoverBeforeSubmission(id,errorText(error));}catch(cleanup){run=this.store.get(id);error=new Error(`${errorText(error)}; cleanup: ${errorText(cleanup)}`);}
      }
      if(run&&!terminalPhases.has(run.phase))this.store.update(id,{phase:'needs_attention',error:errorText(error)},`${this.family}_pe_unhandled`);
    }).finally(()=>this.work.delete(id));
    return work;
  }
  syncCancellation(id){
    const run=this.store.get(id);if(!run||run.kind!==this.kind)throw Error('PE run unavailable');
    const production=this.productions.get(run.productionId,run.sessionId);
    if(production.cancelRequested&&!run.cancelRequested&&!terminalPhases.has(run.phase))return this.store.cancel(id);
    return run;
  }
  assertNoSubmission(id){
    const run=this.syncCancellation(id),marker=run.pePreSubmit;
    if(!marker||marker.version!==1||marker.runId!==id||marker.family!==this.family||!run.serverEpoch||marker.serverEpochDigest!==digest(run.serverEpoch)||run[this.stateKey]||run.promptId||marker.submitted!==false)throw Error('Durable pre-submission evidence is incomplete');
    if(this.store.db.prepare('SELECT 1 FROM events WHERE run_id=? AND type=? LIMIT 1').get(id,`${this.family}_pe_submit_intent`))throw Error('A durable PE submission intent already exists');
    return run;
  }
  async recoverBeforeSubmission(id,reason='PE did not begin'){
    const run=this.assertNoSubmission(id),marker=run.pePreSubmit,gate=this.gate.status();
    // Stage submit intent and stage data are committed in the same SQLite
    // transaction. An intent event, even with a damaged stage record, forbids
    // treating this as a job that was never submitted.
    const eventType=`${this.family}_pe_submit_intent`;
    if(gate.initialized!==true||gate.generationRunId!==id||gate.blocked!==true||gate.activeCore!==0||!(gate.owner==='generator'||gate.owner==='none'&&marker.noneCleanupConfirmed===true))throw Error('Pre-submission GPU lease is not provably owned');
    const assertGeneratorIdle=async()=>{
      const fresh=this.store.get(id);if(!fresh||fresh[this.stateKey]||fresh.promptId||fresh.pePreSubmit?.submitted!==false||this.store.db.prepare('SELECT 1 FROM events WHERE run_id=? AND type=? LIMIT 1').get(id,eventType))throw Error('PE submission state changed during cleanup');
      await this.checkEpoch(fresh);
      const q=await this.adapter.request('/queue');
      if(!Array.isArray(q?.queue_running)||!Array.isArray(q?.queue_pending)||q.queue_running.length||q.queue_pending.length)throw Error('Comfy queue is not empty');
      await this.checkEpoch(this.store.get(id));
    };
    const coreBefore=await this.gate.state();if(coreBefore.loaded!==false||coreBefore.activity?.in_flight!==0)throw Error('Strata is not proven unloaded and idle');
    await assertGeneratorIdle();
    this.store.update(id,{pePreSubmit:{...marker,cleanupIntentAt:now(),cleanupReason:reason}},`${this.family}_pe_pre_submit_cleanup_intent`);
    const core=await this.gate.returnToCore(id,{assertGeneratorIdle,signalcleanup:AbortSignal.timeout(300000)});
    const final=this.syncCancellation(id);
    return this.store.update(id,{phase:final.cancelRequested?'cancelled':'failed',coreRestored:core,error:final.cancelRequested?null:reason,pePreSubmit:{...final.pePreSubmit,cleanupConfirmed:true,restoredAt:now()}},`${this.family}_pe_pre_submit_cleanup_confirmed`);
  }
  async execute(id,{recovery=false}={}){
    let run=this.syncCancellation(id);if(terminalPhases.has(run.phase))return;
    let stage;
    if(recovery){
      // A fresh process with an unknown gate owner does not establish lease
      // ownership. Only an already-owned generator lease can be reconciled.
      const ownership=this.gate.status();stage=run[this.stateKey];
      if(!stage&&run.pePreSubmit)return this.recoverBeforeSubmission(id,run.error??'PE did not begin');
      if(ownership.generationRunId!==id||ownership.owner!=='generator'||!stage||!['submitting','monitoring','submission_unknown','cancelling','result-saved','failed-terminal','cancelled-terminal','rejected'].includes(stage.phase))
        return this.store.update(id,{phase:'needs_attention',error:'PE recovery requires verified GPU ownership; no job was resent'},`${this.family}_pe_recovery_hold`);
      await this.checkEpoch(run);
    }else{
      if(run.cancelRequested)return this.store.update(id,{phase:'cancelled'},`${this.family}_pe_cancelled_before_start`);
      if(this.family==='qwen'&&await this.licenseCheck()!==true)throw Error('Qwen research license purpose is not confirmed');
      // Reject absent or changed private upstream data before any GPU handoff.
      // The graph builder verifies the same file again immediately before use.
      readExternalPrompt(this.family,this.family==='qwen'?run.spec.peMode:'t2i');
      let minimumResources=null,inputBufferFloorBytes=0;
      if(this.family==='qwen'&&run.spec.inputAssetIds?.length){
        if(!this.assets||typeof this.assets.get!=='function')throw Error('Qwen PE owned input metadata unavailable');
        const inputAssets=run.spec.inputAssetIds.map(assetId=>this.assets.get(assetId,run.sessionId));
        inputBufferFloorBytes=inputRgbaBytesFloor(inputAssets);
        assertQwenPeInputDimensions(inputAssets);
        const values=[this.gate.minFreeBytes,this.gate.minRamAvailableBytes,this.gate.minCommitAvailableBytes];
        if(values.some(n=>!Number.isSafeInteger(n)||n<0)||!Number.isSafeInteger(values[1]+inputBufferFloorBytes)||!Number.isSafeInteger(values[2]+inputBufferFloorBytes))throw Error('Qwen PE resource floor cannot be established');
        minimumResources={minFreeBytes:values[0],minRamAvailableBytes:values[1]+inputBufferFloorBytes,minCommitAvailableBytes:values[2]+inputBufferFloorBytes};
      }
      const epoch=await this.verifyEpoch();this.store.update(id,{phase:'preparing',serverEpoch:epoch,pePreSubmit:{version:1,runId:id,family:this.family,serverEpochDigest:digest(epoch),submitted:false},...(minimumResources?{peResourceRequirements:{...minimumResources,inputBufferFloorBytes,scope:'one RGBA input buffer only; not total peak or a guarantee'}}:{})},`${this.family}_pe_server_identity`);
      const cancel=new AbortController();
      const refresh=()=>{if(this.store.get(id)?.cancelRequested)cancel.abort(new Error('PE cancellation requested'));};
      const timer=setInterval(refresh,100);timer.unref?.();
      try{refresh();await this.gate.acquireGenerator(id,{signal:cancel.signal,...(minimumResources?{minimumResources}:{})});}
      catch(error){
        const state=this.gate.status(),latest=this.store.get(id);
        if(error instanceof GateError&&error.code==='GENERATOR_LEASE_BUSY'&&error.leaseNotAcquired===true&&state.initialized===true&&state.blocked===true&&typeof state.generationRunId==='string'&&state.generationRunId!==id&&['generator','enhancer','draining_core','restoring_core','none'].includes(state.owner)){
          // The gate proved this attempt was rejected under its mutex before
          // assignment. Only finish this run; do not free, cancel, restore or
          // otherwise modify the foreign owner's lease or jobs.
          const safe=this.assertNoSubmission(id);
          return this.store.update(id,{phase:safe.cancelRequested?'cancelled':'failed',error:safe.cancelRequested?null:'Another run owns the GPU; this PE was not submitted.',pePreSubmit:{...safe.pePreSubmit,leaseNotAcquired:true,rejectionCode:error.code,confirmedAt:now()}},`${this.family}_pe_lease_busy_not_acquired`);
        }
        if(latest.cancelRequested&&state.generationRunId!==id&&!state.blocked&&['core','none'].includes(state.owner))return this.store.update(id,{phase:'cancelled'},`${this.family}_pe_cancelled_before_lease`);
        if(state.generationRunId===id&&state.owner==='none'&&error.cleanupConfirmed===true)this.store.update(id,{pePreSubmit:{...latest.pePreSubmit,noneCleanupConfirmed:true}},`${this.family}_pe_handoff_cleanup_proven`);
        throw error;
      }finally{clearInterval(timer);}
      run=this.store.update(id,{phase:'enhancing'},`${this.family}_pe_lease_acquired`);
      if(run.cancelRequested)throw Error('PE stopped after GPU handoff; cleanup requires reconciliation');
      if(this.family==='qwen'&&await this.licenseCheck()!==true)throw Error('Qwen research license purpose is not confirmed');
      stage=await this.stage.start(id,{prompt:run.spec.prompt,seed:run.spec.seed,...(this.family==='qwen'?{inputAssetIds:run.spec.inputAssetIds,mode:run.spec.peMode,thinking:run.spec.thinking,maxLength:run.spec.maxLength}:{inputAssetId:run.spec.inputAssetId}),sessionId:run.sessionId});
    }
    const deadline=Date.now()+this.timeoutMs;
    while(!['result-saved','failed-terminal','cancelled-terminal','rejected'].includes(stage.phase)){
      if(Date.now()>=deadline)return this.store.update(id,{phase:'needs_attention',error:'PE outcome remains unknown; no retry or release'},`${this.family}_pe_timeout`);
      await sleep(this.pollIntervalMs);this.syncCancellation(id);stage=await this.stage.reconcile(id);
    }
    const terminal=stage.phase;
    stage=await this.stage.releaseAndRestore(id);
    if(stage.phase!=='core-restored')return this.store.update(id,{phase:'needs_attention',error:stage.error??'PE cleanup unresolved'},`${this.family}_pe_cleanup_unresolved`);
    const phase=terminal==='result-saved'?'completed':terminal==='cancelled-terminal'?'cancelled':'failed';
    return this.store.update(id,{phase,coreRestored:stage.core,error:phase==='failed'?(stage.error??'PE failed'):null},`${this.family}_pe_finished`);
  }
  cancel(id,session){const run=this.get(id,session);return this.store.cancel(run.id);}
  cancelProduction(production,session){
    validateSession(session);
    if(production.sessionId!==session||production.cancelRequested!==true)throw new ApiError(409,'Production cancellation is not confirmed');
    for(const id of production.promptEnhancements??[]){
      const candidate=this.store.get(id);if(!candidate||candidate.kind!==this.kind)continue;
      const run=this.get(id,session);
      if(run.productionId!==production.id)throw new ApiError(409,'PE run belongs to another production');
      if(!terminalPhases.has(run.phase)){
        this.store.cancel(id);
        if(!this.work.has(id))scheduleOwnedLaunch({store:this.store,run,launch:()=>this.launch(id,{recovery:true})});
      }
    }
  }
  /** Only an explicitly accepted result for the same unchanged production can
   * be linked to a workflow. Caller must provide the actual saved workflow,
   * not an agent-supplied hash. This check does not itself create a workflow. */
  assertWorkflowAdoption(id,session,productionId,workflow){
    const run=this.get(id,session),p=this.productions.get(productionId,session),result=run[this.stateKey]?.result,decision=run[this.decisionKey];
    if(run.productionId!==productionId||run.spec.briefHash!==p.briefHash||run.phase!=='completed'||run[this.stateKey]?.phase!=='core-restored'||decision?.decision!=='accept'||!result||typeof result.enhancedPrompt!=='string'||sha256(result.enhancedPrompt)!==result.enhancedPromptSha256)throw new ApiError(409,'No accepted PE result belongs to this unchanged production');
    if(!workflow||workflow.productionId!==productionId||workflow.modelProfile!==p.brief.modelProfile||workflow.mode!==(p.brief.mode??'t2i')||workflow.request?.prompt!==result.enhancedPrompt)throw new ApiError(409,'Workflow prompt does not exactly match the accepted PE result');
    const peInputAssets=result.inputAssets??(result.inputAsset?[result.inputAsset]:[]);
    return {family:this.family,peRunId:id,decisionId:decision.id,originalPromptSha256:result.originalPromptSha256,enhancedPromptSha256:result.enhancedPromptSha256,peInputAssets,briefHash:p.briefHash,workflowId:workflow.id,workflowSha256:workflow.sha256};
  }
  findDecisionInTransaction(id,session,requestId){
    if(typeof requestId!=='string'||!/^[-a-zA-Z0-9_]{16,100}$/.test(requestId))throw new ApiError(400,'Invalid PE decision request ID');
    const run=this.get(id,session),p=this.productions.get(run.productionId,session),row=this.store.db.prepare('SELECT * FROM pe_decision_receipts WHERE session_id=? AND request_id=?').get(session,requestId);
    if(row)this.productions.assertMutationNotRejected(session,'pe-decision',requestId);
    if(!row||row.run_id!==id||row.production_id!==p.id||row.family!==this.family)throw new ApiError(404,'PE decision receipt not found; absence does not prove rejection');
    const source=this.verifyReceiptOriginInTransaction(id,session);
    const stored=this.store.db.prepare('SELECT request_id,payload_hash,json FROM runs WHERE id=?').get(id),origin=this.store.db.prepare('SELECT session_id,request_id,payload_hash FROM productions WHERE id=?').get(p.id);
    const created=this.store.db.prepare("SELECT seq,json FROM events WHERE run_id=? AND type='production_created'").all(p.id);
    const runEvent=this.store.db.prepare('SELECT run_id,type,json FROM events WHERE seq=?').get(row.run_event_seq),productionEvent=this.store.db.prepare('SELECT run_id,type,json FROM events WHERE seq=?').get(row.production_event_seq);
    let creation,runData,productionData;try{if(created.length===1)creation=JSON.parse(created[0].json);runData=JSON.parse(runEvent?.json);productionData=JSON.parse(productionEvent?.json);}catch{}
    const decision=run[this.decisionKey],result=run[this.stateKey]?.result;
    if(!p.brief||typeof p.brief!=='object'||Array.isArray(p.brief)||!run.spec||typeof run.spec!=='object'||Array.isArray(run.spec))throw new ApiError(409,'Saved PE decision evidence is incomplete');
    let reqs;try{reqs=requirements(p,run);}catch{throw new ApiError(409,'Saved PE requirements are invalid');}
    if(p.id!==run.productionId||p.sessionId!==session||origin?.session_id!==session||origin.request_id!==p.requestId||origin.payload_hash!==p.briefHash||digest(p.brief)!==p.briefHash||created.length!==1||creation?.briefHash!==p.briefHash||created[0].seq>=row.production_event_seq||
      !Array.isArray(p.promptEnhancements)||p.promptEnhancements.filter(x=>x===id).length!==1||run.kind!==this.kind||run.id!==id||run.sessionId!==session||stored?.request_id!==run.requestId||stored.payload_hash!==digest(run.spec)||run.specHash!==digest(run.spec)||run.spec.briefHash!==p.briefHash||run.phase!=='completed'||run[this.stateKey]?.phase!=='core-restored'||!result||typeof result.originalPrompt!=='string'||typeof result.enhancedPrompt!=='string'||sha256(result.originalPrompt)!==result.originalPromptSha256||sha256(result.enhancedPrompt)!==result.enhancedPromptSha256||
      !Number.isSafeInteger(row.expected_revision)||row.expected_revision<0||row.production_revision!==row.expected_revision+1||!Number.isSafeInteger(p.revision)||p.revision<row.production_revision||!/^[a-f0-9]{64}$/.test(row.payload_hash??'')||!/^[a-f0-9]{64}$/.test(row.decision_hash??'')||!decision||decision.originalPromptSha256!==result.originalPromptSha256||decision.enhancedPromptSha256!==result.enhancedPromptSha256||!Array.isArray(decision.checks)||decision.checks.length!==reqs.length||decision.checks.some((x,i)=>x.kind!==reqs[i].kind||x.requirement!==reqs[i].requirement)||digest(decision)!==row.decision_hash||
      !runEvent||runEvent.run_id!==id||runEvent.type!==`${this.family}_pe_decided`||!runData?.[this.decisionKey]||digest(runData[this.decisionKey])!==row.decision_hash||!productionEvent||productionEvent.run_id!==p.id||productionEvent.type!==`${this.family}_pe_decided`||productionData?.runId!==id||productionData?.revision!==row.production_revision||!productionData?.decision||digest(productionData.decision)!==row.decision_hash||source.runCreatedSeq>=row.run_event_seq||row.run_event_seq>=row.production_event_seq)throw new ApiError(409,'Saved PE decision evidence differs; keep the request unresolved');
    const cancellationReceipt=p.revision!==row.production_revision?this.productions.cancellationAfterEventInTransaction(p,session,row.production_revision,row.production_event_seq):null;
    return {run,production:p,receipt:{requestId,sessionId:session,productionId:p.id,runId:id,family:this.family,payloadHash:row.payload_hash,expectedRevision:row.expected_revision,productionRevision:row.production_revision,decisionId:decision.id,decisionHash:row.decision_hash},...(cancellationReceipt?{cancellationReceipt}:{})};
  }
  findDecision(id,session,requestId){
    this.store.db.exec('BEGIN');try{const result=this.findDecisionInTransaction(id,session,requestId);this.store.db.exec('COMMIT');return result;}catch(error){this.store.db.exec('ROLLBACK');throw error;}
  }
  findReconcileInTransaction(id,session,requestId){
    if(typeof requestId!=='string'||!/^[-a-zA-Z0-9_]{16,100}$/.test(requestId))throw new ApiError(400,'Invalid PE reconciliation request ID');
    const run=this.get(id,session),p=this.productions.get(run.productionId,session),row=this.store.db.prepare('SELECT * FROM pe_reconcile_receipts WHERE session_id=? AND request_id=?').get(session,requestId);
    if(row)this.productions.assertMutationNotRejected(session,'pe-reconcile',requestId);
    if(!row||row.run_id!==id||row.production_id!==p.id||row.family!==this.family)throw new ApiError(404,'PE reconciliation receipt not found; absence does not prove rejection');
    const source=this.verifyReceiptOriginInTransaction(id,session);
    const stored=this.store.db.prepare('SELECT request_id,payload_hash FROM runs WHERE id=?').get(id),origin=this.store.db.prepare('SELECT session_id,request_id,payload_hash FROM productions WHERE id=?').get(p.id),created=this.store.db.prepare("SELECT json FROM events WHERE run_id=? AND type='production_created'").all(p.id),ev=this.store.db.prepare('SELECT run_id,type,json FROM events WHERE seq=?').get(row.event_seq);
    let receipt,event,originEvent;try{receipt=JSON.parse(row.receipt_json);event=JSON.parse(ev?.json);if(created.length===1)originEvent=JSON.parse(created[0].json);}catch{}
    if(!p.brief||!run.spec||p.id!==run.productionId||p.sessionId!==session||origin?.session_id!==session||origin.request_id!==p.requestId||origin.payload_hash!==p.briefHash||digest(p.brief)!==p.briefHash||created.length!==1||originEvent?.briefHash!==p.briefHash||run.id!==id||run.sessionId!==session||run.kind!==this.kind||stored?.request_id!==run.requestId||stored.payload_hash!==digest(run.spec)||run.specHash!==stored.payload_hash||run.spec.briefHash!==p.briefHash||!Array.isArray(p.promptEnhancements)||p.promptEnhancements.filter(x=>x===id).length!==1||
      !receipt||receipt.requestId!==requestId||receipt.sessionId!==session||receipt.runId!==id||receipt.productionId!==p.id||receipt.family!==this.family||receipt.operation!=='reconcile'||receipt.payloadHash!==row.payload_hash||typeof receipt.acceptedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(receipt.acceptedAt)||!Number.isFinite(Date.parse(receipt.acceptedAt))||new Date(receipt.acceptedAt).toISOString()!==receipt.acceptedAt||!/^[a-f0-9]{64}$/.test(row.payload_hash??'')||!Number.isSafeInteger(row.event_seq)||row.event_seq<=source.runCreatedSeq||digest(receipt)!==row.receipt_hash||!ev||ev.run_id!==id||ev.type!==`${this.family}_pe_reconcile_requested`||!event?.receipt||digest(event.receipt)!==row.receipt_hash)throw new ApiError(409,'Saved PE reconciliation evidence differs; keep the request unresolved');
    return {run,production:p,receipt,guidance:'This receipt confirms only that reconciliation was accepted. Observe the owned run and resources separately; no resubmission or cleanup is implied.'};
  }
  findReconcile(id,session,requestId){
    this.store.db.exec('BEGIN');try{const result=this.findReconcileInTransaction(id,session,requestId);this.store.db.exec('COMMIT');return result;}catch(error){this.store.db.exec('ROLLBACK');throw error;}
  }
  acceptReconcile(id,session,input){
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).join(',')!=='requestId'||typeof input.requestId!=='string'||!/^[-a-zA-Z0-9_]{16,100}$/.test(input.requestId))throw new ApiError(400,'A PE reconciliation request ID is required');
    return this.store.transaction(()=>{
      this.productions.assertMutationNotRejected(session,'pe-reconcile',input.requestId);
      const old=this.store.db.prepare('SELECT * FROM pe_reconcile_receipts WHERE session_id=? AND request_id=?').get(session,input.requestId);
      if(old){if(old.run_id!==id||old.family!==this.family||old.payload_hash!==digest(input))throw new ApiError(409,'PE reconciliation request is bound to different input');return {...this.findReconcileInTransaction(id,session,input.requestId),created:false};}
      const run=this.get(id,session),p=this.productions.get(run.productionId,session);
      const receipt={requestId:input.requestId,sessionId:session,runId:id,productionId:p.id,family:this.family,operation:'reconcile',payloadHash:digest(input),acceptedAt:now()};
      this.store.event(id,`${this.family}_pe_reconcile_requested`,{receipt});const eventSeq=this.store.db.prepare('SELECT last_insert_rowid() AS value').get().value;
      this.store.db.prepare('INSERT INTO pe_reconcile_receipts VALUES(?,?,?,?,?,?,?,?,?)').run(session,input.requestId,id,p.id,this.family,receipt.payloadHash,digest(receipt),eventSeq,JSON.stringify(receipt));
      this.updateReceiptManifest();
      return {...this.findReconcileInTransaction(id,session,input.requestId),created:true};
    });
  }
  decide(id,session,input){
    const reason=text(input?.reason,3000,'decision reason');
    if(!['accept','reject'].includes(input?.decision)||!Array.isArray(input?.invariants))throw new ApiError(400,'Decision and invariant checks are required');
    const requestId=input?.requestId??null;
    if(requestId!==null&&(typeof requestId!=='string'||!/^[-a-zA-Z0-9_]{16,100}$/.test(requestId)))throw new ApiError(400,'Invalid PE decision request ID');
    return this.store.transaction(()=>{
      if(requestId!==null)this.productions.assertMutationNotRejected(session,'pe-decision',requestId);
      if(requestId!==null){const old=this.store.db.prepare('SELECT * FROM pe_decision_receipts WHERE session_id=? AND request_id=?').get(session,requestId);if(old){if(old.run_id!==id||old.family!==this.family||old.payload_hash!==digest(input))throw new ApiError(409,'PE decision request ID is bound to another operation or input');return {...this.findDecisionInTransaction(id,session,requestId),created:false};}}
      const run=this.get(id,session),p=this.productions.get(run.productionId,session);this.productions.check(p,input.expectedRevision);
      if(run.phase!=='completed'||run[this.stateKey]?.phase!=='core-restored'||!run[this.stateKey].result||run.spec.briefHash!==p.briefHash||run[this.decisionKey])throw new ApiError(409,'PE result cannot be decided for this production');
      const result=run[this.stateKey].result;
      if(typeof result.originalPrompt!=='string'||typeof result.enhancedPrompt!=='string'||sha256(result.originalPrompt)!==result.originalPromptSha256||sha256(result.enhancedPrompt)!==result.enhancedPromptSha256)throw new ApiError(409,'Stored PE text differs from its recorded hashes');
      if(input.originalPromptSha256!==result.originalPromptSha256||input.enhancedPromptSha256!==result.enhancedPromptSha256)throw new ApiError(409,'PE prompt hashes differ');
      const required=requirements(p,run);
      if(input.invariants.length!==required.length)throw new ApiError(400,'Every invariant requires a recorded judgement');
      const checks=input.invariants.map((item,i)=>{
        if(item?.kind!==required[i].kind||item?.requirement!==required[i].requirement||!['met','unmet','unverified'].includes(item.status))throw new ApiError(400,'Requirement order or judgement differs from the production brief');
        return {...required[i],status:item.status,evidence:text(item.evidence,2000,'requirement evidence')};
      });
      if(input.decision==='accept'&&checks.some(x=>x.status!=='met'))throw new ApiError(409,'Unmet or unverified invariants cannot be accepted');
      const decision={id:randomUUID(),decision:input.decision,reason,checks,originalPromptSha256:result.originalPromptSha256,enhancedPromptSha256:result.enhancedPromptSha256,completionReason:result.completionReason,at:now()};
      // Already inside a RunStore transaction: update directly instead of
      // starting a nested transaction through store.update().
      run[this.decisionKey]=decision;run.updatedAt=now();
      this.store.db.prepare('UPDATE runs SET phase=?,json=? WHERE id=?').run(run.phase,JSON.stringify(run),id);
      this.store.event(id,`${this.family}_pe_decided`,{[this.decisionKey]:decision});
      const runEventSeq=this.store.db.prepare('SELECT last_insert_rowid() AS value').get().value;
      p.revision++;this.productions.write(p,`${this.family}_pe_decided`,{runId:id,decision});
      if(requestId===null)return {run:this.get(id,session),production:p};
      const productionEventSeq=this.store.db.prepare('SELECT last_insert_rowid() AS value').get().value;
      this.store.db.prepare('INSERT INTO pe_decision_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(session,requestId,id,p.id,this.family,digest(input),input.expectedRevision,p.revision,digest(decision),runEventSeq,productionEventSeq);
      this.updateReceiptManifest();
      return {...this.findDecisionInTransaction(id,session,requestId),created:true};
    });
  }
}
