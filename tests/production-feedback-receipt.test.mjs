import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {RunStore,digest} from '../apps/controller/store.mjs';
import {ProductionStore} from '../apps/controller/productions.mjs';
import {productionRoute} from '../apps/controller/production-http.mjs';

function fixture(t){
  const store=new RunStore(':memory:'),p=new ProductionStore(store);t.after(()=>store.close());
  const production=p.create('owner',{requestId:randomUUID(),brief:{request:'portrait',modelProfile:'qwen-photo-v1',mode:'t2i',criteria:[{id:'C1',description:'portrait'}],invariants:[]}}).production;
  const graph={'1':{class_type:'Fixture',inputs:{}}},workflow={id:randomUUID(),productionId:production.id,modelProfile:'qwen-photo-v1',graph,sha256:digest(graph),rationale:'fixture'};
  const ready=p.bindWorkflow(production.id,'owner',0,workflow),render=p.render(production.id,'owner',{requestId:randomUUID(),expectedRevision:ready.revision,prompt:'portrait',negativePrompt:'',seed:'42',width:512,height:768,steps:25,enhancer:false},workflow);
  const artifact='a'.repeat(64);store.update(render.run.id,{phase:'completed',artifacts:[{name:'image.png',mime:'image/png',sha256:artifact}]});
  const evaluated=p.evaluate(production.id,'owner',{requestId:randomUUID(),expectedRevision:render.production.revision,runId:render.run.id,specHash:render.run.specHash,artifactSha256:artifact,criteria:[{id:'C1',status:'unverified',evidence:'requires user judgment'}],decision:'needs_user'});
  const input={requestId:randomUUID(),expectedRevision:evaluated.production.revision,sourceRunId:render.run.id,feedback:'Make the light warmer'};
  return {store,p,production,render,input};
}

test('feedback is recorded with an atomic owner- and payload-bound receipt and replays once',t=>{
  const {store,p,production,input}=fixture(t),created=p.resumeWithFeedback(production.id,'owner',input);
  assert.equal(created.receipt.payloadHash,digest(input));assert.equal(created.receipt.operation,'feedback');assert.equal(created.receipt.productionRevision,input.expectedRevision+1);
  const read=p.findActionByRequest(production.id,'owner','feedback',input.requestId);assert.equal(read.feedback.id,created.feedback.id);
  assert.equal(p.resumeWithFeedback(production.id,'owner',input).created,false);
  assert.throws(()=>p.resumeWithFeedback(production.id,'owner',{...input,feedback:'different'}),e=>e.status===409);
  assert.throws(()=>p.resumeWithFeedback(production.id,'owner',{...input,expectedRevision:input.expectedRevision+1}),e=>e.status===409);
  assert.throws(()=>p.findActionByRequest(production.id,'foreign','feedback',input.requestId),e=>e.status===404);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM production_action_receipts WHERE operation='feedback'").get().n,1);
});

test('feedback receipt detects modified feedback, event and source evaluation',t=>{
  const {store,p,production,input}=fixture(t),created=p.resumeWithFeedback(production.id,'owner',input);
  const original=store.db.prepare('SELECT json FROM productions WHERE id=?').get(production.id).json;
  const modified=JSON.parse(original);modified.feedbackRequests[0].feedback='forged';store.db.prepare('UPDATE productions SET json=? WHERE id=?').run(JSON.stringify(modified),production.id);
  assert.throws(()=>p.findActionByRequest(production.id,'owner','feedback',input.requestId),e=>e.status===409);
  store.db.prepare('UPDATE productions SET json=? WHERE id=?').run(original,production.id);
  const evalId=JSON.parse(original).evaluations[0].id;store.db.prepare('UPDATE evaluations SET json=? WHERE id=?').run('{}',evalId);
  assert.throws(()=>p.findActionByRequest(production.id,'owner','feedback',input.requestId),e=>e.status===409);
  assert.equal(created.feedback.sourceRunId,input.sourceRunId);
});

test('failure writing the receipt rolls back feedback and production revision',t=>{
  const {store,p,production,input}=fixture(t);
  store.db.exec("CREATE TRIGGER reject_feedback_receipt BEFORE INSERT ON production_action_receipts WHEN NEW.operation='feedback' BEGIN SELECT RAISE(ABORT,'injected feedback receipt failure'); END");
  assert.throws(()=>p.resumeWithFeedback(production.id,'owner',input),/injected feedback receipt failure/);
  const saved=p.get(production.id,'owner');assert.equal(saved.revision,input.expectedRevision);assert.equal(saved.feedbackRequests?.length??0,0);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM events WHERE type='user_feedback_recorded'").get().n,0);
});

test('feedback lookup survives resultRunId enrichment and reflects a separately verified cancellation',t=>{
  const {store,p,production,input}=fixture(t),created=p.resumeWithFeedback(production.id,'owner',input);
  const row=p.get(production.id,'owner');row.feedbackRequests[0].resultRunId=randomUUID();store.db.prepare('UPDATE productions SET json=? WHERE id=?').run(JSON.stringify(row),production.id);
  assert.equal(p.findActionByRequest(production.id,'owner','feedback',input.requestId).feedback.id,created.feedback.id);
  p.cancelWithReceipt(production.id,'owner',{requestId:randomUUID()},'cancel');
  const recovered=p.findActionByRequest(production.id,'owner','feedback',input.requestId);
  assert.equal(recovered.feedback.id,created.feedback.id);assert.equal(recovered.cancellationReceipt?.disposition,'accepted');
});

test('feedback read route rejects other sessions and ambiguous request IDs',async t=>{
  const {store,p,production,input}=fixture(t);p.resumeWithFeedback(production.id,'owner',input);
  async function call(owner,query){let result;await productionRoute({req:{method:'GET',headers:{'x-dsh-session':owner}},res:{},path:`/api/productions/${production.id}/operation-by-request`,url:new URL('http://local/'+query),role:'dsh',store,engine:{},productions:p,workflows:{},body:async()=>({}),json:(_res,status,value)=>{result={status,value};}});return result;}
  assert.equal((await call('owner',`?operation=feedback&requestId=${input.requestId}`)).status,200);
  await assert.rejects(call('foreign',`?operation=feedback&requestId=${input.requestId}`),e=>e.status===404);
  await assert.rejects(call('owner',`?operation=feedback&requestId=${input.requestId}&requestId=${input.requestId}`),e=>e.status===400);
});

test('legacy short feedback IDs preserve original response and replay without inventing a receipt',t=>{
  const {store,p,production,input}=fixture(t),legacy={...input,requestId:'legacy'},result=p.resumeWithFeedback(production.id,'owner',legacy);
  assert.equal(result.receipt,undefined);assert.equal(result.created,true);
  const replay=p.resumeWithFeedback(production.id,'owner',{...legacy,expectedRevision:legacy.expectedRevision+1});
  assert.equal(replay.created,false);assert.equal(replay.feedback.id,result.feedback.id);assert.equal(replay.receipt,undefined);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM production_action_receipts WHERE operation='feedback'").get().n,0);
});
