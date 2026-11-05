import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,lstatSync,readdirSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {RunStore,digest} from '../apps/controller/store.mjs';
import {ProductionStore} from '../apps/controller/productions.mjs';
import {productionRoute} from '../apps/controller/production-http.mjs';

function fixture(t){
  const store=new RunStore(':memory:'),productions=new ProductionStore(store),session='owner';t.after(()=>store.close());
  const brief={request:'portrait',modelProfile:'qwen-photo-v1',mode:'t2i',criteria:[{id:'C1',description:'portrait'}],invariants:[]};
  const p=productions.create(session,{requestId:randomUUID(),brief}).production;
  const workflows={catalog:async()=>({modelProfiles:[{id:'qwen-photo-v1',available:true}],capabilities:[{modelProfile:'qwen-photo-v1',mode:'t2i'}]})};
  async function call(method,path,input,query=''){let out;await productionRoute({req:{method,headers:{'x-dsh-session':session}},res:{},path,url:new URL('http://local'+path+query),role:'dsh',store,productions,workflows,body:async()=>input,json:(_r,status,value)=>out={status,value}});return out;}
  return {store,productions,session,p,brief,call};
}

for(const operation of ['create','evaluate','iteration','feedback'])test(`${operation}: pre-admission rejection is readable and prevents a late request`,async t=>{
  const f=fixture(t),id=operation==='create'?null:f.p.id,requestId=randomUUID(),input=operation==='create'?{requestId,brief:{...f.brief,criteria:[]}}:{requestId,expectedRevision:99,runId:randomUUID(),sourceRunId:randomUUID(),feedback:'change it'};
  const path=operation==='create'?'/api/productions':`/api/productions/${id}/${operation}`;
  const result=await f.call('POST',path,input);assert.ok(result.status>=400&&result.status<500);assert.equal(result.value.receipt.payloadHash,digest(input));assert.equal(result.value.receipt.targetId,id);
  const lookup=await f.call('GET','/api/productions/mutation-rejections/by-request',null,`?operation=${operation}&requestId=${requestId}`);assert.deepEqual(lookup.value.receipt,result.value.receipt);
  assert.throws(()=>f.productions.findMutationRejection('foreign',operation,requestId),e=>e.status===404);
  if(operation==='create')assert.throws(()=>f.productions.create(f.session,{requestId,brief:f.brief}),e=>e.status===409);
  else {const late={...input,expectedRevision:0};assert.throws(()=>operation==='evaluate'?f.productions.evaluate(id,f.session,late):operation==='iteration'?f.productions.planIteration(id,f.session,late):f.productions.resumeWithFeedback(id,f.session,late),e=>e.status===409);}
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM production_mutation_rejections').get().n,1);
});

test('a committed mutation cannot subsequently acquire a rejection fence',t=>{
  const f=fixture(t),input={requestId:f.p.requestId,brief:f.brief};
  assert.throws(()=>f.productions.rejectUnadmittedMutation(f.session,'create',null,input,409),e=>e.status===503);
  assert.throws(()=>f.productions.findMutationRejection(f.session,'create',input.requestId),e=>e.status===404);
});

test('invalid cancellation is fenced and does not falsely claim a stop or cleanup',async t=>{
  const f=fixture(t),requestId=randomUUID(),input={requestId,expectedRunId:5},path=`/api/productions/${f.p.id}/cancel`,result=await f.call('POST',path,input);
  assert.equal(result.status,400);assert.equal(result.value.receipt.operation,'cancel');assert.equal(result.value.receipt.payloadHash,digest(input));
  assert.throws(()=>f.productions.cancelWithReceipt(f.p.id,f.session,{requestId},'cancel'),e=>e.status===409);
  assert.equal(f.productions.get(f.p.id,f.session).cancelRequested,false);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM production_cancel_receipts').get().n,0);
});

test('prepared render validation rejection fences its run identity',async t=>{
  const f=fixture(t),requestId=randomUUID(),input={requestId,workflowId:7,expectedRevision:0},path=`/api/productions/${f.p.id}/render-prepared`,result=await f.call('POST',path,input);
  assert.equal(result.status,400);assert.equal(result.value.receipt.operation,'prepared-render');assert.throws(()=>f.productions.assertMutationNotRejected(f.session,'render',requestId),e=>e.status===409);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM runs WHERE request_id=?').get(requestId).n,0);
});

test('rejection event and fence roll back together on write failure',t=>{
  const f=fixture(t),input={requestId:randomUUID()},before=f.store.db.prepare("SELECT count(*) AS n FROM events WHERE type='production_mutation_rejected'").get().n;
  f.store.db.exec("CREATE TRIGGER fail_rejection BEFORE INSERT ON production_mutation_rejections BEGIN SELECT RAISE(ABORT,'injected'); END");
  assert.throws(()=>f.productions.rejectUnadmittedMutation(f.session,'create',null,input,400));
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM events WHERE type='production_mutation_rejected'").get().n,before);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM production_mutation_rejections').get().n,0);
});

test('event corruption cannot be presented as rejection evidence',t=>{
  const f=fixture(t),input={requestId:randomUUID()};f.productions.rejectUnadmittedMutation(f.session,'create',null,input,400);
  f.store.db.prepare("UPDATE events SET json='{}' WHERE type='production_mutation_rejected'").run();
  assert.throws(()=>f.productions.findMutationRejection(f.session,'create',input.requestId),e=>e.status===503);
});

test('a missing or malformed rejection table after migration is never silently recreated',t=>{
  const f=fixture(t);f.store.db.exec('DROP TABLE production_mutation_rejections');assert.throws(()=>new ProductionStore(f.store),/table is missing/);
  assert.equal(f.store.db.prepare("SELECT name FROM sqlite_master WHERE name='production_mutation_rejections'").get(),undefined);
  f.store.db.exec('CREATE TABLE production_mutation_rejections(session_id TEXT)');assert.throws(()=>new ProductionStore(f.store),/schema is invalid/);
});

test('rejection schema rejects a primary key whose collation changes identity',t=>{
  const f=fixture(t),sql=f.store.db.prepare("SELECT sql FROM sqlite_master WHERE name='production_mutation_rejections'").get().sql,changed=sql.replace('session_id TEXT','session_id TEXT COLLATE NOCASE');assert.notEqual(sql,changed);
  f.store.db.exec('DROP TABLE production_mutation_rejections');f.store.db.exec(changed);assert.throws(()=>new ProductionStore(f.store),/schema is invalid/);
});

test('an existing rejection marker without its manifest is never rebaselined',t=>{
  const f=fixture(t),input={requestId:randomUUID()};f.productions.rejectUnadmittedMutation(f.session,'create',null,input,400);
  f.store.db.exec("DELETE FROM production_mutation_rejections; DELETE FROM events WHERE type='production_mutation_rejected'; DELETE FROM meta WHERE key='productionMutationManifest:v1'");
  assert.throws(()=>new ProductionStore(f.store),/manifest is missing/);
});

test('deleting a rejection row, event or both is detected at restart',t=>{
  for(const mode of ['row','event','both']){
    const f=fixture(t),input={requestId:randomUUID()};f.productions.rejectUnadmittedMutation(f.session,'create',null,input,400);
    if(mode!=='event')f.store.db.prepare('DELETE FROM production_mutation_rejections WHERE request_id=?').run(input.requestId);
    if(mode!=='row')f.store.db.prepare("DELETE FROM events WHERE type='production_mutation_rejected'").run();
    assert.throws(()=>new ProductionStore(f.store),/event count differs|manifest differs/,mode);
  }
});

test('initial rejection schema and marker roll back when manifest initialization fails',t=>{
  const store=new RunStore(':memory:');t.after(()=>store.close());store.db.exec("CREATE TRIGGER fail_rejection_manifest BEFORE INSERT ON meta WHEN NEW.key='productionMutationManifest:v1' BEGIN SELECT RAISE(ABORT,'injected manifest'); END");
  assert.throws(()=>new ProductionStore(store),/injected manifest/);assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE name='production_mutation_rejections'").get(),undefined);assert.equal(store.db.prepare("SELECT value FROM meta WHERE key='productionMutationRejections:v1'").get(),undefined);
  store.db.exec('DROP TRIGGER fail_rejection_manifest');new ProductionStore(store);assert.equal(store.db.prepare("SELECT value FROM meta WHERE key='productionMutationRejections:v1'").get().value,'done');
});

test('a rejected fence and its event roll back if manifest update fails',t=>{
  const f=fixture(t),input={requestId:randomUUID()};f.store.db.exec("CREATE TRIGGER fail_manifest_update BEFORE UPDATE ON meta WHEN NEW.key='productionMutationManifest:v1' BEGIN SELECT RAISE(ABORT,'injected manifest'); END");
  assert.throws(()=>f.productions.rejectUnadmittedMutation(f.session,'create',null,input,400),/injected manifest/);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM production_mutation_rejections').get().n,0);assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM events WHERE type='production_mutation_rejected'").get().n,0);
});

for(const table of ['workflow_preparations','workflow_preparation_rejections','workflow_request_fence_abandons','legacy_render_receipts','prepared_render_receipts','workflow_preparation_abandons','production_action_receipts','production_cancel_receipts'])test(`${table} cannot be silently recreated after production receipt migration`,t=>{
  const f=fixture(t);f.store.db.exec(`DROP TABLE ${table}`);assert.throws(()=>new ProductionStore(f.store),/receipt table is missing/);assert.equal(f.store.db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(table),undefined);
});

test('production receipt row deletion and independent event corruption block restart',t=>{
  for(const mode of ['row','event']){
    const f=fixture(t),requestId=randomUUID();f.productions.cancelWithReceipt(f.p.id,f.session,{requestId},'cancel');
    if(mode==='row')f.store.db.prepare('DELETE FROM production_cancel_receipts WHERE request_id=?').run(requestId);
    else f.store.db.prepare("UPDATE events SET json='{}' WHERE seq=(SELECT event_seq FROM production_cancel_receipts WHERE request_id=?)").run(requestId);
    assert.throws(()=>new ProductionStore(f.store),/receipt manifest differs|receipt event differs|receipt audit is invalid/,mode);
  }
});

test('production receipt and rejection migration markers protect each other',t=>{
  const a=fixture(t);a.store.db.exec("DROP TABLE production_action_receipts; DELETE FROM meta WHERE key IN ('productionReceiptSchema:v1','productionReceiptManifest:v1')");assert.throws(()=>new ProductionStore(a.store),/receipt migration evidence is missing/);
  const b=fixture(t);b.store.db.exec("DROP TABLE production_mutation_rejections; DELETE FROM meta WHERE key IN ('productionMutationRejections:v1','productionMutationManifest:v1')");assert.throws(()=>new ProductionStore(b.store),/rejection migration evidence is missing/);
});

test('surviving cancellation audit prevents a missing receipt from being rebaselined after all markers disappear',t=>{
  const f=fixture(t),requestId=randomUUID();f.productions.cancelWithReceipt(f.p.id,f.session,{requestId},'cancel');
  f.store.db.exec("DELETE FROM production_cancel_receipts; DELETE FROM meta WHERE key IN ('productionReceiptSchema:v1','productionReceiptManifest:v1','productionMutationRejections:v1','productionMutationManifest:v1')");
  assert.throws(()=>new ProductionStore(f.store),/Cancellation receipt audit has no matching record/);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM production_cancel_receipts').get().n,0);
});

test('generic legacy render events remain eligible for an unmarked old database migration',t=>{
  const f=fixture(t);f.store.event(f.p.id,'render_requested',{runId:randomUUID(),attempt:1,revision:1});
  f.store.db.exec("DELETE FROM meta WHERE key IN ('productionReceiptSchema:v1','productionReceiptManifest:v1','productionMutationRejections:v1','productionMutationManifest:v1')");
  assert.doesNotThrow(()=>new ProductionStore(f.store));
});

test('surviving workflow abandonment audit cannot be rebaselined without its receipt',t=>{
  const f=fixture(t),requestId=randomUUID();f.store.event(f.p.id,'workflow_preparation_abandoned',{requestId,payloadHash:'a'.repeat(64),expectedRevision:1,observedRevision:1});
  f.store.db.exec("DELETE FROM meta WHERE key IN ('productionReceiptSchema:v1','productionReceiptManifest:v1','productionMutationRejections:v1','productionMutationManifest:v1')");
  assert.throws(()=>new ProductionStore(f.store),/Workflow abandonment audit has no matching record/);
});

test('cancel acceptance and event roll back when production receipt manifest update fails',t=>{
  const f=fixture(t),requestId=randomUUID();f.store.db.exec("CREATE TRIGGER fail_prod_receipt_manifest BEFORE UPDATE ON meta WHEN NEW.key='productionReceiptManifest:v1' BEGIN SELECT RAISE(ABORT,'injected manifest'); END");
  assert.throws(()=>f.productions.cancelWithReceipt(f.p.id,f.session,{requestId},'cancel'),/injected manifest/);assert.equal(f.productions.get(f.p.id,f.session).cancelRequested,false);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM production_cancel_receipts').get().n,0);
});

test('legacy feedback admission without a receipt cannot be converted to rejection',t=>{
  const f=fixture(t),requestId=randomUUID(),row=f.store.db.prepare('SELECT json FROM productions WHERE id=?').get(f.p.id),p=JSON.parse(row.json);
  p.feedbackRequests=[{requestId}];f.store.db.prepare('UPDATE productions SET json=? WHERE id=?').run(JSON.stringify(p),f.p.id);
  assert.throws(()=>f.productions.rejectUnadmittedMutation(f.session,'feedback',f.p.id,{requestId},409),e=>e.status===503);
});

test('independent processes cannot both accept and reject the same creation',async t=>{
  const base=resolve(tmpdir()),root=mkdtempSync(join(base,'production-fence-race-')),path=join(root,'controller.sqlite'),store=new RunStore(path);new ProductionStore(store);store.close();
  t.after(()=>{assert.ok(resolve(root).startsWith(base+sep));const visit=p=>{const s=lstatSync(p);assert.equal(s.isSymbolicLink(),false);if(s.isDirectory())for(const n of readdirSync(p))visit(join(p,n));};visit(root);rmSync(root,{recursive:true});});
  const input={requestId:randomUUID(),brief:{request:'portrait',modelProfile:'qwen-photo-v1',mode:'t2i',criteria:[{id:'C1',description:'portrait'}],invariants:[]}};
  const script=`import {RunStore} from ${JSON.stringify(pathToFileURL(resolve('apps/controller/store.mjs')).href)};import {ProductionStore} from ${JSON.stringify(pathToFileURL(resolve('apps/controller/productions.mjs')).href)};const v=JSON.parse(process.env.PROD_FENCE_FIXTURE),s=new RunStore(v.path),p=new ProductionStore(s);process.send('ready');process.once('message',()=>{try{if(v.mode==='reject')p.rejectUnadmittedMutation('owner','create',null,v.input,400);else p.create('owner',v.input);process.send('done');}catch(e){process.send('refused');}finally{s.close();process.disconnect();}});`;
  const children=[],start=mode=>{const child=spawn(process.execPath,['--input-type=module','-e',script],{windowsHide:true,env:{...process.env,PROD_FENCE_FIXTURE:JSON.stringify({path,input,mode})},stdio:['ignore','pipe','pipe','ipc']});children.push(child);let stderr='';child.stderr.on('data',b=>stderr+=b);const ready=new Promise((done,fail)=>{child.on('message',m=>{if(m==='ready')done();});child.once('error',fail);child.once('exit',c=>{if(c!==0)fail(Error(stderr));});});const exited=new Promise((done,fail)=>{child.once('error',fail);child.once('exit',c=>c===0?done():fail(Error(stderr)));});return {child,ready,exited};};
  const a=start('reject'),b=start('create');try{await Promise.all([a.ready,b.ready]);a.child.send('go');b.child.send('go');await Promise.all([a.exited,b.exited]);}finally{for(const child of children)if(child.exitCode===null)child.kill();}
  const inspect=new RunStore(path);try{const accepted=inspect.db.prepare('SELECT count(*) AS n FROM productions WHERE session_id=? AND request_id=?').get('owner',input.requestId).n,rejected=inspect.db.prepare('SELECT count(*) AS n FROM production_mutation_rejections WHERE session_id=? AND request_id=?').get('owner',input.requestId).n;assert.equal(accepted+rejected,1);}finally{inspect.close();}
});

test('independent processes cannot both accept and reject the same iteration',async t=>{
  const base=resolve(tmpdir()),root=mkdtempSync(join(base,'action-fence-race-')),path=join(root,'controller.sqlite'),store=new RunStore(path),p=new ProductionStore(store),sourceRunId=randomUUID();
  const production=p.create('owner',{requestId:randomUUID(),brief:{request:'portrait',modelProfile:'qwen-photo-v1',mode:'t2i',criteria:[{id:'C1',description:'portrait'}],invariants:[]}}).production;
  production.latestRunId=sourceRunId;production.phase='revising';production.evaluations=[{runId:sourceRunId,decision:'revise',specHash:'a'.repeat(64),artifactSha256:'b'.repeat(64)}];store.db.prepare('UPDATE productions SET json=? WHERE id=?').run(JSON.stringify(production),production.id);store.close();
  t.after(()=>{assert.ok(resolve(root).startsWith(base+sep));const visit=p=>{const s=lstatSync(p);assert.equal(s.isSymbolicLink(),false);if(s.isDirectory())for(const n of readdirSync(p))visit(join(p,n));};visit(root);rmSync(root,{recursive:true});});
  const input={requestId:randomUUID(),expectedRevision:0,sourceRunId,category:'prompt',action:'regenerate',hypothesis:'light',preserve:['composition'],changes:['lighting'],comparison:'compare'};
  const script=`import {RunStore} from ${JSON.stringify(pathToFileURL(resolve('apps/controller/store.mjs')).href)};import {ProductionStore} from ${JSON.stringify(pathToFileURL(resolve('apps/controller/productions.mjs')).href)};const v=JSON.parse(process.env.ACTION_FENCE_FIXTURE),s=new RunStore(v.path),p=new ProductionStore(s);process.send('ready');process.once('message',()=>{try{if(v.mode==='reject')p.rejectUnadmittedMutation('owner','iteration',v.id,v.input,400);else p.planIteration(v.id,'owner',v.input);process.send('done');}catch(e){process.send('refused');}finally{s.close();process.disconnect();}});`;
  const children=[],start=mode=>{const child=spawn(process.execPath,['--input-type=module','-e',script],{windowsHide:true,env:{...process.env,ACTION_FENCE_FIXTURE:JSON.stringify({path,input,id:production.id,mode})},stdio:['ignore','pipe','pipe','ipc']});children.push(child);let stderr='';child.stderr.on('data',b=>stderr+=b);const ready=new Promise((done,fail)=>{child.on('message',m=>{if(m==='ready')done();});child.once('error',fail);child.once('exit',c=>{if(c!==0)fail(Error(stderr));});});const exited=new Promise((done,fail)=>{child.once('error',fail);child.once('exit',c=>c===0?done():fail(Error(stderr)));});return {child,ready,exited};};
  const a=start('reject'),b=start('action');try{await Promise.all([a.ready,b.ready]);a.child.send('go');b.child.send('go');await Promise.all([a.exited,b.exited]);}finally{for(const child of children)if(child.exitCode===null)child.kill();}
  const inspect=new RunStore(path);try{const accepted=inspect.db.prepare('SELECT count(*) AS n FROM production_action_receipts WHERE session_id=? AND request_id=?').get('owner',input.requestId).n,rejected=inspect.db.prepare('SELECT count(*) AS n FROM production_mutation_rejections WHERE session_id=? AND request_id=?').get('owner',input.requestId).n;assert.equal(accepted+rejected,1);}finally{inspect.close();}
});
