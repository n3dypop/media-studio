// Cancellation is a distinct event and may explain only one revision advance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer as reserve} from 'node:net';
import {mkdtemp,rm,lstat,readdir,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {RunStore,digest} from '../apps/controller/store.mjs';
import {ProductionStore} from '../apps/controller/productions.mjs';
import {createControllerServer} from '../apps/controller/http.mjs';
import {buildMossOfficialGraph} from '../apps/controller/moss-official.mjs';
import {buildQwen21Graph} from '../apps/controller/qwen21-workflow.mjs';
import {workflowGraphHash} from '../apps/controller/workflows.mjs';

async function noLinks(root){for(const e of await readdir(root,{withFileTypes:true})){const p=join(root,e.name),s=await lstat(p);assert.equal(s.isSymbolicLink(),false);if(s.isDirectory())await noLinks(p);else assert.equal(s.isFile(),true);}}
async function fixture(t,{disk=false}={}){
  const base=await realpath(tmpdir()),dir=await mkdtemp(join(base,'cancel-continuity-')),path=disk?join(dir,'state.sqlite'):':memory:';
  const store=new RunStore(path),productions=new ProductionStore(store),session='owner';
  const createId=randomUUID(),p=productions.create(session,{requestId:createId,brief:{request:'fixture',modelProfile:'qwen-photo-v1',mode:'t2i',criteria:[{id:'C1',description:'fixture'}],invariants:[]}}).production;
  const graph={'1':{class_type:'Fixture',inputs:{}}},w={id:randomUUID(),productionId:p.id,modelProfile:'qwen-photo-v1',graph,sha256:digest(graph),rationale:'fixture'},workflowId=randomUUID();
  function prepare(){const input={requestId:workflowId,expectedRevision:0},admission=productions.beginWorkflowPreparation(p.id,session,input);return productions.bindWorkflow(p.id,session,0,w,null,admission);}
  function evaluate(){const ready=prepare(),r=productions.render(p.id,session,{requestId:randomUUID(),expectedRevision:ready.revision,prompt:'fixture',seed:'42',width:512,height:768,steps:25,enhancer:false},w),artifactSha256='a'.repeat(64);
    store.update(r.run.id,{phase:'completed',artifacts:[{name:'fixture.png',mime:'image/png',sha256:artifactSha256}]});
    const input={requestId:randomUUID(),expectedRevision:r.production.revision,runId:r.run.id,specHash:r.run.specHash,artifactSha256,criteria:[{id:'C1',status:'unmet',evidence:'fixture'}],decision:'revise',nextChange:'change light'};
    return {input,value:productions.evaluate(p.id,session,input)};}
  const hold=reserve();await new Promise(ok=>hold.listen(0,'127.0.0.1',ok));const port=hold.address().port;await new Promise(ok=>hold.close(ok));
  const server=createControllerServer({store,productions,workflows:{get:async id=>{if(id!==w.id)throw Error('not found');return w;}},engine:{work:new Set()},token:'fixture-admin',dshToken:'fixture-dsh',port});await new Promise(ok=>server.listen(port,'127.0.0.1',ok));
  t.after(async()=>{server.closeAllConnections();await new Promise(ok=>server.close(ok));store.close();assert.equal(await realpath(dir),dir);assert.ok(resolve(dir).startsWith(resolve(base)+sep));await noLinks(dir);await rm(dir,{recursive:true});});
  const get=path=>fetch(`http://127.0.0.1:${port}${path}`,{headers:{Authorization:'Bearer fixture-dsh','X-DSH-Session':session}}),cancel=()=>productions.cancelWithReceipt(p.id,session,{requestId:randomUUID()},'cancel');
  return {p,store,productions,session,createId,workflowId,w,prepare,evaluate,get,cancel,path};
}

for(const stage of ['create','workflow','evaluate','iteration'])test(`${stage} reports only the immediately succeeding authenticated cancellation`,async t=>{
  const f=await fixture(t);let route;
  if(stage==='create')route=`/api/productions?requestId=${f.createId}`;
  if(stage==='workflow'){f.prepare();route=`/api/productions/${f.p.id}/workflow-by-request?requestId=${f.workflowId}`;}
  if(stage==='evaluate'||stage==='iteration'){
    const evaluated=f.evaluate();let operation='evaluate',requestId=evaluated.input.requestId;
    if(stage==='iteration'){operation='iteration';const input={requestId:randomUUID(),expectedRevision:evaluated.value.production.revision,sourceRunId:evaluated.value.evaluation.runId,category:'prompt',action:'regenerate',hypothesis:'fixture',preserve:['subject'],changes:['light'],comparison:'fixture'};f.productions.planIteration(f.p.id,f.session,input);requestId=input.requestId;}
    route=`/api/productions/${f.p.id}/operation-by-request?operation=${operation}&requestId=${requestId}`;
  }
  const cancelled=f.cancel(),response=await f.get(route);assert.equal(response.status,200,await response.clone().text());const body=await response.json();
  assert.deepEqual(body.cancellationReceipt,cancelled.receipt);assert.equal(body.cancellationReceipt.disposition,'accepted');assert.equal(body.cancellationReceipt.productionRevision,body.cancellationReceipt.previousRevision+1);
});

test('legacy or duplicate cancellation and an intervening production event never establish continuity',async t=>{
  for(const kind of ['legacy','duplicate','extra-event']){
    const f=await fixture(t);f.prepare();
    if(kind==='legacy')f.productions.cancel(f.p.id,f.session);else f.cancel();
    if(kind==='duplicate')f.cancel();if(kind==='extra-event')f.store.event(f.p.id,'fixture_extra',{});
    const response=await f.get(`/api/productions/${f.p.id}/workflow-by-request?requestId=${f.workflowId}`);assert.equal(response.status,409,kind);
  }
});

test('forged cancellation owner, audit hash or event and unrelated later changes do not establish continuity',async t=>{
  for(const kind of ['owner','hash','event','extra-revision']){
    const f=await fixture(t),e=f.evaluate(),cancelled=f.cancel(),id=cancelled.receipt.requestId;
    if(kind==='owner')f.store.db.prepare('UPDATE production_cancel_receipts SET session_id=? WHERE request_id=?').run('other',id);
    if(kind==='hash')f.store.db.prepare('UPDATE production_cancel_receipts SET receipt_hash=? WHERE request_id=?').run('0'.repeat(64),id);
    if(kind==='event')f.store.db.prepare("UPDATE events SET json='{}' WHERE seq=(SELECT event_seq FROM production_cancel_receipts WHERE request_id=?)").run(id);
    if(kind==='extra-revision'){const p=f.productions.get(f.p.id,f.session);p.revision++;f.productions.write(p,'fixture_extra');}
    const response=await f.get(`/api/productions/${f.p.id}/operation-by-request?operation=evaluate&requestId=${e.input.requestId}`);assert.equal(response.status,200);assert.equal((await response.json()).cancellationReceipt,undefined,kind);
  }
});

test('create lookup uses one snapshot even if another process cancels after its first read',async t=>{
  const f=await fixture(t,{disk:true}),original=f.productions.list.bind(f.productions);let called=false;
  f.productions.list=(...args)=>{const result=original(...args);if(!called){called=true;const code=`import {RunStore} from ${JSON.stringify(pathToFileURL(resolve('apps/controller/store.mjs')).href)};import {ProductionStore} from ${JSON.stringify(pathToFileURL(resolve('apps/controller/productions.mjs')).href)};const x=JSON.parse(process.env.CANCEL_CONTINUITY_FIXTURE),s=new RunStore(x.path);try{new ProductionStore(s).cancelWithReceipt(x.id,'owner',{requestId:x.requestId},'cancel');}finally{s.close();}`;const child=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',env:{...process.env,CANCEL_CONTINUITY_FIXTURE:JSON.stringify({path:f.path,id:f.p.id,requestId:randomUUID()})},windowsHide:true});assert.equal(child.status,0,child.stderr);}return result;};
  try{const first=f.productions.listWithCancellationEvidence(f.session,f.createId);assert.equal(first.productions[0].revision,0);assert.equal(first.cancellationReceipt,undefined);}finally{f.productions.list=original;}
  const second=f.productions.listWithCancellationEvidence(f.session,f.createId);assert.equal(second.productions[0].revision,1);assert.equal(second.cancellationReceipt?.disposition,'accepted');
});

async function preparedFixture(t,{family='moss',disk=false}={}){
  const base=await realpath(tmpdir()),dir=await mkdtemp(join(base,'prepared-cancel-continuity-')),path=disk?join(dir,'state.sqlite'):':memory:';
  const store=new RunStore(path),productions=new ProductionStore(store),session='owner',profile=family==='moss'?'moss-image-sft-official-v1':'qwen-image-2.1-base-v1';
  const p=productions.create(session,{requestId:randomUUID(),modelProfile:profile,brief:{request:'fixture',criteria:[{id:'C1',description:'fixture'}],invariants:[]}}).production;
  const request={modelProfile:profile,mode:'t2i',prompt:'fixture',negativePrompt:'',seed:'42',width:768,height:1024,steps:25,inputAssets:[],...(family==='qwen'?{variant:'base',sessionId:session}:{})};
  const built=family==='moss'?buildMossOfficialGraph(request):buildQwen21Graph(request),w={schemaVersion:family==='moss'?4:5,id:randomUUID(),productionId:p.id,modelProfile:profile,mode:'t2i',inputAssetIds:[],request,graph:built.graph,output:built.output,sha256:workflowGraphHash(built.graph),rationale:'fixture'};
  const ready=productions.bindWorkflow(p.id,session,0,w),requestId=randomUUID(),rendered=productions.renderPrepared(p.id,session,{requestId,workflowId:w.id,expectedRevision:ready.revision},w);
  const hold=reserve();await new Promise(ok=>hold.listen(0,'127.0.0.1',ok));const port=hold.address().port;await new Promise(ok=>hold.close(ok));
  let snapshot=w;const server=createControllerServer({store,productions,workflows:{get:async()=>snapshot},engine:{work:new Set()},token:'fixture-admin',dshToken:'fixture-dsh',port});await new Promise(ok=>server.listen(port,'127.0.0.1',ok));
  t.after(async()=>{server.closeAllConnections();await new Promise(ok=>server.close(ok));store.close();assert.equal(await realpath(dir),dir);assert.ok(resolve(dir).startsWith(resolve(base)+sep));await noLinks(dir);await rm(dir,{recursive:true});});
  const get=(owner=session)=>fetch(`http://127.0.0.1:${port}/api/productions/${p.id}/run-by-request?requestId=${requestId}`,{headers:{Authorization:'Bearer fixture-dsh','X-DSH-Session':owner}}),cancel=()=>productions.cancelWithReceipt(p.id,session,{requestId:randomUUID()},'cancel');
  return {store,productions,p,w,rendered,requestId,session,get,cancel,path,setSnapshot:value=>{snapshot=value;}};
}

for(const family of ['moss','qwen'])test(`${family} prepared replay requires the exact original body and workflow snapshot`,async t=>{
  const f=await preparedFixture(t,{family}),input={requestId:f.requestId,workflowId:f.w.id,expectedRevision:f.rendered.run.productionRevision-1};
  const replay=f.productions.renderPrepared(f.p.id,f.session,input,f.w);assert.equal(replay.created,false);assert.equal(replay.run.id,f.rendered.run.id);assert.equal(replay.receipt.payloadHash,digest(input));
  assert.throws(()=>f.productions.renderPrepared(f.p.id,f.session,{...input,expectedRevision:input.expectedRevision+1},f.w),e=>e.status===503);
  assert.throws(()=>f.productions.renderPrepared(f.p.id,f.session,{...input,workflowId:randomUUID()},f.w),e=>e.status===503);
  assert.throws(()=>f.productions.renderPrepared(f.p.id,f.session,input,{...f.w,rationale:'different snapshot'}),e=>e.status===503);
  assert.throws(()=>f.productions.renderPrepared(f.p.id,f.session,{...input,requestId:randomUUID()},f.w),e=>e.status===409);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM runs').get().n,1);
});

test('a historical prepared run without original body evidence remains readable but cannot prove POST replay',async t=>{
  const f=await preparedFixture(t),input={requestId:f.requestId,workflowId:f.w.id,expectedRevision:f.rendered.run.productionRevision-1};
  f.store.db.prepare('DELETE FROM prepared_render_receipts WHERE request_id=?').run(f.requestId);
  assert.throws(()=>f.productions.renderPrepared(f.p.id,f.session,input,f.w),e=>e.status===503);
  const read=await f.get();assert.equal(read.status,200);assert.equal((await read.json()).run.id,f.rendered.run.id);
});

test('a prepared render audit prevents rebaselining if its receipt and all production markers disappear',async t=>{
  const f=await preparedFixture(t);f.store.db.exec("DELETE FROM prepared_render_receipts; DELETE FROM meta WHERE key IN ('productionReceiptSchema:v1','productionReceiptManifest:v1','productionMutationRejections:v1','productionMutationManifest:v1')");
  assert.throws(()=>new ProductionStore(f.store),/Prepared render receipt audit has no matching record/);
});

test('prepared receipt and render event tampering cannot prove replay',async t=>{
  const f=await preparedFixture(t),input={requestId:f.requestId,workflowId:f.w.id,expectedRevision:f.rendered.run.productionRevision-1};
  f.store.db.prepare("UPDATE events SET json='{}' WHERE seq=(SELECT event_seq FROM prepared_render_receipts WHERE request_id=?)").run(f.requestId);
  assert.throws(()=>f.productions.renderPrepared(f.p.id,f.session,input,f.w),e=>e.status===503);
});

test('prepared replay in an independent process checks the exact stored revision and body',async t=>{
  const f=await preparedFixture(t,{disk:true}),input={requestId:f.requestId,workflowId:f.w.id,expectedRevision:f.rendered.run.productionRevision-1};
  const script=`import {RunStore} from ${JSON.stringify(pathToFileURL(resolve('apps/controller/store.mjs')).href)};import {ProductionStore} from ${JSON.stringify(pathToFileURL(resolve('apps/controller/productions.mjs')).href)};const v=JSON.parse(process.env.PREPARED_REPLAY_FIXTURE),s=new RunStore(v.path),p=new ProductionStore(s);try{const ok=p.renderPrepared(v.id,'owner',v.input,v.workflow);let altered='accepted';try{p.renderPrepared(v.id,'owner',{...v.input,expectedRevision:v.input.expectedRevision+1},v.workflow);}catch(e){altered=String(e.status);}console.log(JSON.stringify({runId:ok.run.id,created:ok.created,altered}));}finally{s.close();}`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',env:{...process.env,PREPARED_REPLAY_FIXTURE:JSON.stringify({path:f.path,id:f.p.id,input,workflow:f.w})},windowsHide:true});assert.equal(child.status,0,child.stderr);
  const result=JSON.parse(child.stdout);assert.equal(result.runId,f.rendered.run.id);assert.equal(result.created,false);assert.equal(result.altered,'503');
});

for(const family of ['moss','qwen'])test(`${family} prepared run returns a single subsequent cancellation receipt`,async t=>{
  const f=await preparedFixture(t,{family}),cancelled=f.cancel(),response=await f.get();assert.equal(response.status,200,await response.clone().text());
  const body=await response.json();assert.equal(body.run.id,f.rendered.run.id);assert.deepEqual(body.cancellationReceipt,cancelled.receipt);assert.equal((await f.get('foreign')).status,404);
  f.setSnapshot({...f.w,request:{...f.w.request,prompt:'changed'}});assert.equal((await f.get()).status,409);
});

test('prepared cancellation receipt is absent for run, spec, workflow, event, owner and extra-cancellation inconsistencies',async t=>{
  for(const kind of ['id','spec','sql-hash','event','workflow','owner','duplicate','extra']){
    const f=await preparedFixture(t),c=f.cancel(),run=f.store.get(f.rendered.run.id);
    if(kind==='id')run.id=randomUUID();if(kind==='spec')run.spec.prompt='changed';if(kind==='workflow')run.spec.workflow.graph={};if(kind==='owner')run.sessionId='foreign';
    if(['id','spec','workflow','owner'].includes(kind))f.store.db.prepare('UPDATE runs SET json=? WHERE id=?').run(JSON.stringify(run),f.rendered.run.id);
    if(kind==='sql-hash')f.store.db.prepare('UPDATE runs SET payload_hash=? WHERE id=?').run('0'.repeat(64),run.id);
    if(kind==='event')f.store.db.prepare("UPDATE events SET json='{}' WHERE run_id=? AND type='render_requested'").run(f.p.id);
    if(kind==='duplicate')f.cancel();if(kind==='extra')f.store.event(f.p.id,'fixture_extra',{});
    const response=await f.get();if(response.status===200)assert.equal((await response.json()).cancellationReceipt,undefined,kind);else assert.ok([404,409].includes(response.status),`${kind}: ${response.status}`);
    assert.equal(c.receipt.disposition,'accepted');
  }
});

test('prepared run lookup reads one snapshot during another process cancellation',async t=>{
  const f=await preparedFixture(t,{disk:true}),original=f.productions.get.bind(f.productions);let called=false;
  f.productions.get=(...args)=>{const result=original(...args);if(!called){called=true;const code=`import {RunStore} from ${JSON.stringify(pathToFileURL(resolve('apps/controller/store.mjs')).href)};import {ProductionStore} from ${JSON.stringify(pathToFileURL(resolve('apps/controller/productions.mjs')).href)};const x=JSON.parse(process.env.CANCEL_CONTINUITY_FIXTURE),s=new RunStore(x.path);try{new ProductionStore(s).cancelWithReceipt(x.id,'owner',{requestId:x.requestId},'cancel');}finally{s.close();}`;const child=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',env:{...process.env,CANCEL_CONTINUITY_FIXTURE:JSON.stringify({path:f.path,id:f.p.id,requestId:randomUUID()})},windowsHide:true});assert.equal(child.status,0,child.stderr);}return result;};
  try{const first=f.productions.findRenderByRequest(f.p.id,f.session,f.requestId);assert.equal(first.production.cancelRequested,false);assert.equal(first.run.cancelRequested,false);assert.equal(first.cancellationReceipt,undefined);}finally{f.productions.get=original;}
  const second=await f.get();assert.equal(second.status,200);assert.equal((await second.json()).cancellationReceipt?.disposition,'accepted');
});
