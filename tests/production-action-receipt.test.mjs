import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {RunStore,digest} from '../apps/controller/store.mjs';
import {ProductionStore} from '../apps/controller/productions.mjs';
import {productionRoute} from '../apps/controller/production-http.mjs';

async function fixture(t,{disk=false}={}){
  const base=join(tmpdir(),'media-studio-action-receipts');await mkdir(base,{recursive:true});
  const root=await mkdtemp(join(base,'case-')),path=disk?join(root,'state.sqlite'):':memory:';
  const store=new RunStore(path),productions=new ProductionStore(store);
  t.after(async()=>{store.close();assert.ok(resolve(root).startsWith(resolve(base)+sep));await rm(root,{recursive:true,force:true});});
  const p=productions.create('owner',{requestId:randomUUID(),brief:{request:'portrait',modelProfile:'qwen-photo-v1',mode:'t2i',criteria:[{id:'C1',description:'portrait'}],invariants:[]}}).production;
  const graph={'1':{class_type:'Fixture',inputs:{}}},workflow={id:randomUUID(),productionId:p.id,modelProfile:'qwen-photo-v1',graph,sha256:digest(graph),rationale:'fixture'};
  const ready=productions.bindWorkflow(p.id,'owner',0,workflow);
  const rendered=productions.render(p.id,'owner',{requestId:randomUUID(),expectedRevision:ready.revision,prompt:'portrait',negativePrompt:'',seed:'42',width:512,height:768,steps:25,enhancer:false},workflow);
  const artifactSha256='a'.repeat(64);store.update(rendered.run.id,{phase:'completed',artifacts:[{name:'image.png',mime:'image/png',sha256:artifactSha256}]});
  const evaluate={requestId:randomUUID(),expectedRevision:rendered.production.revision,runId:rendered.run.id,specHash:rendered.run.specHash,artifactSha256,criteria:[{id:'C1',status:'unmet',evidence:'insufficient light'}],decision:'revise',nextChange:'adjust light'};
  return {root,path,store,productions,p,evaluate};
}
function iteration(evaluation){return {requestId:randomUUID(),expectedRevision:evaluation.production.revision,sourceRunId:evaluation.evaluation.runId,category:'prompt',action:'regenerate',hypothesis:'make light brighter',preserve:['portrait'],changes:['light'],comparison:'compare light'};}

test('evaluate and iteration receipts are durable, bound to the exact input, and replay without duplicate effects',async t=>{
  const f=await fixture(t,{disk:true}),{productions:p,store}=f;
  const evaluated=p.evaluate(f.p.id,'owner',f.evaluate),evReceipt=evaluated.receipt;
  assert.equal(evReceipt.payloadHash,digest(f.evaluate));assert.equal(evReceipt.expectedRevision,f.evaluate.expectedRevision);assert.equal(evReceipt.productionRevision,evReceipt.expectedRevision+1);assert.equal(evReceipt.resultId,evaluated.evaluation.id);
  const re=p.evaluate(f.p.id,'owner',f.evaluate);assert.equal(re.created,false);assert.equal(re.evaluation.id,evaluated.evaluation.id);
  const planInput=iteration(evaluated),planned=p.planIteration(f.p.id,'owner',planInput);assert.equal(planned.receipt.payloadHash,digest(planInput));
  assert.equal(p.planIteration(f.p.id,'owner',planInput).created,false);
  assert.equal(p.findActionByRequest(f.p.id,'owner','evaluate',f.evaluate.requestId).evaluation.id,evaluated.evaluation.id);
  assert.equal(p.findActionByRequest(f.p.id,'owner','iteration',planInput.requestId).plan.id,planned.plan.id);
  assert.throws(()=>p.evaluate(f.p.id,'owner',{...f.evaluate,nextChange:'changed'}),error=>error.status===409);
  assert.throws(()=>p.planIteration(f.p.id,'owner',{...planInput,requestId:f.evaluate.requestId}),error=>error.status===409);
  assert.throws(()=>p.findActionByRequest(f.p.id,'foreign','evaluate',f.evaluate.requestId),error=>error.status===404);
  assert.throws(()=>p.findActionByRequest(f.p.id,'owner','iteration',f.evaluate.requestId),error=>error.status===404);
  assert.throws(()=>p.findActionByRequest(f.p.id,'owner','evaluate',randomUUID()),error=>error.status===404&&/未観測/.test(error.message));
  assert.throws(()=>p.findActionByRequest(f.p.id,'owner','evaluate','bad'),error=>error.status===400);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM production_action_receipts').get().n,2);
  const reopenedStore=new RunStore(f.path),reopened=new ProductionStore(reopenedStore);
  try{assert.equal(reopened.findActionByRequest(f.p.id,'owner','iteration',planInput.requestId).plan.id,planned.plan.id);assert.equal(reopened.evaluate(f.p.id,'owner',f.evaluate).created,false);}finally{reopenedStore.close();}
});

test('legacy calls without requestId retain their prior API shape and do not pretend to have a receipt',async t=>{
  const f=await fixture(t),{requestId,...old}=f.evaluate,result=f.productions.evaluate(f.p.id,'owner',old);
  assert.equal(result.receipt,undefined);assert.equal(result.created,undefined);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM production_action_receipts').get().n,0);
});

test('receipt write failure rolls back evaluation, production revision and event together',async t=>{
  const f=await fixture(t),before=f.productions.get(f.p.id,'owner').revision;
  f.store.db.exec("CREATE TRIGGER reject_action_receipt BEFORE INSERT ON production_action_receipts BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END");
  assert.throws(()=>f.productions.evaluate(f.p.id,'owner',f.evaluate),/injected receipt failure/);
  assert.equal(f.productions.get(f.p.id,'owner').revision,before);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM evaluations').get().n,0);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM events WHERE type='image_evaluated'").get().n,0);
});

test('receipt lookup rejects modified results, events and evaluation rows',async t=>{
  const f=await fixture(t),result=f.productions.evaluate(f.p.id,'owner',f.evaluate);
  f.store.db.prepare('UPDATE evaluations SET json=? WHERE id=?').run('{}',result.evaluation.id);
  assert.throws(()=>f.productions.findActionByRequest(f.p.id,'owner','evaluate',f.evaluate.requestId),error=>error.status===409);
  assert.throws(()=>f.productions.evaluate(f.p.id,'owner',f.evaluate),error=>error.status===409,'idempotent replay must not bypass integrity checks');
});

test('iteration receipt checks the source evaluation and rejects changed source records',async t=>{
  const f=await fixture(t),evaluated=f.productions.evaluate(f.p.id,'owner',f.evaluate),input=iteration(evaluated);
  f.productions.planIteration(f.p.id,'owner',input);
  f.store.db.prepare('UPDATE evaluations SET json=? WHERE id=?').run('{}',evaluated.evaluation.id);
  assert.throws(()=>f.productions.findActionByRequest(f.p.id,'owner','iteration',input.requestId),error=>error.status===409);
  assert.throws(()=>f.productions.planIteration(f.p.id,'owner',input),error=>error.status===409);
});

test('GET receipt reads one SQLite snapshot across a concurrent writer',async t=>{
  const f=await fixture(t,{disk:true}),evaluated=f.productions.evaluate(f.p.id,'owner',f.evaluate),originalGet=f.store.get.bind(f.store);
  let changed=false;
  f.store.get=id=>{
    if(!changed){changed=true;const script=`import {DatabaseSync} from 'node:sqlite';const d=JSON.parse(process.env.SNAPSHOT_FIXTURE),db=new DatabaseSync(d.path);const row=db.prepare('SELECT json FROM runs WHERE id=?').get(d.id),run=JSON.parse(row.json);run.artifacts[0].sha256='b'.repeat(64);db.prepare('UPDATE runs SET json=? WHERE id=?').run(JSON.stringify(run),d.id);db.close();`;
      const child=spawnSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,SNAPSHOT_FIXTURE:JSON.stringify({path:f.path,id})},encoding:'utf8',windowsHide:true});assert.equal(child.status,0,child.stderr);}
    return originalGet(id);
  };
  try{assert.equal(f.productions.findActionByRequest(f.p.id,'owner','evaluate',f.evaluate.requestId).evaluation.id,evaluated.evaluation.id);}finally{f.store.get=originalGet;}
  assert.equal(changed,true);assert.throws(()=>f.productions.findActionByRequest(f.p.id,'owner','evaluate',f.evaluate.requestId),error=>error.status===409,'next snapshot observes the changed artifact');
});

test('HTTP route only reads the owned receipt and rejects ambiguous queries',async t=>{
  const f=await fixture(t),result=f.productions.evaluate(f.p.id,'owner',f.evaluate);
  async function call(session,query){let output;await productionRoute({req:{method:'GET',headers:{'x-dsh-session':session}},res:{},path:`/api/productions/${f.p.id}/operation-by-request`,url:new URL('http://local/'+query),role:'dsh',store:f.store,engine:{},productions:f.productions,workflows:{},body:async()=>({}),json:(_res,status,value)=>{output={status,value};}});return output;}
  const response=await call('owner',`?operation=evaluate&requestId=${f.evaluate.requestId}`);assert.equal(response.status,200);assert.equal(response.value.evaluation.id,result.evaluation.id);
  await assert.rejects(call('foreign',`?operation=evaluate&requestId=${f.evaluate.requestId}`),error=>error.status===404);
  await assert.rejects(call('owner',`?operation=evaluate&requestId=${f.evaluate.requestId}&requestId=${f.evaluate.requestId}`),error=>error.status===400);
});

test('two Controller processes commit one receipt and one evaluation for the same request',async t=>{
  const f=await fixture(t,{disk:true}),data={path:f.path,id:f.p.id,input:f.evaluate};
  const script=`import {RunStore} from ${JSON.stringify(pathToFileURL(resolve('apps/controller/store.mjs')).href)};import {ProductionStore} from ${JSON.stringify(pathToFileURL(resolve('apps/controller/productions.mjs')).href)};const d=JSON.parse(process.env.ACTION_RECEIPT_FIXTURE),s=new RunStore(d.path);try{console.log(JSON.stringify(new ProductionStore(s).evaluate(d.id,'owner',d.input)));}finally{s.close();}`;
  const run=()=>new Promise((done,fail)=>{const child=spawn(process.execPath,['--input-type=module','-e',script],{env:{...process.env,ACTION_RECEIPT_FIXTURE:JSON.stringify(data)},stdio:['ignore','pipe','pipe'],windowsHide:true});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',fail);child.on('exit',code=>{if(code!==0)fail(new Error(err));else done(JSON.parse(out));});});
  const [a,b]=await Promise.all([run(),run()]);assert.equal(a.evaluation.id,b.evaluation.id);assert.deepEqual([a.created,b.created].sort(),[false,true]);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM evaluations').get().n,1);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM production_action_receipts').get().n,1);
});
