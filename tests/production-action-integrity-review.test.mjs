// Independent negative cases for controller action-receipt evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {RunStore,digest} from '../apps/controller/store.mjs';
import {ProductionStore} from '../apps/controller/productions.mjs';

function fixture(t){
  const store=new RunStore(':memory:'),productions=new ProductionStore(store);t.after(()=>store.close());
  const p=productions.create('owner',{requestId:randomUUID(),brief:{request:'portrait',modelProfile:'qwen-photo-v1',mode:'t2i',criteria:[{id:'C1',description:'portrait'}],invariants:[]}}).production;
  const graph={'1':{class_type:'Fixture',inputs:{}}},workflow={id:randomUUID(),productionId:p.id,modelProfile:'qwen-photo-v1',graph,sha256:digest(graph),rationale:'fixture'};
  const ready=productions.bindWorkflow(p.id,'owner',0,workflow);
  const rendered=productions.render(p.id,'owner',{requestId:randomUUID(),expectedRevision:ready.revision,prompt:'portrait',negativePrompt:'',seed:'42',width:512,height:768,steps:25,enhancer:false},workflow);
  const artifactSha256='a'.repeat(64);store.update(rendered.run.id,{phase:'completed',artifacts:[{name:'image.png',mime:'image/png',sha256:artifactSha256}]});
  const input={requestId:randomUUID(),expectedRevision:rendered.production.revision,runId:rendered.run.id,specHash:rendered.run.specHash,artifactSha256,criteria:[{id:'C1',status:'unmet',evidence:'insufficient light'}],decision:'revise',nextChange:'adjust light'};
  const evaluation=productions.evaluate(p.id,'owner',input);
  const iteration={requestId:randomUUID(),expectedRevision:evaluation.production.revision,sourceRunId:evaluation.evaluation.runId,category:'prompt',action:'regenerate',hypothesis:'make light brighter',preserve:['portrait'],changes:['light'],comparison:'compare light'};
  productions.planIteration(p.id,'owner',iteration);
  return {store,productions,p,input,iteration,runId:rendered.run.id};
}

for(const [label,modify] of [
  ['production JSON id',p=>p.id=randomUUID()],
  ['production JSON session',p=>p.sessionId='other-session'],
  ['production brief hash',p=>p.brief.request='different request'],
])test(`evaluate receipt must reject changed ${label}`,t=>{
  const f=fixture(t),p=f.productions.get(f.p.id,'owner');modify(p);
  f.store.db.prepare('UPDATE productions SET json=? WHERE id=?').run(JSON.stringify(p),f.p.id);
  assert.throws(()=>f.productions.findActionByRequest(f.p.id,'owner','evaluate',f.input.requestId),error=>error.status===409);
});

for(const [label,modify] of [
  ['run owner',run=>run.sessionId='other-session'],
  ['run production',run=>run.productionId=randomUUID()],
  ['run spec hash',run=>run.specHash='b'.repeat(64)],
  ['artifact hash',run=>run.artifacts[0].sha256='b'.repeat(64)],
])for(const operation of ['evaluate','iteration'])test(`${operation} receipt must reject changed ${label}`,t=>{
  const f=fixture(t),run=f.store.get(f.runId);modify(run);
  f.store.db.prepare('UPDATE runs SET json=? WHERE id=?').run(JSON.stringify(run),f.runId);
  assert.throws(()=>f.productions.findActionByRequest(f.p.id,'owner',operation,operation==='evaluate'?f.input.requestId:f.iteration.requestId),error=>error.status===409);
});
