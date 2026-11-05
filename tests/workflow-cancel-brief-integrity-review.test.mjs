// Independent read-only review of production brief and receipt continuity.
// All writes here target a fresh in-memory fixture, never a user's database.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer as reserve} from 'node:net';
import {RunStore,digest} from '../apps/controller/store.mjs';
import {ProductionStore} from '../apps/controller/productions.mjs';
import {createControllerServer} from '../apps/controller/http.mjs';
import {buildMossOfficialGraph} from '../apps/controller/moss-official.mjs';
import {workflowGraphHash} from '../apps/controller/workflows.mjs';
import {verifyCreateReceipt,verifyWorkflowReceipt,verifyActionReceipt,verifyPreparedRenderReceipt} from '../apps/dsh-plugins/local-genai/durable-receipts.mjs';

const owner='owner';
async function fixture(t,{official=false}={}){
  const store=new RunStore(':memory:'),productions=new ProductionStore(store),profile=official?'moss-image-sft-official-v1':'qwen-photo-v1';
  const createId=randomUUID(),p=productions.create(owner,{requestId:createId,modelProfile:profile,brief:{request:'original request',criteria:[{id:'C1',description:'original criterion'}],invariants:[]}}).production;
  const request=official?{modelProfile:profile,mode:'t2i',prompt:'portrait',negativePrompt:'',seed:'42',width:768,height:1024,steps:25,inputAssets:[]}:null;
  const built=official?buildMossOfficialGraph(request):null,graph=built?.graph??{'1':{class_type:'Fixture',inputs:{}}};
  const w={...(official?{schemaVersion:4,inputAssetIds:[],request,output:built.output}:{}),id:randomUUID(),productionId:p.id,modelProfile:profile,mode:'t2i',graph,sha256:workflowGraphHash(graph),rationale:'fixture'};
  const workflowId=randomUUID(),workflowInput={requestId:workflowId,expectedRevision:0};
  const prep=productions.beginWorkflowPreparation(p.id,owner,workflowInput);productions.bindWorkflow(p.id,owner,0,w,null,prep);
  const holder=reserve();await new Promise(ok=>holder.listen(0,'127.0.0.1',ok));const port=holder.address().port;await new Promise(ok=>holder.close(ok));
  const server=createControllerServer({store,productions,workflows:{get:async id=>{if(id!==w.id)throw Error('not found');return w;}},engine:{work:new Set()},token:'fixture-admin',dshToken:'fixture-dsh',port});await new Promise(ok=>server.listen(port,'127.0.0.1',ok));
  t.after(async()=>{server.closeAllConnections();await new Promise(ok=>server.close(ok));store.close();});
  const get=path=>fetch(`http://127.0.0.1:${port}${path}`,{headers:{Authorization:'Bearer fixture-dsh','X-DSH-Session':owner}});
  const cancel=()=>productions.cancelWithReceipt(p.id,owner,{requestId:randomUUID()},'cancel');
  const alterBrief=()=>{const current=productions.get(p.id,owner);current.brief.request='changed without its original receipt';current.briefHash=digest(current.brief);store.db.prepare('UPDATE productions SET json=? WHERE id=?').run(JSON.stringify(current),p.id);};
  return {store,productions,p,w,workflowInput,workflowId,createId,get,cancel,alterBrief};
}

for(const cancelled of [false,true])test(`workflow brief tampering is rejected ${cancelled?'after cancellation':'before cancellation'}`,async t=>{
  const f=await fixture(t);if(cancelled)f.cancel();f.alterBrief();
  const response=await f.get(`/api/productions/${f.p.id}/workflow-by-request?requestId=${f.workflowId}`);
  if(response.status===200){const value=await response.json(),intent={operation:'workflow-draft',sessionId:owner,requestId:f.workflowId,inputHash:digest(f.workflowInput),targetId:f.p.id};assert.throws(()=>verifyWorkflowReceipt(intent,owner,value),/unresolved/);}
  else assert.ok([404,409].includes(response.status),`unexpected status ${response.status}`);
});

test('create cancellation evidence rejects a changed saved brief',async t=>{
  // Create cancellation continuity has no intervening workflow selection.
  const store=new RunStore(':memory:'),ps=new ProductionStore(store),requestId=randomUUID();t.after(()=>store.close());
  const p=ps.create(owner,{requestId,modelProfile:'qwen-photo-v1',brief:{request:'original',criteria:[{id:'C1',description:'original'}],invariants:[]}}).production,correlationHash=p.briefHash;
  ps.cancelWithReceipt(p.id,owner,{requestId:randomUUID()},'cancel');const changed=ps.get(p.id,owner);changed.brief.request='changed';changed.briefHash=digest(changed.brief);store.db.prepare('UPDATE productions SET json=? WHERE id=?').run(JSON.stringify(changed),p.id);
  const value=ps.listWithCancellationEvidence(owner,requestId),intent={operation:'create',sessionId:owner,requestId,inputHash:'a'.repeat(64),correlationHash,targetId:null};
  assert.equal(value.cancellationReceipt,undefined);assert.throws(()=>verifyCreateReceipt(intent,owner,value),/unresolved/);
});

test('evaluation cancellation continuity rejects a changed saved brief',async t=>{
  const f=await fixture(t),input={requestId:randomUUID(),expectedRevision:1,prompt:'fixture',seed:'42',width:512,height:768,steps:25,enhancer:false};
  const rendered=f.productions.render(f.p.id,owner,input,f.w),artifactSha256='a'.repeat(64);
  f.store.update(rendered.run.id,{phase:'completed',artifacts:[{name:'fixture.png',mime:'image/png',sha256:artifactSha256}]});
  const evaluation={requestId:randomUUID(),expectedRevision:rendered.production.revision,runId:rendered.run.id,specHash:rendered.run.specHash,artifactSha256,criteria:[{id:'C1',status:'unmet',evidence:'fixture'}],decision:'revise',nextChange:'improve'};
  f.productions.evaluate(f.p.id,owner,evaluation);f.cancel();f.alterBrief();
  const response=await f.get(`/api/productions/${f.p.id}/operation-by-request?operation=evaluate&requestId=${evaluation.requestId}`);
  if(response.status===200){const value=await response.json(),intent={operation:'evaluate',sessionId:owner,requestId:evaluation.requestId,inputHash:digest(evaluation),targetId:f.p.id};assert.throws(()=>verifyActionReceipt(intent,owner,value),/unresolved/);}
  else assert.ok([404,409].includes(response.status),`unexpected status ${response.status}`);
});

test('prepared render cancellation continuity rejects a changed saved brief',async t=>{
  const f=await fixture(t,{official:true}),input={workflowId:f.w.id,expectedRevision:1,requestId:randomUUID()},rendered=f.productions.renderPrepared(f.p.id,owner,input,f.w);
  f.cancel();f.alterBrief();const response=await f.get(`/api/productions/${f.p.id}/run-by-request?requestId=${input.requestId}`);
  if(response.status===200){const value=await response.json(),intent={operation:'prepared-render',sessionId:owner,requestId:input.requestId,inputHash:digest(input),targetId:f.p.id};assert.equal(value.cancellationReceipt,undefined);assert.throws(()=>verifyPreparedRenderReceipt(intent,owner,value),/unresolved/);}
  else assert.ok([404,409].includes(response.status),`unexpected status ${response.status}`);
  assert.equal(rendered.run.id,f.productions.get(f.p.id,owner).latestRunId);
});
