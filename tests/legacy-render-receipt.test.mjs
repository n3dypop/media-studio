import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {RunStore,digest} from '../apps/controller/store.mjs';
import {ProductionStore} from '../apps/controller/productions.mjs';
import {productionRoute} from '../apps/controller/production-http.mjs';

function fixture(t,enhancer=false){
  const store=new RunStore(':memory:'),productions=new ProductionStore(store);t.after(()=>store.close());
  const p=productions.create('owner',{requestId:randomUUID(),brief:{request:'adult portrait',modelProfile:'moss-image-sft-int8-v1',mode:'t2i',criteria:[{id:'C1',description:'portrait'}],invariants:['adult']}}).production;
  const graph={'1':{class_type:'Fixture',inputs:{}}},workflow={schemaVersion:2,id:randomUUID(),productionId:p.id,modelProfile:'moss-image-sft-int8-v1',graph,sha256:digest(graph),rationale:'fixture'};
  const bound=productions.bindWorkflow(p.id,'owner',0,workflow);
  const input={requestId:randomUUID(),expectedRevision:bound.revision,workflowId:workflow.id,prompt:'adult portrait',negativePrompt:'text',seed:'42',width:512,height:768,steps:25,enhancer};
  return {store,productions,p,workflow,input};
}

test('render rejection blocks a late exact request before creating a run',async t=>{
  const {store,productions,p,workflow,input}=fixture(t),bad={...input,width:1},path=`/api/productions/${p.id}/render`;let out;
  await productionRoute({req:{method:'POST',headers:{'x-dsh-session':'owner'}},res:{},path,url:new URL('http://local'+path),role:'dsh',store,productions,workflows:{get:async()=>workflow},body:async()=>bad,json:(_r,status,value)=>out={status,value}});
  assert.equal(out.status,400);assert.equal(out.value.receipt.operation,'render');assert.equal(out.value.receipt.payloadHash,digest(bad));
  assert.throws(()=>productions.render(p.id,'owner',input,workflow),e=>e.status===409);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM runs WHERE request_id=?').get(input.requestId).n,0);
});

for(const enhancer of [false,true])test(`legacy render receipt binds exact input with enhancer=${enhancer}`,t=>{
  const {store,productions,p,workflow,input}=fixture(t,enhancer),created=productions.render(p.id,'owner',input,workflow);
  assert.equal(created.receipt.payloadHash,digest(input));assert.equal(created.receipt.runId,created.run.id);
  const same=productions.render(p.id,'owner',input,workflow);assert.equal(same.created,false);assert.equal(same.run.id,created.run.id);
  assert.throws(()=>productions.findRenderByRequest(p.id,'foreign',input.requestId),e=>e.status===404);
  assert.throws(()=>productions.render(p.id,'owner',{...input,expectedRevision:input.expectedRevision+1},workflow),e=>e.status===503);
  const found=productions.findRenderByRequest(p.id,'owner',input.requestId);assert.equal(found.receipt.payloadHash,digest(input));
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM legacy_render_receipts').get().n,1);
});

test('legacy enhancer accepts separate original/effective evidence and rejects modified PE evidence',t=>{
  const {store,productions,p,workflow,input}=fixture(t,true),created=productions.render(p.id,'owner',input,workflow),id=created.run.id,intent={id:randomUUID()},record={childExited:true,cleanupConfirmed:true};
  const effectiveSpec={...created.run.spec,prompt:'enhanced adult portrait',negativePrompt:'bad text'},specHash=digest(effectiveSpec);
  store.update(id,{enhancerStartIntent:intent,enhancerCleanup:{intentId:intent.id,confirmed:true,childExited:true},enhancement:record},'enhancer_cleanup_confirmed');
  store.update(id,{enhancement:record,effectiveSpec,specHash},'prompt_enhanced');
  const saved=productions.findRenderByRequest(p.id,'owner',input.requestId);assert.equal(saved.run.spec.prompt,'adult portrait');assert.equal(saved.run.effectiveSpec.prompt,'enhanced adult portrait');
  const event=store.db.prepare("SELECT seq FROM events WHERE run_id=? AND type='prompt_enhanced'").get(id);store.db.prepare('UPDATE events SET json=? WHERE seq=?').run('{}',event.seq);
  assert.throws(()=>productions.findRenderByRequest(p.id,'owner',input.requestId),e=>e.status===409);
});

test('legacy receipt detects original spec/production tampering and allows an independently recorded cancellation',t=>{
  const {store,productions,p,workflow,input}=fixture(t),created=productions.render(p.id,'owner',input,workflow),runId=created.run.id;
  productions.cancelWithReceipt(p.id,'owner',{requestId:randomUUID()},'cancel');
  assert.equal(productions.findRenderByRequest(p.id,'owner',input.requestId).cancellationReceipt?.disposition,'accepted');
  const stored=store.db.prepare('SELECT json,payload_hash FROM runs WHERE id=?').get(runId),run=JSON.parse(stored.json);run.spec.seed='99';run.specHash=digest(run.spec);
  store.db.prepare('UPDATE runs SET json=?,payload_hash=? WHERE id=?').run(JSON.stringify(run),run.specHash,runId);
  assert.throws(()=>productions.findRenderByRequest(p.id,'owner',input.requestId),e=>e.status===409);
});

test('legacy receipt failure rolls back run and post-commit read failure remains unknown',t=>{
  const {store,productions,p,workflow,input}=fixture(t);
  store.db.exec("CREATE TRIGGER reject_legacy_receipt BEFORE INSERT ON legacy_render_receipts BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END");
  assert.throws(()=>productions.render(p.id,'owner',input,workflow),/injected receipt failure/);
  assert.equal(productions.get(p.id,'owner').revision,input.expectedRevision);assert.equal(store.db.prepare('SELECT count(*) AS n FROM runs').get().n,0);
  store.db.exec('DROP TRIGGER reject_legacy_receipt');const find=productions.findRenderByRequest.bind(productions);
  productions.findRenderByRequest=()=>{const error=new Error('injected post-commit evidence failure');error.status=409;throw error;};
  assert.throws(()=>productions.render(p.id,'owner',input,workflow),e=>e.status===503);productions.findRenderByRequest=find;
  assert.equal(productions.findRenderByRequest(p.id,'owner',input.requestId).receipt.payloadHash,digest(input));assert.equal(store.db.prepare('SELECT count(*) AS n FROM runs').get().n,1);
});
