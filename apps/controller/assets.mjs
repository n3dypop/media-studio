import {randomUUID,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {lstat,mkdir,open,readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ApiError} from './store.mjs';
import {workflowGraphHash} from './workflows.mjs';
import {hasBinaryPrimaryKey,ensureCoreTables} from './schema-integrity.mjs';

const executeFile=promisify(execFile),UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const normalizerExited=Symbol('normalizer-exited'),importRejected=Symbol('asset-import-rejected');
export const ASSET_LIMITS=Object.freeze({maxUploadBytes:10*1024**2,maxBodyBytes:14*1024**2,maxCanonicalBytes:48*1024**2,maxDimension:4096,maxPixels:12_000_000});
const session=value=>{if(typeof value!=='string'||!value.trim()||value.length>160)throw new ApiError(400,'DSH sessionが不正です。');return value.trim();};
const purpose=value=>{if(!['reference','input'].includes(value))throw new ApiError(400,'画像の用途をreferenceまたはinputで指定してください。');return value;};
const exactKeys=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
// Historical t2i records preceded assetSessionId. Support only the observed
// schema-1/2 layouts, not a generic missing-owner fallback for newer runs.
function legacyManagedT2i(run,production,workflow){
  const spec=run?.spec,brief=production?.brief;
  if(Object.hasOwn(run??{},'effectiveSpec')||!exactKeys(workflow,['schemaVersion','id','productionId','createdAt','rationale','modelProfile','graph','sha256','nodeCount','roles','output','validation']))return false;
  const base=['briefHash','enhancer','height','invariants','negativePrompt','prompt','seed','steps','width','workflow'];
  const missingQwen=workflow.schemaVersion===1&&workflow.modelProfile==='qwen-photo-v1'&&exactKeys(spec,base)&&exactKeys(brief,['criteria','invariants','request']);
  const moss=[1,2].includes(workflow.schemaVersion)&&workflow.modelProfile==='moss-image-sft-int8-v1'&&exactKeys(spec,[...base,'modelProfile'])&&exactKeys(brief,['criteria','invariants','modelProfile','request'])&&spec.modelProfile===workflow.modelProfile&&brief.modelProfile===workflow.modelProfile;
  return (missingQwen||moss)&&Array.isArray(spec.invariants)&&Array.isArray(brief.invariants)&&JSON.stringify(spec.invariants)===JSON.stringify(brief.invariants);
}
export async function assetDirectory(directory) {
  const absolute=path.resolve(directory),parsed=path.parse(absolute);let cursor=parsed.root;
  for(const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor=path.join(cursor,part);let stat;
    try{stat=await lstat(cursor);}catch(error){if(error.code!=='ENOENT')throw error;try{await mkdir(cursor);}catch(e){if(e.code!=='EEXIST')throw e;}stat=await lstat(cursor);}
    if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Asset directory contains a link or non-directory');
  }
  if((await realpath(absolute)).toLowerCase()!==absolute.toLowerCase())throw new Error('Asset directory resolves outside the configured location');
  return absolute;
}
// Reading a receipt must never create an absent asset directory.
async function existingAssetDirectory(directory) {
  const absolute=path.resolve(directory),parsed=path.parse(absolute);let cursor=parsed.root;
  for(const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)){
    cursor=path.join(cursor,part);const info=await lstat(cursor);
    if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Asset directory contains a link or non-directory');
  }
  if((await realpath(absolute)).toLowerCase()!==absolute.toLowerCase())throw new Error('Asset directory resolves outside the configured location');
  return absolute;
}
async function writeOnce(filename,bytes) {
  const handle=await open(filename,'wx',0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
}
async function checkedBytes(filename,expectedSha256,limit=ASSET_LIMITS.maxCanonicalBytes) {
  const stat=await lstat(filename);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>limit)throw new Error('Asset file is unsafe or oversized');
  const bytes=await readFile(filename);if(sha256(bytes)!==expectedSha256)throw new Error('Immutable asset content changed');return bytes;
}
export class AssetStore {
  constructor({store,root,inputRoot,pythonExecutable,normalize=null}) {
    Object.assign(this,{store,root:path.resolve(root),inputRoot:path.resolve(inputRoot),pythonExecutable});
    this.directory=path.join(this.root,'data','assets');
    this.normalize=normalize??(async(source,destination)=>{
      const script=fileURLToPath(new URL('./asset-image.py',import.meta.url));
      let stdout;try{({stdout}=await executeFile(pythonExecutable,['-I','-B',script,source,destination],{windowsHide:true,timeout:30000,maxBuffer:32768,env:{...process.env,PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1'}}));}
      catch(error){if(Number.isInteger(error?.code)&&error.code!==0&&error.signal===null&&error.killed===false){const ended=new Error('Image normalizer exited without producing a usable image');ended[normalizerExited]=true;throw ended;}throw error;}
      return JSON.parse(stdout.trim());
    });
    this.initializeImportLedger();
  }
  importManifest(){const db=this.store.db,data={};for(const table of ['asset_import_receipts','asset_import_abandons'])data[table]=db.prepare(`SELECT * FROM ${table} ORDER BY session_id,request_id`).all();return JSON.stringify({sha256:sha256(Buffer.from(JSON.stringify(data))),counts:Object.fromEntries(Object.entries(data).map(([key,rows])=>[key,rows.length]))});}
  initializeImportLedger(){
    const db=this.store.db;this.store.transaction(()=>{
      ensureCoreTables(db,{marker:'assetCoreSchema:v1',legacyMarkers:['assetImportSchema:v1'],tables:[
        {name:'assets',create:'CREATE TABLE assets(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,json TEXT NOT NULL)',columns:[['id','TEXT',0,1],['session_id','TEXT',1,0],['json','TEXT',1,0]],primary:['id']},
      ]});
      const marker=db.prepare("SELECT value FROM meta WHERE key='assetImportSchema:v1'").get(),saved=db.prepare("SELECT value FROM meta WHERE key='assetImportManifest:v1'").get();
      if(marker&&marker.value!=='done'||marker&&!saved||saved&&!marker)throw Error('Asset import marker or manifest is invalid');
      const specs={asset_import_receipts:'session_id TEXT NOT NULL,request_id TEXT NOT NULL,payload_hash TEXT NOT NULL,asset_id TEXT NOT NULL,original_hash TEXT NOT NULL,state TEXT NOT NULL,canonical_hash TEXT,metadata_hash TEXT,PRIMARY KEY(session_id,request_id)',asset_import_abandons:'session_id TEXT NOT NULL,request_id TEXT NOT NULL,payload_hash TEXT NOT NULL,asset_id TEXT NOT NULL,original_hash TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(session_id,request_id)'};
      for(const [table,definition] of Object.entries(specs)){
        const found=db.prepare("SELECT type FROM sqlite_master WHERE name=?").get(table);if(!found){if(marker)throw Error('Asset import receipt table is missing after migration');db.exec(`CREATE TABLE ${table}(${definition})`);}else if(found.type!=='table')throw Error('Asset import storage is not a table');
        const expected=definition.split(',PRIMARY KEY(')[0].split(',').map(part=>part.trim().split(/\s+/)),columns=db.prepare(`PRAGMA table_xinfo(${table})`).all();
        if(columns.length!==expected.length||columns.some((c,i)=>c.name!==expected[i][0]||String(c.type).toUpperCase()!==expected[i][1]||c.notnull!==(expected[i].includes('NOT')?1:0)||c.hidden!==0||c.pk!==(i===0?1:i===1?2:0))||!hasBinaryPrimaryKey(db,table,['session_id','request_id']))throw Error('Asset import schema is invalid');
      }
      const index=db.prepare("SELECT type,sql FROM sqlite_master WHERE name='asset_import_open_session'").get();
      if(!index){if(marker)throw Error('Asset import unique index is missing after migration');db.exec("CREATE UNIQUE INDEX asset_import_open_session ON asset_import_receipts(session_id) WHERE state='started'");}
      else if(index.type!=='index'||typeof index.sql!=='string'||index.sql.replace(/\s+/g,'').toLowerCase()!=="createuniqueindexasset_import_open_sessiononasset_import_receipts(session_id)wherestate='started'")throw Error('Asset import unique index differs');
      const indexInfo=db.prepare('PRAGMA index_list(asset_import_receipts)').all().find(item=>item.name==='asset_import_open_session'),keys=db.prepare('PRAGMA index_xinfo(asset_import_open_session)').all().filter(item=>item.key===1);
      if(!indexInfo||indexInfo.unique!==1||indexInfo.partial!==1||keys.length!==1||keys[0].name!=='session_id'||keys[0].coll!=='BINARY'||keys[0].desc!==0)throw Error('Asset import unique index is invalid');
      const actual=this.importManifest();if(saved&&saved.value!==actual)throw Error('Asset import manifest differs');
      for(const row of db.prepare('SELECT * FROM asset_import_receipts').all()){
        const abandon=db.prepare('SELECT * FROM asset_import_abandons WHERE session_id=? AND request_id=?').get(row.session_id,row.request_id),asset=db.prepare('SELECT session_id,json FROM assets WHERE id=?').get(row.asset_id);let value;try{value=JSON.parse(asset?.json);}catch{}
        if(!UUID.test(row.asset_id??'')||!/^[a-f0-9]{64}$/.test(row.payload_hash??'')||!/^[a-f0-9]{64}$/.test(row.original_hash??'')||!['started','committed','rejected','abandoned'].includes(row.state)||(row.state==='abandoned')!==Boolean(abandon)||(abandon&&(abandon.asset_id!==row.asset_id||abandon.payload_hash!==row.payload_hash||abandon.original_hash!==row.original_hash))||(row.state==='committed'?(!asset||asset.session_id!==row.session_id||!value||value.id!==row.asset_id||value.originalSha256!==row.original_hash||value.sha256!==row.canonical_hash||sha256(Buffer.from(JSON.stringify(value)))!==row.metadata_hash):Boolean(asset)||row.canonical_hash!==null||row.metadata_hash!==null))throw Error('Asset import receipt evidence differs');
        if(abandon){const events=db.prepare("SELECT json FROM events WHERE run_id=? AND type='asset_import_abandoned'").all(row.asset_id);let data;try{if(events.length===1)data=JSON.parse(events[0].json);}catch{}if(events.length!==1||data?.sessionId!==row.session_id||data?.requestId!==row.request_id||data?.payloadHash!==row.payload_hash||data?.originalSha256!==row.original_hash)throw Error('Asset abandonment receipt audit differs');}
      }
      for(const row of db.prepare('SELECT * FROM asset_import_abandons').all())if(!db.prepare('SELECT 1 FROM asset_import_receipts WHERE session_id=? AND request_id=?').get(row.session_id,row.request_id))throw Error('Asset abandonment receipt origin is missing');
      for(const event of db.prepare("SELECT run_id,json FROM events WHERE type='asset_import_abandoned'").all()){let data;try{data=JSON.parse(event.json);}catch{}const row=data&&db.prepare('SELECT * FROM asset_import_abandons WHERE session_id=? AND request_id=?').get(data.sessionId,data.requestId);if(!row||row.asset_id!==event.run_id||row.payload_hash!==data.payloadHash||row.original_hash!==data.originalSha256)throw Error('Asset abandonment audit has no matching receipt');}
      if(!marker)db.prepare("INSERT INTO meta(key,value) VALUES('assetImportSchema:v1','done')").run();if(!saved)db.prepare("INSERT INTO meta(key,value) VALUES('assetImportManifest:v1',?)").run(actual);
    });
  }
  updateImportManifest(){const result=this.store.db.prepare("UPDATE meta SET value=? WHERE key='assetImportManifest:v1'").run(this.importManifest());if(result.changes!==1)throw Error('Asset import manifest is missing');}
  get(id,owner) {
    session(owner);if(!UUID.test(id??''))throw new ApiError(404,'この会話の画像がありません。');
    const row=this.store.db.prepare('SELECT session_id,json FROM assets WHERE id=?').get(id);
    if(!row||row.session_id!==owner)throw new ApiError(404,'この会話の画像がありません。');return JSON.parse(row.json);
  }
  assertNoImportRejection(owner,requestId){
    const table=this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='production_mutation_rejections'").get();
    if(table&&this.store.db.prepare("SELECT 1 FROM production_mutation_rejections WHERE session_id=? AND scope='asset-import' AND request_id=?").get(owner,requestId))throw new ApiError(409,'画像要求は受付前に拒否されています。');
  }
  list(owner){session(owner);return this.store.db.prepare('SELECT json FROM assets WHERE session_id=? ORDER BY rowid DESC LIMIT 100').all(owner).map(row=>JSON.parse(row.json));}
  assertDirectRunEvidence(row,run,runId){
    // A missing productionId alone is not evidence of a standalone run: a
    // damaged managed run must not silently lose its production ownership.
    const spec=run?.spec,effective=Object.hasOwn(run??{},'effectiveSpec')?run.effectiveSpec:spec;
    if(!spec||typeof spec!=='object'||Array.isArray(spec)||!effective||typeof effective!=='object'||Array.isArray(effective)||typeof run.requestId!=='string'||run.requestId!==row.request_id||!UUID.test(run.controllerId??'')||sha256(Buffer.from(JSON.stringify(spec)))!==row.payload_hash||sha256(Buffer.from(JSON.stringify(effective)))!==run.specHash||['productionRevision','attempt','kind','feedbackId','resourceRetryOf'].some(key=>Object.hasOwn(run,key))||[spec,effective].some(value=>['workflow','briefHash','assetSessionId','referenceAssets','inputAsset','inputAssets','invariants','task','productionId'].some(key=>Object.hasOwn(value,key))))throw new ApiError(409,'生成が独立した旧runであることを確認できません。');
    const created=this.store.db.prepare("SELECT json FROM events WHERE run_id=? AND type='created'").all(runId);
    let creation;try{if(created.length===1)creation=JSON.parse(created[0].json);}catch{}
    if(created.length!==1||creation?.specHash!==row.payload_hash)throw new ApiError(409,'独立runの作成証拠が一致しません。');
    // Check all sessions: an inconsistent or foreign production must not be
    // ignored merely because the requested source session does not own it.
    const rows=this.store.db.prepare('SELECT id,session_id,json FROM productions').all();
    for(const item of rows){
      let p;try{p=JSON.parse(item.json);}catch{}
      if(!p||p.id!==item.id||p.sessionId!==item.session_id||!Array.isArray(p.attempts)||(p.promptEnhancements!==undefined&&!Array.isArray(p.promptEnhancements)))throw new ApiError(409,'制作台帳を確認できません。');
      if(p.attempts.includes(runId)||(Array.isArray(p.promptEnhancements)&&p.promptEnhancements.includes(runId)))throw new ApiError(409,'制作に関連するrunを独立runとして扱えません。');
    }
    const events=this.store.db.prepare("SELECT json FROM events WHERE type IN ('render_requested','moss_pe_requested','qwen_pe_requested')").all();
    for(const item of events){let event;try{event=JSON.parse(item.json);}catch{}if(!event||typeof event!=='object'||Array.isArray(event)||!UUID.test(event.runId??''))throw new ApiError(409,'制作監査を確認できません。');if(event.runId===runId)throw new ApiError(409,'制作監査に関連するrunを独立runとして扱えません。');}
  }
  assertManagedRunEvidence(row,run,runId,production,productionId,owner){
    const spec=run?.spec,effective=Object.hasOwn(run??{},'effectiveSpec')?run.effectiveSpec:spec,workflow=spec?.workflow;
    const legacy=legacyManagedT2i(run,production,workflow),ownerBound=spec?.assetSessionId===owner&&effective?.assetSessionId===owner;
    const profileBound=legacy||(typeof production.brief?.modelProfile==='string'&&workflow?.modelProfile===production.brief.modelProfile&&spec?.modelProfile===production.brief.modelProfile);
    if(!spec||typeof spec!=='object'||Array.isArray(spec)||!effective||typeof effective!=='object'||Array.isArray(effective)||typeof run.requestId!=='string'||run.requestId!==row.request_id||!UUID.test(run.controllerId??'')||sha256(Buffer.from(JSON.stringify(spec)))!==row.payload_hash||sha256(Buffer.from(JSON.stringify(effective)))!==run.specHash||!production.brief||typeof production.brief!=='object'||Array.isArray(production.brief)||sha256(Buffer.from(JSON.stringify(production.brief)))!==production.briefHash||spec.briefHash!==production.briefHash||effective.briefHash!==production.briefHash||(!ownerBound&&!legacy)||!profileBound||!workflow||typeof workflow!=='object'||workflow.productionId!==productionId||!UUID.test(workflow.id??'')||!workflow.graph||!/^[a-f0-9]{64}$/.test(workflow.sha256??''))throw new ApiError(409,'参照元の制作・生成条件が一致しません。');
    try{if(workflowGraphHash(workflow.graph)!==workflow.sha256)throw Error('Workflow hash differs');}catch{throw new ApiError(409,'参照元workflowを確認できません。');}
    const {prompt:unusedPrompt,negativePrompt:unusedNegative,...originalFixed}=spec,{prompt:unusedEffectivePrompt,negativePrompt:unusedEffectiveNegative,...effectiveFixed}=effective;
    if(JSON.stringify(originalFixed)!==JSON.stringify(effectiveFixed))throw new ApiError(409,'参照元の実効生成条件が一致しません。');
    const position=production.attempts.indexOf(runId);
    if(!Number.isSafeInteger(run.productionRevision)||run.productionRevision<1||!Number.isSafeInteger(production.revision)||production.revision<run.productionRevision||!Number.isSafeInteger(run.attempt)||run.attempt!==position+1||production.attempts.filter(id=>id===runId).length!==1)throw new ApiError(409,'参照元の生成順序が一致しません。');
    const created=this.store.db.prepare("SELECT json FROM events WHERE run_id=? AND type='created'").all(runId);let creation;try{if(created.length===1)creation=JSON.parse(created[0].json);}catch{}
    if(created.length!==1||creation?.specHash!==row.payload_hash)throw new ApiError(409,'参照元の生成受付を確認できません。');
    const rows=this.store.db.prepare("SELECT json FROM events WHERE run_id=? AND type='render_requested'").all(productionId),matched=[];
    for(const item of rows){let event;try{event=JSON.parse(item.json);}catch{}if(!event||typeof event!=='object'||Array.isArray(event)||!UUID.test(event.runId??''))throw new ApiError(409,'制作監査を確認できません。');if(event.runId===runId)matched.push(event);}
    if(matched.length!==1||matched[0].revision!==run.productionRevision||matched[0].attempt!==run.attempt)throw new ApiError(409,'参照元の制作監査が一致しません。');
  }
  sourceRunEvidence(runId,owner,artifactSha256){
    if(!UUID.test(runId??'')||!/^[a-f0-9]{64}$/.test(artifactSha256??''))throw new ApiError(409,'参照元の生成情報が不正です。');
    const row=this.store.db.prepare('SELECT request_id,payload_hash,phase,json FROM runs WHERE id=?').get(runId);let run;try{run=JSON.parse(row?.json);}catch{}
    if(!row||!run||run.id!==runId||run.sessionId!==owner||row.phase!==run.phase)throw new ApiError(404,'この会話の生成画像がありません。');
    const artifacts=Array.isArray(run.artifacts)?run.artifacts.filter(item=>item?.sha256===artifactSha256&&item.mime==='image/png'):[];
    if(artifacts.length!==1)throw new ApiError(409,'参照元の成果物を一意に確認できません。');
    const artifact=artifacts[0],name=artifact.name;
    if(typeof name!=='string'||!name||name.length>255||name==='.'||name==='..'||/[\\/:\u0000-\u001f]/.test(name)||path.basename(name)!==name||typeof artifact.path!=='string'||!path.isAbsolute(artifact.path))throw new ApiError(409,'参照元の成果物パスが不正です。');
    const directory=path.resolve(this.root,'outputs',runId),expected=path.resolve(directory,name),actual=path.resolve(artifact.path);
    const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
    if(!same(path.dirname(expected),directory)||!same(actual,expected))throw new ApiError(409,'参照元の成果物パスが保存場所と一致しません。');
    const productionId=run.productionId??null;
    if(productionId!==null){
      if(!UUID.test(productionId))throw new ApiError(409,'参照元の制作情報が不正です。');
      const pRow=this.store.db.prepare('SELECT session_id,request_id,payload_hash,json FROM productions WHERE id=?').get(productionId);let p;try{p=JSON.parse(pRow?.json);}catch{}
      if(!pRow||pRow.session_id!==owner||!p||p.id!==productionId||p.sessionId!==owner||typeof p.requestId!=='string'||p.requestId!==pRow.request_id||p.briefHash!==pRow.payload_hash||!Array.isArray(p.attempts)||p.attempts.filter(id=>id===runId).length!==1)throw new ApiError(409,'参照元の制作と生成の所有情報が一致しません。');
      const created=this.store.db.prepare("SELECT json FROM events WHERE run_id=? AND type='production_created'").all(productionId);let creation;try{if(created.length===1)creation=JSON.parse(created[0].json);}catch{}
      if(created.length!==1||creation?.briefHash!==pRow.payload_hash)throw new ApiError(409,'参照元の制作受付を確認できません。');
      this.assertManagedRunEvidence(row,run,runId,p,productionId,owner);
    }else this.assertDirectRunEvidence(row,run,runId);
    const binding={runId,sessionId:owner,productionId,artifactSha256,name,path:expected};
    return {path:expected,productionId,identityHash:sha256(Buffer.from(JSON.stringify(binding)))};
  }
  async add(owner,input) {return (await this.addWithReceipt(owner,input)).asset;}
  async addWithReceipt(owner,input) {
    owner=session(owner);purpose(input?.purpose);let bytes,provenance=null,mime=input.mime,sourcePath=null,sourceEvidence=null,originalHash;
    const explicitRequestId=input?.requestId!==undefined,requestId=explicitRequestId?input.requestId:randomUUID();
    if(typeof requestId!=='string'||!/^[-a-zA-Z0-9_]{16,100}$/.test(requestId))throw new ApiError(400,'画像の要求IDが不正です。');
    const payloadHash=sha256(Buffer.from(JSON.stringify(input)));
    if(explicitRequestId)this.assertNoImportRejection(owner,requestId);
    if(explicitRequestId){
      const previous=this.store.db.prepare('SELECT * FROM asset_import_receipts WHERE session_id=? AND request_id=?').get(owner,requestId);
      if(previous){
        if(previous.payload_hash!==payloadHash)throw new ApiError(409,'同じ画像要求IDの内容を変更できません。');
        if(previous.state==='rejected')throw new ApiError(400,'この画像要求は登録されず終了しています。');
        if(previous.state!=='committed')throw new ApiError(503,'画像の登録結果は未確認です。再送せず同じ要求IDを照合してください。');
        return {...await this.findImportByRequest(owner,requestId),created:false};
      }
    }
    if(input.sourceRunId!==undefined) {
      if(input.dataBase64!==undefined||!UUID.test(input.sourceRunId)||!/^[a-f0-9]{64}$/.test(input.artifactSha256??''))throw new ApiError(400,'生成画像の指定が不正です。');
      sourceEvidence=this.sourceRunEvidence(input.sourceRunId,owner,input.artifactSha256);
      sourcePath=sourceEvidence.path;originalHash=input.artifactSha256;mime='image/png';
      provenance={runId:input.sourceRunId,productionId:sourceEvidence.productionId,artifactSha256:originalHash};
    } else {
      if(typeof input.dataBase64!=='string'||input.dataBase64.length>Math.ceil(ASSET_LIMITS.maxUploadBytes/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.dataBase64))throw new ApiError(400,'画像bytesが不正または大きすぎます。');
      bytes=Buffer.from(input.dataBase64,'base64');
      if(bytes.toString('base64')!==input.dataBase64)throw new ApiError(400,'画像base64が正規形ではありません。');
    }
    if((bytes&&(!bytes.length||bytes.length>ASSET_LIMITS.maxUploadBytes))||!['image/png','image/jpeg','image/webp'].includes(mime))throw new ApiError(400,'PNG/JPEG/WebP画像を10MiB以内で指定してください。');
    if(bytes)originalHash=sha256(bytes);
    const id=randomUUID();
    {
      const admitted=this.store.transaction(()=>{
        this.assertNoImportRejection(owner,requestId);
        const previous=this.store.db.prepare('SELECT * FROM asset_import_receipts WHERE session_id=? AND request_id=?').get(owner,requestId);
        if(previous){if(previous.payload_hash!==payloadHash)throw new ApiError(409,'同じ画像要求IDの内容を変更できません。');if(previous.state==='rejected')throw new ApiError(400,'この画像要求は登録されず終了しています。');if(previous.state!=='committed')throw new ApiError(503,'画像の登録結果は未確認です。再送せず同じ要求IDを照合してください。');return false;}
        if(this.store.db.prepare("SELECT request_id FROM asset_import_receipts WHERE session_id=? AND state='started' LIMIT 1").get(owner))throw new ApiError(503,'この会話に未確認の画像登録があります。新しい登録は保留してください。');
        this.store.db.prepare("INSERT INTO asset_import_receipts(session_id,request_id,payload_hash,asset_id,original_hash,state) VALUES(?,?,?,?,?,'started')").run(owner,requestId,payloadHash,id,originalHash);
        this.updateImportManifest();
        return true;
      });
      if(!admitted)return {...await this.findImportByRequest(owner,requestId),created:false};
    }
    try{
      if(sourcePath){await existingAssetDirectory(path.dirname(sourcePath));bytes=await checkedBytes(sourcePath,originalHash,ASSET_LIMITS.maxUploadBytes);if(!bytes.length)throw Error('Source image is empty');}
      const directory=await assetDirectory(path.join(this.directory,id));
      await writeOnce(path.join(directory,'original.bin'),bytes);
      const canonical=path.join(directory,'image.png');
      let dimensions;try{dimensions=await this.normalize(path.join(directory,'original.bin'),canonical);}catch(error){if(error?.[normalizerExited])this.rejectImport(owner,requestId,payloadHash,id,originalHash);throw error;}
      if(!dimensions||dimensions.originalMime!==mime||dimensions.mime!=='image/png'||![dimensions.width,dimensions.height].every(n=>Number.isInteger(n)&&n>=16&&n<=4096)||dimensions.width*dimensions.height>ASSET_LIMITS.maxPixels)this.rejectImport(owner,requestId,payloadHash,id,originalHash);
      const stat=await lstat(canonical);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>ASSET_LIMITS.maxCanonicalBytes)throw new ApiError(400,'変換後の画像が大きすぎます。');
      const png=await readFile(canonical);
      const asset={id,purpose:input.purpose,mime:'image/png',originalMime:mime,sha256:sha256(png),originalSha256:originalHash,bytes:png.length,originalBytes:bytes.length,width:dimensions.width,height:dimensions.height,filename:typeof input.filename==='string'?input.filename.replace(/[\u0000-\u001f]/g,'').slice(0,160):'image',createdAt:new Date().toISOString(),provenance};
      const metadataHash=sha256(Buffer.from(JSON.stringify(asset)));
      if(sourceEvidence){await existingAssetDirectory(path.dirname(sourcePath));await checkedBytes(sourcePath,originalHash,ASSET_LIMITS.maxUploadBytes);}
      this.store.transaction(()=>{
        if(sourceEvidence&&this.sourceRunEvidence(provenance.runId,owner,originalHash).identityHash!==sourceEvidence.identityHash)throw new Error('Source run identity changed');
        this.store.db.prepare('INSERT INTO assets VALUES(?,?,?)').run(id,owner,JSON.stringify(asset));
        const update=this.store.db.prepare("UPDATE asset_import_receipts SET state='committed',canonical_hash=?,metadata_hash=? WHERE session_id=? AND request_id=? AND payload_hash=? AND asset_id=? AND original_hash=? AND state='started'").run(asset.sha256,metadataHash,owner,requestId,payloadHash,id,originalHash);
        if(update.changes!==1)throw new Error('Asset import admission changed');
        this.updateImportManifest();
      });
      return explicitRequestId?{asset,receipt:{requestId,sessionId:owner,payloadHash,assetId:id,originalSha256:originalHash,canonicalSha256:asset.sha256,metadataHash,state:'committed'},created:true}:{asset};
    }catch(error){
      if(error?.[importRejected])throw error;
      throw new ApiError(503,`画像の登録結果は未確認です。再送せず同じ要求IDを照合してください。要求ID: ${requestId}`);
    }
  }
  rejectImport(owner,requestId,payloadHash,id,originalHash){
    this.store.transaction(()=>{
      if(this.store.db.prepare('SELECT id FROM assets WHERE id=?').get(id))throw new Error('An asset row already exists');
      const update=this.store.db.prepare("UPDATE asset_import_receipts SET state='rejected' WHERE session_id=? AND request_id=? AND payload_hash=? AND asset_id=? AND original_hash=? AND state='started' AND canonical_hash IS NULL AND metadata_hash IS NULL").run(owner,requestId,payloadHash,id,originalHash);
      if(update.changes!==1)throw new Error('Asset import admission changed');
      this.updateImportManifest();
    });
    const error=new ApiError(400,`画像の登録は完了せず終了しました。要求ID: ${requestId}`);error[importRejected]=true;throw error;
  }
  abandonImport(owner,input){
    owner=session(owner);
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='assetId,originalSha256,payloadHash,requestId'||typeof input.requestId!=='string'||!/^[-a-zA-Z0-9_]{16,100}$/.test(input.requestId)||!UUID.test(input.assetId??'')||!/^[a-f0-9]{64}$/.test(input.payloadHash??'')||!/^[a-f0-9]{64}$/.test(input.originalSha256??''))throw new ApiError(400,'受付ID、画像IDと確認したhashを指定してください。');
    return this.store.transaction(()=>{
      const row=this.store.db.prepare('SELECT * FROM asset_import_receipts WHERE session_id=? AND request_id=?').get(owner,input.requestId);
      if(!row||row.asset_id!==input.assetId||row.payload_hash!==input.payloadHash||row.original_hash!==input.originalSha256)throw new ApiError(409,'画像受付の所有情報または確認内容が一致しません。');
      const old=this.store.db.prepare('SELECT * FROM asset_import_abandons WHERE session_id=? AND request_id=?').get(owner,input.requestId);
      if(row.state==='abandoned'){
        if(!old||old.asset_id!==input.assetId||old.payload_hash!==input.payloadHash||old.original_hash!==input.originalSha256)throw new ApiError(409,'保存済みの復旧記録が一致しません。');
        return {receipt:{requestId:input.requestId,sessionId:owner,payloadHash:input.payloadHash,assetId:input.assetId,originalSha256:input.originalSha256,state:'abandoned',createdAt:old.created_at},created:false};
      }
      if(row.state!=='started'||old||row.canonical_hash!==null||row.metadata_hash!==null||this.store.db.prepare('SELECT id FROM assets WHERE id=?').get(input.assetId))throw new ApiError(409,'画像受付の状態が変わっています。再読取して確認してください。');
      const updated=this.store.db.prepare("UPDATE asset_import_receipts SET state='abandoned' WHERE session_id=? AND request_id=? AND payload_hash=? AND asset_id=? AND original_hash=? AND state='started' AND canonical_hash IS NULL AND metadata_hash IS NULL").run(owner,input.requestId,input.payloadHash,input.assetId,input.originalSha256);
      if(updated.changes!==1)throw new ApiError(409,'画像受付が変更されました。');
      const createdAt=new Date().toISOString();
      this.store.db.prepare('INSERT INTO asset_import_abandons VALUES(?,?,?,?,?,?)').run(owner,input.requestId,input.payloadHash,input.assetId,input.originalSha256,createdAt);
      this.store.event(input.assetId,'asset_import_abandoned',{requestId:input.requestId,payloadHash:input.payloadHash,sessionId:owner,originalSha256:input.originalSha256});
      this.updateImportManifest();
      return {receipt:{requestId:input.requestId,sessionId:owner,payloadHash:input.payloadHash,assetId:input.assetId,originalSha256:input.originalSha256,state:'abandoned',createdAt},created:true};
    });
  }
  async findImportByRequest(owner,requestId){
    session(owner);if(typeof requestId!=='string'||!/^[-a-zA-Z0-9_]{16,100}$/.test(requestId))throw new ApiError(400,'画像の要求IDが不正です。');
    const snapshot=this.store.transaction(()=>{
      const row=this.store.db.prepare('SELECT * FROM asset_import_receipts WHERE session_id=? AND request_id=?').get(owner,requestId);
      if(!row)throw new ApiError(404,'画像要求を確認できません。未観測は未実行の証明ではありません。');
      this.assertNoImportRejection(owner,requestId);
      if(row.session_id!==owner||!UUID.test(row.asset_id??'')||!/^[a-f0-9]{64}$/.test(row.payload_hash??'')||!/^[a-f0-9]{64}$/.test(row.original_hash??'')||!['started','committed','rejected','abandoned'].includes(row.state))throw new ApiError(409,'画像受付を照合できません。');
      const abandon=this.store.db.prepare('SELECT * FROM asset_import_abandons WHERE session_id=? AND request_id=?').get(owner,requestId);
      if((row.state==='abandoned'&&(!abandon||abandon.asset_id!==row.asset_id||abandon.payload_hash!==row.payload_hash||abandon.original_hash!==row.original_hash||typeof abandon.created_at!=='string'))||(row.state!=='abandoned'&&abandon))throw new ApiError(409,'画像復旧記録を照合できません。');
      if(row.state==='started'||row.state==='rejected'||row.state==='abandoned'){
        if(row.canonical_hash!==null||row.metadata_hash!==null||this.store.db.prepare('SELECT id FROM assets WHERE id=?').get(row.asset_id))throw new ApiError(409,'画像受付の状態が矛盾しています。');
        return {row,abandon};
      }
      const stored=this.store.db.prepare('SELECT session_id,json FROM assets WHERE id=?').get(row.asset_id);let asset;try{asset=JSON.parse(stored?.json);}catch{}
      if(!stored||stored.session_id!==owner||!asset||asset.id!==row.asset_id||asset.originalSha256!==row.original_hash||asset.sha256!==row.canonical_hash||!/^[a-f0-9]{64}$/.test(row.canonical_hash??'')||!/^[a-f0-9]{64}$/.test(row.metadata_hash??'')||sha256(Buffer.from(JSON.stringify(asset)))!==row.metadata_hash||!Number.isSafeInteger(asset.bytes)||!Number.isSafeInteger(asset.originalBytes))throw new ApiError(409,'保存済み画像と受付が一致しません。');
      let source=null;
      if(asset.provenance!==null){
        if(!asset.provenance||typeof asset.provenance!=='object'||Array.isArray(asset.provenance)||!Object.hasOwn(asset.provenance,'productionId')||asset.provenance.artifactSha256!==asset.originalSha256)throw new ApiError(409,'参照元の記録が不完全です。');
        source=this.sourceRunEvidence(asset.provenance.runId,owner,asset.provenance.artifactSha256);
        if(source.productionId!==asset.provenance.productionId)throw new ApiError(409,'参照元の制作が変更されています。');
      }
      return {row,asset,source};
    });
    const row=snapshot.row,receipt={requestId,sessionId:owner,payloadHash:row.payload_hash,assetId:row.asset_id,originalSha256:row.original_hash,state:row.state};
    if(row.state==='started'||row.state==='rejected'||row.state==='abandoned')return {receipt:{...receipt,...(snapshot.abandon?{createdAt:snapshot.abandon.created_at}:{})}};
    try{
      const directory=await existingAssetDirectory(path.join(this.directory,row.asset_id));
      const original=await checkedBytes(path.join(directory,'original.bin'),row.original_hash,ASSET_LIMITS.maxUploadBytes),png=await checkedBytes(path.join(directory,'image.png'),row.canonical_hash);
      if(original.length!==snapshot.asset.originalBytes||png.length!==snapshot.asset.bytes)throw Error('Asset length differs');
      if(snapshot.source){await existingAssetDirectory(path.dirname(snapshot.source.path));await checkedBytes(snapshot.source.path,row.original_hash,ASSET_LIMITS.maxUploadBytes);}
    }catch{throw new ApiError(409,'画像ファイルの完全性を確認できません。結果を保留してください。');}
    if(snapshot.source){
      const now=this.store.transaction(()=>this.sourceRunEvidence(snapshot.asset.provenance.runId,owner,row.original_hash));
      if(now.identityHash!==snapshot.source.identityHash)throw new ApiError(409,'参照元の所有情報が変更されています。結果を保留してください。');
    }
    return {asset:snapshot.asset,receipt:{...receipt,canonicalSha256:row.canonical_hash,metadataHash:row.metadata_hash}};
  }
  async content(id,owner){const asset=this.get(id,owner);await assetDirectory(path.join(this.directory,id));return {asset,bytes:await checkedBytes(path.join(this.directory,id,'image.png'),asset.sha256)};}
  async binding(id,owner,requiredPurpose) {
    const {asset,bytes}=await this.content(id,owner);if(asset.purpose!==requiredPurpose)throw new ApiError(409,'画像の登録用途が制作での用途と一致しません。');
    if(requiredPurpose==='reference')return {id:asset.id,purpose:asset.purpose,sha256:asset.sha256,width:asset.width,height:asset.height};
    const subfolder=`controller-assets/${sha256(Buffer.from(owner)).slice(0,24)}`,filename=`${asset.id}-${asset.sha256}.png`;
    const directory=await assetDirectory(path.join(this.inputRoot,...subfolder.split('/'))),target=path.join(directory,filename);
    try{await writeOnce(target,bytes);}catch(error){if(error.code!=='EEXIST')throw error;await checkedBytes(target,asset.sha256);}
    return {id:asset.id,purpose:'input',sha256:asset.sha256,width:asset.width,height:asset.height,comfyInputName:`${subfolder}/${filename}`};
  }
  async verifyBinding(binding,owner) {
    const actual=await this.binding(binding.id,owner,binding.purpose);
    if(JSON.stringify(actual)!==JSON.stringify(binding))throw new Error('Stored asset binding differs from immutable asset');return actual;
  }
}

export async function assetRoute({req,res,path:route,role,assets,productions,body,json}) {
  if(!route.startsWith('/api/assets'))return false;
  if(!assets)throw new ApiError(503,'画像入力の準備ができていません。');
  const owner=session(req.headers['x-dsh-session']);
  if(route==='/api/assets'&&req.method==='POST'){
    const input=await body(req,ASSET_LIMITS.maxBodyBytes);
    if(input?.requestId===undefined){const asset=await assets.add(owner,input);json(res,201,{asset});return true;}
    let result;try{result=await assets.addWithReceipt(owner,input);}catch(error){
      if(role!=='dsh'||!productions||typeof input?.requestId!=='string'||!/^[-a-zA-Z0-9_]{16,100}$/.test(input.requestId)||!Number.isInteger(error?.status)||error.status<400||error.status>499)throw error;
      let receipt;try{receipt=productions.rejectUnadmittedMutation(owner,'asset-import',null,input,error.status);}catch{throw new ApiError(503,'画像の受付状態を確認できません。再送せず照合してください。');}
      json(res,receipt.httpStatus,{error:'画像は受付前に拒否されました。',receipt});return true;
    }
    json(res,result.created?201:200,result);return true;
  }
  if(route==='/api/assets'&&req.method==='GET'){json(res,200,{assets:assets.list(owner),limits:ASSET_LIMITS});return true;}
  if(route==='/api/assets/recovery'&&req.method==='POST'){
    if(role!=='admin')throw new ApiError(403,'画像受付の復旧は保守担当のみ実行できます。');
    json(res,200,assets.abandonImport(owner,await body(req)));return true;
  }
  if(route==='/api/assets/by-request'&&req.method==='GET'){
    const url=new URL(req.url,'http://127.0.0.1');
    if([...url.searchParams.keys()].some(key=>key!=='requestId')||url.searchParams.getAll('requestId').length!==1)throw new ApiError(400,'画像要求IDを一つ指定してください。');
    json(res,200,await assets.findImportByRequest(owner,url.searchParams.get('requestId')));return true;
  }
  const match=route.match(/^\/api\/assets\/([a-f0-9-]{36})(\/content)?$/);
  if(match&&req.method==='GET'){
    if(!match[2])json(res,200,{asset:assets.get(match[1],owner)});
    else {const {bytes}=await assets.content(match[1],owner);res.writeHead(200,{'Content-Type':'image/png','Content-Length':bytes.length});res.end(bytes);}return true;
  }
  throw new ApiError(404,'画像入力APIがありません。');
}
