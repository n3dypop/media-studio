import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {RunStore,digest} from '../apps/controller/store.mjs';
import {ProductionStore} from '../apps/controller/productions.mjs';
import {MossPeCoordinator} from '../apps/controller/moss-pe-controller.mjs';
import {mossPeRoute} from '../apps/controller/moss-pe-http.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');

function fixture(t,family){
  const store=new RunStore(':memory:'),productions=new ProductionStore(store);t.after(()=>store.close());
  const profile=family==='qwen'?'qwen-image-2.1-base-v1':'moss-image-sft-official-v1';
  const p=productions.create('owner',{requestId:randomUUID(),brief:{request:'adult portrait',modelProfile:profile,mode:'t2i',criteria:[{id:'C1',description:'portrait'}],invariants:['adult']}}).production;
  const pe=new MossPeCoordinator({store,productions,adapter:{},gate:{},verifyEpoch:async()=>({}),family,...(family==='qwen'?{licenseCheck:async()=>true}:{})});
  const started=pe.create(p.id,'owner',{productionId:p.id,requestId:randomUUID(),expectedRevision:0,prompt:'adult portrait',reason:'improve clarity'}),result={originalPrompt:'adult portrait',enhancedPrompt:'clear adult portrait',originalPromptSha256:sha('adult portrait'),enhancedPromptSha256:sha('clear adult portrait'),completionReason:'stop'};
  store.update(started.run.id,{phase:'completed',[pe.stateKey]:{phase:'core-restored',result}});
  const input={requestId:randomUUID(),expectedRevision:started.production.revision,decision:'accept',reason:'required elements retained',originalPromptSha256:result.originalPromptSha256,enhancedPromptSha256:result.enhancedPromptSha256,invariants:[{kind:'user-request',requirement:'adult portrait',status:'met',evidence:'present'},{kind:'source-prompt',requirement:'adult portrait',status:'met',evidence:'present'},{kind:'invariants',requirement:'adult',status:'met',evidence:'present'}]};
  return {store,productions,p,pe,runId:started.run.id,input};
}

for(const family of ['moss','qwen'])for(const operation of ['start','decision','reconcile'])test(`${family} ${operation}: pre-admission rejection fences a later valid request`,async t=>{
  const {store,productions,p,pe,runId,input}=fixture(t,family),requestId=randomUUID(),targetId=operation==='start'?p.id:runId,basePath=`/api/${family}-pe`;
  const valid=operation==='start'?{productionId:p.id,requestId,expectedRevision:1,prompt:'adult portrait',reason:'clearer'}:operation==='decision'?{...input,requestId}:{requestId};
  const bad=operation==='start'?{...valid,reason:''}:operation==='decision'?{...valid,reason:''}:{...valid,extra:true};
  const path=operation==='start'?basePath:`${basePath}/${runId}/${operation}`;let out;
  await mossPeRoute({req:{method:'POST',headers:{'x-dsh-session':'owner'}},res:{},path,url:new URL('http://local'+path),body:async()=>bad,json:(_r,status,value)=>out={status,value},mossPe:pe,enabled:true,basePath});
  assert.equal(out.status,400);assert.equal(out.value.receipt.payloadHash,digest(bad));assert.equal(out.value.receipt.targetId,targetId);
  assert.deepEqual(productions.findMutationRejection('owner',`${family}-pe-${operation}`,requestId).receipt,out.value.receipt);
  assert.throws(()=>operation==='start'?pe.create(p.id,'owner',valid):operation==='decision'?pe.decide(runId,'owner',valid):pe.acceptReconcile(runId,'owner',valid),e=>e.status===409);
  const table=operation==='start'?'pe_start_receipts':operation==='decision'?'pe_decision_receipts':'pe_reconcile_receipts';assert.equal(store.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE request_id=?`).get(requestId).n,0);
});

for(const family of ['moss','qwen'])for(const operation of ['start','decision','reconcile'])test(`${family} ${operation}: disabled PE fences a new request without claiming execution`,async t=>{
  const {store,productions,p,pe,runId,input}=fixture(t,family),requestId=randomUUID(),targetId=operation==='start'?p.id:runId,basePath=`/api/${family}-pe`;
  const valid=operation==='start'?{productionId:p.id,requestId,expectedRevision:1,prompt:'adult portrait',reason:'clearer'}:operation==='decision'?{...input,requestId}:{requestId},path=operation==='start'?basePath:`${basePath}/${runId}/${operation}`;let out;
  await mossPeRoute({req:{method:'POST',headers:{'x-dsh-session':'owner'}},res:{},path,url:new URL('http://local'+path),body:async()=>valid,json:(_r,status,value)=>out={status,value},mossPe:null,productions,enabled:false,basePath});
  assert.equal(out.status,409);assert.equal(out.value.receipt.operation,`${family}-pe-${operation}`);assert.equal(out.value.receipt.payloadHash,digest(valid));assert.equal(out.value.receipt.targetId,targetId);
  assert.deepEqual(productions.findMutationRejection('owner',`${family}-pe-${operation}`,requestId).receipt,out.value.receipt);
  assert.throws(()=>operation==='start'?pe.create(p.id,'owner',valid):operation==='decision'?pe.decide(runId,'owner',valid):pe.acceptReconcile(runId,'owner',valid),e=>e.status===409);
  const table=operation==='start'?'pe_start_receipts':operation==='decision'?'pe_decision_receipts':'pe_reconcile_receipts';assert.equal(store.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE request_id=?`).get(requestId).n,0);
});

test('disabled PE cannot reject an already accepted request or assume a missing receipt table is empty',async t=>{
  const {store,productions,p,pe,runId}=fixture(t,'moss'),started=pe.get(runId,'owner'),basePath='/api/moss-pe';
  const input={productionId:p.id,requestId:started.requestId,expectedRevision:0,prompt:'adult portrait',reason:'improve clarity'};
  await assert.rejects(mossPeRoute({req:{method:'POST',headers:{'x-dsh-session':'owner'}},res:{},path:basePath,url:new URL('http://local'+basePath),body:async()=>input,json:()=>{},mossPe:null,productions,enabled:false,basePath}),e=>e.status===503);
  store.db.exec('DROP TABLE pe_reconcile_receipts');const path=`${basePath}/${runId}/reconcile`;
  await assert.rejects(mossPeRoute({req:{method:'POST',headers:{'x-dsh-session':'owner'}},res:{},path,url:new URL('http://local'+path),body:async()=>({requestId:randomUUID()}),json:()=>{},mossPe:null,productions,enabled:false,basePath}),e=>e.status===503);
});

for(const family of ['moss','qwen'])test(`${family} PE decision receipt is atomic, owner-bound and read-only`,async t=>{
  const {store,productions,p,pe,runId,input}=fixture(t,family),created=pe.decide(runId,'owner',input);
  assert.equal(created.receipt.payloadHash,digest(input));assert.equal(created.receipt.productionRevision,input.expectedRevision+1);assert.equal(created.receipt.runId,runId);
  const observed=pe.findDecision(runId,'owner',input.requestId);assert.equal(observed.receipt.decisionId,created.receipt.decisionId);
  assert.equal(pe.decide(runId,'owner',input).created,false);
  assert.throws(()=>pe.decide(runId,'owner',{...input,reason:'changed'}),e=>e.status===409);
  assert.throws(()=>pe.findDecision(runId,'foreign',input.requestId),e=>e.status===404);
  assert.throws(()=>pe.findDecision(runId,'owner',randomUUID()),e=>e.status===404);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM pe_decision_receipts').get().n,1);
  let output;const path=`/api/${family==='qwen'?'qwen':'moss'}-pe/${runId}/decision-by-request`;
  await mossPeRoute({req:{method:'GET',headers:{'x-dsh-session':'owner'}},res:{},path,url:new URL(`http://local${path}?requestId=${input.requestId}`),body:async()=>({}),json:(_r,status,value)=>output={status,value},mossPe:pe,enabled:true,basePath:`/api/${family==='qwen'?'qwen':'moss'}-pe`});
  assert.equal(output.status,200);assert.equal(output.value.receipt.decisionHash,created.receipt.decisionHash);
  productions.cancelWithReceipt(p.id,'owner',{requestId:randomUUID()},'cancel');
  assert.equal(pe.findDecision(runId,'owner',input.requestId).cancellationReceipt?.disposition,'accepted');
});

test('PE receipt fails closed on changed decision evidence and preserves rollback on failed insert',t=>{
  const {store,pe,runId,input}=fixture(t,'moss');
  store.db.exec("CREATE TRIGGER reject_pe_receipt BEFORE INSERT ON pe_decision_receipts BEGIN SELECT RAISE(ABORT,'injected PE receipt failure'); END");
  assert.throws(()=>pe.decide(runId,'owner',input),/injected PE receipt failure/);
  assert.equal(pe.get(runId,'owner').mossPeDecision,undefined);
  store.db.exec('DROP TRIGGER reject_pe_receipt');const saved=pe.decide(runId,'owner',input);
  const receipt=store.db.prepare('SELECT production_event_seq FROM pe_decision_receipts WHERE request_id=?').get(input.requestId);
  store.db.prepare('UPDATE events SET json=? WHERE seq=?').run('{}',receipt.production_event_seq);
  assert.throws(()=>pe.findDecision(runId,'owner',input.requestId),e=>e.status===409);
  assert.throws(()=>pe.decide(runId,'owner',input),e=>e.status===409);
  assert.ok(saved.receipt.decisionId);
});

test('legacy PE decision without requestId retains its original response shape',t=>{
  const {store,pe,runId,input}=fixture(t,'moss'),{requestId,...legacy}=input,result=pe.decide(runId,'owner',legacy);
  assert.equal(result.receipt,undefined);assert.equal(result.created,undefined);assert.equal(store.db.prepare('SELECT count(*) AS n FROM pe_decision_receipts').get().n,0);
});

for(const family of ['moss','qwen'])test(`${family} PE start receipt binds the exact input, production and persisted run`,t=>{
  const {store,productions,p,pe,runId}=fixture(t,family),run=pe.get(runId,'owner');
  const receipt=pe.findStartReceipt(p.id,'owner',run.requestId);
  assert.equal(receipt.receipt.runId,runId);assert.equal(receipt.receipt.productionRevision,1);
  assert.throws(()=>pe.findStartReceipt(p.id,'foreign',run.requestId),e=>e.status===404);
  const changed={productionId:p.id,requestId:run.requestId,expectedRevision:1,prompt:'adult portrait',reason:'improve clarity'};
  assert.throws(()=>pe.create(p.id,'owner',changed),e=>e.status===503);
  productions.cancelWithReceipt(p.id,'owner',{requestId:randomUUID()},'cancel');
  assert.equal(pe.findStartReceipt(p.id,'owner',run.requestId).cancellationReceipt?.disposition,'accepted');
  const event=store.db.prepare('SELECT production_event_seq FROM pe_start_receipts WHERE request_id=?').get(run.requestId);
  store.db.prepare('UPDATE events SET json=? WHERE seq=?').run('{}',event.production_event_seq);
  assert.throws(()=>pe.findStartReceipt(p.id,'owner',run.requestId),e=>e.status===409);
});

for(const family of ['moss','qwen'])test(`${family} post-commit PE start receipt failure remains unknown`,t=>{
  const {store,productions,p,pe}=fixture(t,family),expectedRevision=productions.get(p.id,'owner').revision,requestId=randomUUID(),find=pe.findStartReceipt.bind(pe);
  pe.findStartReceipt=()=>{const error=new Error('injected evidence failure');error.status=409;throw error;};
  assert.throws(()=>pe.create(p.id,'owner',{productionId:p.id,requestId,expectedRevision,prompt:'adult portrait',reason:'another attempt'}),e=>e.status===503);
  pe.findStartReceipt=find;
  assert.ok(pe.findStartReceipt(p.id,'owner',requestId).receipt.runId);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM runs WHERE request_id=?').get(requestId).n,1);
});

test('failed PE start receipt insert rolls back the run, production and event',t=>{
  const {store,productions,p,pe}=fixture(t,'moss'),before=productions.get(p.id,'owner');
  // The completed first run can remain; force insertion failure for a new one.
  store.db.exec("CREATE TRIGGER reject_pe_start BEFORE INSERT ON pe_start_receipts BEGIN SELECT RAISE(ABORT,'injected PE start receipt failure'); END");
  assert.throws(()=>pe.create(p.id,'owner',{productionId:p.id,requestId:randomUUID(),expectedRevision:before.revision,prompt:'adult portrait',reason:'second'}),/injected PE start receipt failure/);
  assert.equal(productions.get(p.id,'owner').revision,before.revision);
  assert.equal(productions.get(p.id,'owner').promptEnhancements.length,1);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM events WHERE type='moss_pe_requested'").get().n,1);
});

for(const family of ['moss','qwen'])test(`${family} PE reconciliation receipt is distinct from job completion and is never requeued on replay`,async t=>{
  const {store,pe,runId}=fixture(t,family),base=`/api/${family==='qwen'?'qwen':'moss'}-pe`,requestId=randomUUID(),path=`${base}/${runId}/reconcile`;
  store.update(runId,{phase:'needs_attention'});let launches=0;pe.launch=()=>{launches++;};
  async function call(method,action,input={},session='owner'){
    let output;const target=`${base}/${runId}/${action}`,url=new URL(`http://local${target}${method==='GET'?`?requestId=${requestId}`:''}`);
    await mossPeRoute({req:{method,headers:{'x-dsh-session':session}},res:{},path:target,url,body:async()=>input,json:(_r,status,value)=>output={status,value},mossPe:pe,enabled:true,basePath:base});return output;
  }
  const first=await call('POST','reconcile',{requestId});assert.equal(first.status,202);assert.equal(first.value.receipt.operation,'reconcile');assert.equal(first.value.receipt.payloadHash,digest({requestId}));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(launches,1);
  const found=await call('GET','reconcile-by-request');assert.equal(found.value.receipt.requestId,requestId);assert.match(found.value.guidance,/only.*accepted/i);
  const repeated=await call('POST','reconcile',{requestId});assert.equal(repeated.value.created,false);await new Promise(resolve=>setImmediate(resolve));assert.equal(launches,1);
  await assert.rejects(call('GET','reconcile-by-request',{},'foreign'),e=>e.status===404);
});

test('post-commit PE scheduling failure is unknown and acceptance remains readable',async t=>{
  const {store,pe,runId}=fixture(t,'moss'),base='/api/moss-pe',requestId=randomUUID();store.update(runId,{phase:'needs_attention'});
  pe.work={has:()=>{throw new Error('injected scheduling failure');}};
  await assert.rejects(mossPeRoute({req:{method:'POST',headers:{'x-dsh-session':'owner'}},res:{},path:`${base}/${runId}/reconcile`,url:new URL(`http://local${base}/${runId}/reconcile`),body:async()=>({requestId}),json:()=>{},mossPe:pe,enabled:true,basePath:base}),e=>e.status===503);
  assert.equal(pe.findReconcile(runId,'owner',requestId).receipt.operation,'reconcile');
  const event=store.db.prepare('SELECT event_seq FROM pe_reconcile_receipts WHERE request_id=?').get(requestId);store.db.prepare('UPDATE events SET json=? WHERE seq=?').run('{}',event.event_seq);
  assert.throws(()=>pe.findReconcile(runId,'owner',requestId),e=>e.status===409);
});

for(const family of ['moss','qwen'])test(`${family} original PE run spec or event modification cannot validate a later receipt`,t=>{
  const {store,pe,runId,input}=fixture(t,family),decision=pe.decide(runId,'owner',input),reconcileId=randomUUID();
  pe.acceptReconcile(runId,'owner',{requestId:reconcileId});
  const saved=store.db.prepare('SELECT json,payload_hash FROM runs WHERE id=?').get(runId),run=JSON.parse(saved.json);
  run.spec.seed='500';run.specHash=digest(run.spec);store.db.prepare('UPDATE runs SET json=?,payload_hash=? WHERE id=?').run(JSON.stringify(run),run.specHash,runId);
  assert.throws(()=>pe.findDecision(runId,'owner',input.requestId),e=>e.status===409);
  assert.throws(()=>pe.findReconcile(runId,'owner',reconcileId),e=>e.status===409);
  store.db.prepare('UPDATE runs SET json=?,payload_hash=? WHERE id=?').run(saved.json,saved.payload_hash,runId);
  const event=store.db.prepare("SELECT seq,at,json FROM events WHERE run_id=? AND type='production_created'").get(decision.production.id);
  store.db.prepare('DELETE FROM events WHERE seq=?').run(event.seq);store.db.prepare("INSERT INTO events(run_id,at,type,json) VALUES(?,?,'production_created',?)").run(decision.production.id,event.at,event.json);
  assert.throws(()=>pe.findDecision(runId,'owner',input.requestId),e=>e.status===409);
  assert.throws(()=>pe.findReconcile(runId,'owner',reconcileId),e=>e.status===409);
});

for(const family of ['moss','qwen'])test(`${family} one-time PE legacy snapshot accepts proven historical runs but never downgrades a new missing receipt`,t=>{
  const {store,productions,pe,runId,input}=fixture(t,family),run=pe.get(runId,'owner');
  const marker=`peLegacySnapshot:v1:${family}`;store.db.prepare('DELETE FROM pe_start_receipts WHERE run_id=?').run(runId);
  // The migration was already completed before this run existed.
  assert.throws(()=>pe.decide(runId,'owner',input),e=>e.status===409);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM pe_decision_receipts').get().n,0);
  store.db.prepare('DELETE FROM meta WHERE key IN (?,?,?,?)').run(marker,`peLegacyManifest:v1:${family}`,'peReceiptSchema:v1','peReceiptManifest:v1');
  const restored=new MossPeCoordinator({store,productions,adapter:{},gate:{},verifyEpoch:async()=>({}),family,...(family==='qwen'?{licenseCheck:async()=>true}:{})});
  assert.equal(store.db.prepare('SELECT request_id FROM pe_legacy_origins WHERE run_id=?').get(runId).request_id,run.requestId);
  assert.equal(restored.decide(runId,'owner',input).receipt.runId,runId);
  const snapshotCount=store.db.prepare('SELECT count(*) AS n FROM pe_legacy_origins').get().n;
  new MossPeCoordinator({store,productions,adapter:{},gate:{},verifyEpoch:async()=>({}),family,...(family==='qwen'?{licenseCheck:async()=>true}:{})});
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM pe_legacy_origins').get().n,snapshotCount);
});

test('PE legacy snapshot rolls back and can restart after an insert failure',t=>{
  const {store,productions,pe,runId}=fixture(t,'moss'),marker='peLegacySnapshot:v1:moss';
  store.db.prepare('DELETE FROM pe_start_receipts WHERE run_id=?').run(runId);store.db.prepare('DELETE FROM meta WHERE key IN (?,?,?,?)').run(marker,'peLegacyManifest:v1:moss','peReceiptSchema:v1','peReceiptManifest:v1');
  store.db.exec("CREATE TRIGGER reject_pe_legacy BEFORE INSERT ON pe_legacy_origins BEGIN SELECT RAISE(ABORT,'injected PE legacy failure'); END");
  const create=()=>new MossPeCoordinator({store,productions,adapter:{},gate:{},verifyEpoch:async()=>({}),family:'moss'});
  assert.throws(create,/injected PE legacy failure/);assert.equal(store.db.prepare('SELECT value FROM meta WHERE key=?').get(marker),undefined);assert.equal(store.db.prepare('SELECT count(*) AS n FROM pe_legacy_origins').get().n,0);
  store.db.exec('DROP TRIGGER reject_pe_legacy');create();assert.equal(store.db.prepare('SELECT value FROM meta WHERE key=?').get(marker).value,'done');assert.equal(store.db.prepare('SELECT count(*) AS n FROM pe_legacy_origins').get().n,1);
});

test('unproven or corrupted historical PE records never enter the one-time snapshot',t=>{
  const {store,productions,pe,runId,input}=fixture(t,'moss'),run=pe.get(runId,'owner'),marker='peLegacySnapshot:v1:moss';
  store.db.prepare('DELETE FROM pe_start_receipts WHERE run_id=?').run(runId);store.db.prepare('DELETE FROM meta WHERE key IN (?,?,?,?)').run(marker,'peLegacyManifest:v1:moss','peReceiptSchema:v1','peReceiptManifest:v1');
  run.spec.seed='500';run.specHash=digest(run.spec);store.db.prepare('UPDATE runs SET json=?,payload_hash=? WHERE id=?').run(JSON.stringify(run),run.specHash,runId);
  const restored=new MossPeCoordinator({store,productions,adapter:{},gate:{},verifyEpoch:async()=>({}),family:'moss'});
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM pe_legacy_origins').get().n,0);assert.throws(()=>restored.decide(runId,'owner',input),e=>e.status===409);
});

for(const family of ['moss','qwen'])test(`${family} marker prevents a missing or malformed legacy table from being recreated`,t=>{
  const {store,productions}=fixture(t,family),other=family==='moss'?'qwen':'moss';
  const make=()=>new MossPeCoordinator({store,productions,adapter:{},gate:{},verifyEpoch:async()=>({}),family:other,...(other==='qwen'?{licenseCheck:async()=>true}:{})});
  store.db.exec('DROP TABLE pe_legacy_origins');assert.throws(make,/table is missing/);assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE name='pe_legacy_origins'").get(),undefined);
  store.db.exec('CREATE TABLE pe_legacy_origins(run_id TEXT PRIMARY KEY,family TEXT)');assert.throws(make,/schema is invalid/);
});

for(const family of ['moss','qwen'])test(`${family} legacy manifest detects deleted or modified history on either-family startup`,t=>{
  const {store,productions,pe,runId}=fixture(t,family),marker=`peLegacySnapshot:v1:${family}`,manifest=`peLegacyManifest:v1:${family}`;
  store.db.prepare('DELETE FROM pe_start_receipts WHERE run_id=?').run(runId);store.db.prepare('DELETE FROM meta WHERE key IN (?,?,?,?)').run(marker,manifest,'peReceiptSchema:v1','peReceiptManifest:v1');
  const make=f=>new MossPeCoordinator({store,productions,adapter:{},gate:{},verifyEpoch:async()=>({}),family:f,...(f==='qwen'?{licenseCheck:async()=>true}:{})});
  make(family);const saved=store.db.prepare('SELECT * FROM pe_legacy_origins WHERE run_id=?').get(runId);assert.ok(saved);
  store.db.prepare('DELETE FROM pe_legacy_origins WHERE run_id=?').run(runId);assert.throws(()=>make(family==='moss'?'qwen':'moss'),/manifest differs/);
  store.db.prepare('INSERT INTO pe_legacy_origins VALUES(?,?,?,?,?,?)').run(saved.run_id,saved.family,saved.session_id,saved.production_id,saved.request_id,saved.payload_hash);
  store.db.prepare('UPDATE pe_legacy_origins SET payload_hash=? WHERE run_id=?').run('a'.repeat(64),runId);assert.throws(()=>make(family),/origin differs|manifest differs/);
});

test('legacy table, marker and manifest creation roll back together when manifest persistence fails',t=>{
  const store=new RunStore(':memory:'),productions=new ProductionStore(store);t.after(()=>store.close());
  store.db.exec("CREATE TRIGGER reject_legacy_manifest BEFORE INSERT ON meta WHEN NEW.key='peLegacyManifest:v1:moss' BEGIN SELECT RAISE(ABORT,'injected manifest failure'); END");
  const make=()=>new MossPeCoordinator({store,productions,adapter:{},gate:{},verifyEpoch:async()=>({}),family:'moss'});
  assert.throws(make,/injected manifest failure/);assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE name='pe_legacy_origins'").get(),undefined);assert.equal(store.db.prepare("SELECT value FROM meta WHERE key='peLegacySnapshot:v1:moss'").get(),undefined);
  store.db.exec('DROP TRIGGER reject_legacy_manifest');make();assert.equal(store.db.prepare("SELECT value FROM meta WHERE key='peLegacySnapshot:v1:moss'").get().value,'done');
});

test('an existing marker without its manifest stays closed and is not rebaselined',t=>{
  const {store,productions}=fixture(t,'moss');store.db.prepare("DELETE FROM meta WHERE key='peLegacyManifest:v1:moss'").run();
  assert.throws(()=>new MossPeCoordinator({store,productions,adapter:{},gate:{},verifyEpoch:async()=>({}),family:'moss'}),/manifest is missing/);
  assert.equal(store.db.prepare("SELECT value FROM meta WHERE key='peLegacyManifest:v1:moss'").get(),undefined);
});

for(const table of ['pe_start_receipts','pe_decision_receipts','pe_reconcile_receipts'])test(`${table} cannot be recreated after receipt migration`,t=>{
  const {store,productions}=fixture(t,'moss');store.db.exec(`DROP TABLE ${table}`);
  assert.throws(()=>new MossPeCoordinator({store,productions,adapter:{},gate:{},verifyEpoch:async()=>({}),family:'moss'}),/receipt table is missing/);
  assert.equal(store.db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(table),undefined);
});

for(const table of ['pe_legacy_origins','pe_reconcile_receipts'])test(`${table} rejects altered primary-key collation`,t=>{
  const {store,productions}=fixture(t,'moss'),sql=store.db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(table).sql;
  const changed=table==='pe_legacy_origins'?sql.replace('run_id TEXT','run_id TEXT COLLATE NOCASE'):sql.replace('session_id TEXT','session_id TEXT COLLATE NOCASE');assert.notEqual(sql,changed);
  store.db.exec(`DROP TABLE ${table}`);store.db.exec(changed);
  assert.throws(()=>new MossPeCoordinator({store,productions,adapter:{},gate:{},verifyEpoch:async()=>({}),family:'moss'}),/schema is invalid/);
});

test('PE receipt row removal and source event corruption prevent restart',t=>{
  for(const kind of ['row','event']){
    const {store,productions,pe,runId}=fixture(t,'moss'),requestId=randomUUID();pe.acceptReconcile(runId,'owner',{requestId});
    if(kind==='row')store.db.prepare('DELETE FROM pe_reconcile_receipts WHERE request_id=?').run(requestId);
    else store.db.prepare("UPDATE events SET json='{}' WHERE seq=(SELECT event_seq FROM pe_reconcile_receipts WHERE request_id=?)").run(requestId);
    assert.throws(()=>new MossPeCoordinator({store,productions,adapter:{},gate:{},verifyEpoch:async()=>({}),family:'moss'}),/receipt manifest differs|source evidence differs/,kind);
  }
});

test('PE receipt and event roll back if receipt manifest cannot be updated',t=>{
  const {store,pe,runId}=fixture(t,'moss'),requestId=randomUUID();store.db.exec("CREATE TRIGGER fail_pe_receipt_manifest BEFORE UPDATE ON meta WHEN NEW.key='peReceiptManifest:v1' BEGIN SELECT RAISE(ABORT,'injected PE manifest'); END");
  assert.throws(()=>pe.acceptReconcile(runId,'owner',{requestId}),/injected PE manifest/);assert.equal(store.db.prepare('SELECT count(*) AS n FROM pe_reconcile_receipts WHERE request_id=?').get(requestId).n,0);assert.equal(store.db.prepare("SELECT count(*) AS n FROM events WHERE type='moss_pe_reconcile_requested'").get().n,0);
});

test('old PE receipt tables are baselined only when their independent source evidence validates',t=>{
  const {store,productions}=fixture(t,'moss');store.db.exec("DELETE FROM meta WHERE key IN ('peReceiptSchema:v1','peReceiptManifest:v1','peLegacySnapshot:v1:moss','peLegacyManifest:v1:moss')");
  new MossPeCoordinator({store,productions,adapter:{},gate:{},verifyEpoch:async()=>({}),family:'moss'});assert.equal(store.db.prepare("SELECT value FROM meta WHERE key='peReceiptSchema:v1'").get().value,'done');
});

test('PE receipt table and both markers cannot be silently reset while legacy migration evidence remains',t=>{
  const {store,productions}=fixture(t,'moss');store.db.exec("DROP TABLE pe_reconcile_receipts; DELETE FROM meta WHERE key IN ('peReceiptSchema:v1','peReceiptManifest:v1')");
  assert.throws(()=>new MossPeCoordinator({store,productions,adapter:{},gate:{},verifyEpoch:async()=>({}),family:'moss'}),/migration evidence is missing/);
  assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE name='pe_reconcile_receipts'").get(),undefined);
});

test('PE legacy table and markers cannot be reset while receipt migration evidence remains',t=>{
  const {store,productions}=fixture(t,'moss');store.db.exec("DROP TABLE pe_legacy_origins; DELETE FROM meta WHERE key IN ('peLegacySnapshot:v1:moss','peLegacyManifest:v1:moss')");
  assert.throws(()=>new MossPeCoordinator({store,productions,adapter:{},gate:{},verifyEpoch:async()=>({}),family:'moss'}),/legacy migration evidence is missing/);
  assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE name='pe_legacy_origins'").get(),undefined);
});

test('a saved reconciliation event prevents reinitialization even if both PE marker families disappear',t=>{
  const {store,productions,pe,runId}=fixture(t,'moss');pe.acceptReconcile(runId,'owner',{requestId:randomUUID()});
  store.db.exec("DROP TABLE pe_reconcile_receipts; DELETE FROM meta WHERE key IN ('peReceiptSchema:v1','peReceiptManifest:v1','peLegacySnapshot:v1:moss','peLegacyManifest:v1:moss','peLegacySnapshot:v1:qwen','peLegacyManifest:v1:qwen')");
  assert.throws(()=>new MossPeCoordinator({store,productions,adapter:{},gate:{},verifyEpoch:async()=>({}),family:'moss'}),/saved reconciliation event/);
  assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE name='pe_reconcile_receipts'").get(),undefined);
});
