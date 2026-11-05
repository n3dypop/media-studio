import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm,unlink} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {RunStore,digest,normalizeRequest} from '../apps/controller/store.mjs';
import {ProductionStore} from '../apps/controller/productions.mjs';
import {AssetStore} from '../apps/controller/assets.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const gate=()=>{let release;const promise=new Promise(r=>{release=r;});return {promise,release};};
async function fixture(t,{normalize}={}){
  const base=join(tmpdir(),'asset-provenance-review');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'case-'));
  const store=new RunStore(join(root,'db.sqlite')),productions=new ProductionStore(store),assets=new AssetStore({store,root,inputRoot:join(root,'input'),normalize:normalize??(async(src,dst)=>{await writeFile(dst,await readFile(src));return {originalMime:'image/png',mime:'image/png',width:32,height:32};})});
  t.after(async()=>{store.close();assert.ok(resolve(root).startsWith(resolve(base)+sep));await rm(root,{recursive:true,force:true});});
  const p=productions.create('owner',{requestId:randomUUID(),brief:{request:'portrait',modelProfile:'qwen-photo-v1',mode:'t2i',criteria:[{id:'C1',description:'portrait'}],invariants:[]}}).production;
  const graph={'1':{class_type:'Fixture',inputs:{}}},workflow={id:randomUUID(),productionId:p.id,modelProfile:'qwen-photo-v1',graph,sha256:digest(graph),rationale:'fixture'},ready=productions.bindWorkflow(p.id,'owner',0,workflow);
  const rendered=productions.render(p.id,'owner',{requestId:randomUUID(),expectedRevision:ready.revision,prompt:'portrait',negativePrompt:'',seed:'42',width:512,height:768,steps:25,enhancer:false},workflow);
  const runId=rendered.run.id,output=join(root,'outputs',runId),file=join(output,'source.png'),bytes=Buffer.from('isolated-source-image');await mkdir(output,{recursive:true});await writeFile(file,bytes);
  store.update(runId,{phase:'completed',artifacts:[{path:file,name:'source.png',mime:'image/png',sha256:hash(bytes)}]});
  return {root,store,productions,assets,p,runId,file,input:{requestId:randomUUID(),purpose:'input',sourceRunId:runId,artifactSha256:hash(bytes)}};
}
function modifyRun(f,fn){const run=f.store.get(f.runId);fn(run);f.store.db.prepare('UPDATE runs SET json=? WHERE id=?').run(JSON.stringify(run),f.runId);}
function modifyProduction(f,fn){const p=f.productions.get(f.p.id,'owner');fn(p);f.store.db.prepare('UPDATE productions SET json=? WHERE id=?').run(JSON.stringify(p),f.p.id);}
const refused=e=>e.status===404||e.status===409;
function historicalManagedT2i(f,kind){
  const p=f.productions.get(f.p.id,'owner'),run=f.store.get(f.runId),old=run.spec,profile=kind==='qwen'?'qwen-photo-v1':'moss-image-sft-int8-v1',schema=kind==='moss2'?2:1;
  p.brief={request:p.brief.request,criteria:p.brief.criteria,invariants:p.brief.invariants,...(kind==='qwen'?{}:{modelProfile:profile})};p.briefHash=digest(p.brief);
  const workflow={schemaVersion:schema,id:old.workflow.id,productionId:p.id,createdAt:'2026-11-02T00:00:00.000Z',rationale:'fixture',modelProfile:profile,graph:old.workflow.graph,sha256:old.workflow.sha256,nodeCount:1,roles:{},output:{width:512,height:768},validation:{kind:'static'}};
  run.spec={prompt:old.prompt,negativePrompt:old.negativePrompt,seed:old.seed,width:old.width,height:old.height,steps:old.steps,...(kind==='qwen'?{}:{modelProfile:profile}),workflow,enhancer:false,invariants:p.brief.invariants,briefHash:p.briefHash};
  return {p,run};
}
function saveHistorical(f,p,run){
  p.briefHash=digest(p.brief);run.spec.briefHash=p.briefHash;run.specHash=digest(run.spec);
  f.store.db.prepare('UPDATE productions SET payload_hash=?,json=? WHERE id=?').run(p.briefHash,JSON.stringify(p),f.p.id);
  f.store.db.prepare("UPDATE events SET json=? WHERE run_id=? AND type='production_created'").run(JSON.stringify({briefHash:p.briefHash}),f.p.id);
  f.store.db.prepare('UPDATE runs SET payload_hash=?,json=? WHERE id=?').run(run.specHash,JSON.stringify(run),f.runId);
  f.store.db.prepare("UPDATE events SET json=? WHERE run_id=? AND type='created'").run(JSON.stringify({phase:'queued',specHash:run.specHash}),f.runId);
}

test('owned source run, production and source bytes are linked into a committed asset',async t=>{
  const f=await fixture(t),saved=await f.assets.addWithReceipt('owner',f.input);
  assert.deepEqual(saved.asset.provenance,{runId:f.runId,productionId:f.p.id,artifactSha256:f.input.artifactSha256});
  const observed=await f.assets.findImportByRequest('owner',f.input.requestId);assert.equal(observed.asset.id,saved.asset.id);
});

for(const kind of ['qwen','moss1','moss2'])test(`historical ${kind} t2i without assetSessionId reuses the owned source`,async t=>{
  const f=await fixture(t),{p,run}=historicalManagedT2i(f,kind);saveHistorical(f,p,run);
  const result=await f.assets.addWithReceipt('owner',f.input);assert.equal(result.receipt.state,'committed');
  assert.equal((await f.assets.findImportByRequest('owner',f.input.requestId)).asset.id,result.asset.id);
});

for(const [label,alter] of [
  ['newer workflow schema',(_p,r)=>{r.spec.workflow.schemaVersion=4;}],
  ['modern-only generator inputs',(_p,r)=>{r.spec.inputAssetId=null;}],
  ['one-sided profile',(_p,r)=>{r.spec.modelProfile='qwen-photo-v1';}],
  ['wrong fallback workflow profile',(_p,r)=>{r.spec.workflow.modelProfile='moss-image-sft-int8-v1';}],
  ['unrecognised legacy brief option',(p)=>{p.brief.usage='unverified';}],
  ['changed invariants',(_p,r)=>{r.spec.invariants=['unrecorded'];}],
])test(`historical compatibility rejects ${label}`,async t=>{
  const f=await fixture(t),{p,run}=historicalManagedT2i(f,'qwen');alter(p,run);saveHistorical(f,p,run);
  await assert.rejects(f.assets.addWithReceipt('owner',f.input),e=>e.status===409);
});

test('an owned older direct run without production remains reusable',async t=>{
  const f=await fixture(t),run=f.store.create(normalizeRequest({requestId:randomUUID(),prompt:'legacy portrait',modelProfile:'qwen-photo-v1',width:512,height:768,steps:25}),{decorate:()=>({sessionId:'owner'})}).run;
  const dir=join(f.root,'outputs',run.id),file=join(dir,'legacy.png'),bytes=Buffer.from('isolated-source-image');await mkdir(dir,{recursive:true});await writeFile(file,bytes);
  f.store.update(run.id,{phase:'completed',artifacts:[{path:file,name:'legacy.png',mime:'image/png',sha256:hash(bytes)}]});
  const input={requestId:randomUUID(),purpose:'input',sourceRunId:run.id,artifactSha256:hash(bytes)},saved=await f.assets.addWithReceipt('owner',input);
  assert.equal(saved.asset.provenance.productionId,null);
  assert.equal((await f.assets.findImportByRequest('owner',input.requestId)).asset.id,saved.asset.id);
  assert.deepEqual((await f.assets.content(saved.asset.id,'owner')).bytes,Buffer.from('isolated-source-image'));
});

test('standalone source cannot be reclassified as a managed run by adding a production ID and attempt',async t=>{
  const f=await fixture(t),run=f.store.create(normalizeRequest({requestId:randomUUID(),prompt:'legacy portrait',modelProfile:'qwen-photo-v1',width:512,height:768,steps:25}),{decorate:()=>({sessionId:'owner'})}).run;
  const dir=join(f.root,'outputs',run.id),file=join(dir,'legacy.png'),bytes=Buffer.from('isolated-source-image');await mkdir(dir,{recursive:true});await writeFile(file,bytes);
  f.store.update(run.id,{phase:'completed',productionId:f.p.id,productionRevision:2,attempt:2,artifacts:[{path:file,name:'legacy.png',mime:'image/png',sha256:hash(bytes)}]});
  modifyProduction(f,p=>{p.attempts.push(run.id);});
  await assert.rejects(f.assets.addWithReceipt('owner',{requestId:randomUUID(),purpose:'input',sourceRunId:run.id,artifactSha256:hash(bytes)}),e=>e.status===409);
});

test('even forged workflow and spec cannot replace the managed render-request audit',async t=>{
  const f=await fixture(t),run=f.store.create(normalizeRequest({requestId:randomUUID(),prompt:'legacy portrait',modelProfile:'qwen-photo-v1',width:512,height:768,steps:25}),{decorate:()=>({sessionId:'owner'})}).run;
  const dir=join(f.root,'outputs',run.id),file=join(dir,'legacy.png'),bytes=Buffer.from('isolated-source-image');await mkdir(dir,{recursive:true});await writeFile(file,bytes);
  const production=f.productions.get(f.p.id,'owner'),managed=f.store.get(f.runId);
  Object.assign(run,{phase:'completed',productionId:f.p.id,productionRevision:production.revision+1,attempt:2,artifacts:[{path:file,name:'legacy.png',mime:'image/png',sha256:hash(bytes)}]});
  Object.assign(run.spec,{workflow:managed.spec.workflow,briefHash:production.briefHash,assetSessionId:'owner'});run.specHash=digest(run.spec);
  f.store.db.prepare('UPDATE runs SET phase=?,payload_hash=?,json=? WHERE id=?').run(run.phase,run.specHash,JSON.stringify(run),run.id);
  f.store.db.prepare("UPDATE events SET json=? WHERE run_id=? AND type='created'").run(JSON.stringify({phase:'queued',specHash:run.specHash}),run.id);
  modifyProduction(f,p=>{p.attempts.push(run.id);p.revision++;});
  await assert.rejects(f.assets.addWithReceipt('owner',{requestId:randomUUID(),purpose:'input',sourceRunId:run.id,artifactSha256:hash(bytes)}),e=>e.status===409);
});

test('managed source receipt rejects changed render-request audit',async t=>{
  const f=await fixture(t);await f.assets.addWithReceipt('owner',f.input);
  const event=f.store.db.prepare("SELECT seq,json FROM events WHERE run_id=? AND type='render_requested'").get(f.p.id),data=JSON.parse(event.json);data.attempt++;
  f.store.db.prepare('UPDATE events SET json=? WHERE seq=?').run(JSON.stringify(data),event.seq);
  await assert.rejects(f.assets.findImportByRequest('owner',f.input.requestId),e=>e.status===409);
});

test('managed run cannot be downgraded to a direct run by removing its production ID',async t=>{
  const f=await fixture(t);modifyRun(f,run=>{delete run.productionId;});modifyProduction(f,p=>{p.sessionId='foreign';});
  await assert.rejects(f.assets.addWithReceipt('owner',f.input),e=>e.status===409);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM asset_import_receipts').get().n,0);
});

function forgeDirectShape(f){
  const run=f.store.get(f.runId);delete run.productionId;delete run.productionRevision;delete run.attempt;delete run.feedbackId;delete run.resourceRetryOf;
  run.spec=normalizeRequest({requestId:run.requestId,prompt:'forged',modelProfile:'qwen-photo-v1',width:512,height:768,steps:25}).spec;run.specHash=digest(run.spec);
  f.store.db.prepare('UPDATE runs SET payload_hash=?,json=? WHERE id=?').run(run.specHash,JSON.stringify(run),run.id);
  f.store.db.prepare("UPDATE events SET json=? WHERE run_id=? AND type='created'").run(JSON.stringify({phase:'queued',specHash:run.specHash}),run.id);
}

test('production attempts independently prevent forged direct metadata',async t=>{
  const f=await fixture(t);forgeDirectShape(f);
  await assert.rejects(f.assets.addWithReceipt('owner',f.input),e=>e.status===409);
});

test('render audit independently prevents forged direct metadata when attempts are altered',async t=>{
  const f=await fixture(t);forgeDirectShape(f);modifyProduction(f,p=>{p.attempts=[];});
  await assert.rejects(f.assets.addWithReceipt('owner',f.input),e=>e.status===409);
});

test('previously imported assets without new provenance fields remain readable and reusable',async t=>{
  const f=await fixture(t),saved=await f.assets.addWithReceipt('owner',f.input),asset={...saved.asset,provenance:{runId:f.runId,artifactSha256:f.input.artifactSha256}};
  f.store.db.prepare('UPDATE assets SET json=? WHERE id=?').run(JSON.stringify(asset),asset.id);
  assert.equal((await f.assets.content(asset.id,'owner')).asset.id,asset.id);
  assert.equal((await f.assets.binding(asset.id,'owner','input')).id,asset.id);
  await assert.rejects(f.assets.findImportByRequest('owner',f.input.requestId),e=>e.status===409,'modified metadata cannot be used as the new receipt');
});

for(const [label,modify] of [
  ['run owner',f=>modifyRun(f,run=>{run.sessionId='other';})],
  ['run production',f=>modifyRun(f,run=>{run.productionId=randomUUID();})],
  ['run id',f=>modifyRun(f,run=>{run.id=randomUUID();})],
  ['artifact hash',f=>modifyRun(f,run=>{run.artifacts[0].sha256='b'.repeat(64);})],
  ['artifact path',f=>modifyRun(f,run=>{run.artifacts[0].path=join(f.root,'outside.png');})],
  ['artifact traversal',f=>modifyRun(f,run=>{run.artifacts[0].name='../outside.png';run.artifacts[0].path=join(f.root,'outputs','outside.png');})],
  ['production session',f=>modifyProduction(f,p=>{p.sessionId='other';})],
  ['production attempts',f=>modifyProduction(f,p=>{p.attempts=[];})],
  ['production id',f=>modifyProduction(f,p=>{p.id=randomUUID();})],
])test(`committed asset receipt rejects changed source ${label}`,async t=>{
  const f=await fixture(t);await f.assets.addWithReceipt('owner',f.input);modify(f);
  await assert.rejects(f.assets.findImportByRequest('owner',f.input.requestId),refused);
});

for(const [label,modify] of [
  ['production SQL payload hash',f=>f.store.db.prepare('UPDATE productions SET payload_hash=? WHERE id=?').run('b'.repeat(64),f.p.id)],
  ['production SQL request ID',f=>f.store.db.prepare('UPDATE productions SET request_id=? WHERE id=?').run(randomUUID(),f.p.id)],
  ['production creation audit',f=>f.store.db.prepare("UPDATE events SET json=? WHERE run_id=? AND type='production_created'").run(JSON.stringify({briefHash:'b'.repeat(64)}),f.p.id)],
  ['duplicate production creation audit',f=>f.store.event(f.p.id,'production_created',{briefHash:f.productions.get(f.p.id,'owner').briefHash})],
])test(`source rejects mismatched ${label}`,async t=>{
  const f=await fixture(t);modify(f);
  await assert.rejects(f.assets.addWithReceipt('owner',f.input),e=>e.status===409);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM asset_import_receipts').get().n,0);
});

test('committed asset receipt requires the actual source file and its recorded hash',async t=>{
  const f=await fixture(t);await f.assets.addWithReceipt('owner',f.input);await writeFile(f.file,'modified');
  await assert.rejects(f.assets.findImportByRequest('owner',f.input.requestId),e=>e.status===409);
  await unlink(f.file);await assert.rejects(f.assets.findImportByRequest('owner',f.input.requestId),e=>e.status===409);
});

test('source ownership changed while normalization runs prevents asset publication and remains pending',async t=>{
  const entered=gate(),resume=gate(),f=await fixture(t,{normalize:async(src,dst)=>{entered.release();await resume.promise;await writeFile(dst,await readFile(src));return {originalMime:'image/png',mime:'image/png',width:32,height:32};}});
  const pending=f.assets.addWithReceipt('owner',f.input);await entered.promise;
  try{
    modifyRun(f,run=>{run.sessionId='foreign';});resume.release();await assert.rejects(pending,e=>e.status===503);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM assets').get().n,0);
    assert.equal((await f.assets.findImportByRequest('owner',f.input.requestId)).receipt.state,'started');
  }finally{resume.release();await pending.catch(()=>{});}
});

test('receipt read rejects ownership change between its DB snapshot and file validation',async t=>{
  const f=await fixture(t);await f.assets.addWithReceipt('owner',f.input);
  const pending=f.assets.findImportByRequest('owner',f.input.requestId);
  queueMicrotask(()=>modifyRun(f,run=>{run.sessionId='foreign';}));
  await assert.rejects(pending,refused);
});
