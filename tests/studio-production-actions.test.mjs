import {tmpdir} from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {RunStore,digest} from '../apps/controller/store.mjs';
import {ProductionStore} from '../apps/controller/productions.mjs';
import {productionRoute} from '../apps/controller/production-http.mjs';
import {actionsHandler,ACTIONS_PATH} from '../apps/dsh-plugins/studio-controls/actions.mjs';
const artifact={name:'portrait.png',mime:'image/png',sha256:'a'.repeat(64),width:512,height:768};
async function fixture(t){
  const base=join(tmpdir(),'media-studio-tests');await mkdir(base,{recursive:true});const dir=await mkdtemp(join(base,'studio-decision-'));
  const store=new RunStore(join(dir,'store.db')),p=new ProductionStore(store);
  t.after(async()=>{store.close();assert.ok(resolve(dir).startsWith(base+sep));await rm(dir,{recursive:true,force:true});});
  const created=p.create('owner',{requestId:randomUUID(),brief:{request:'Adult portrait',modelProfile:'qwen-photo-v1',mode:'t2i',criteria:[{id:'visible',description:'Visible feature'}],invariants:[]}}).production;
  const graph={'1':{class_type:'Fixture',inputs:{prompt:'adult'}}},workflow={id:randomUUID(),productionId:created.id,modelProfile:'qwen-photo-v1',graph,sha256:digest(graph),rationale:'Fixture'};
  const ready=p.bindWorkflow(created.id,'owner',0,workflow);
  const rendered=p.render(ready.id,'owner',{requestId:randomUUID(),expectedRevision:ready.revision,prompt:'Adult portrait',negativePrompt:'',seed:'42',width:512,height:768,steps:25,enhancer:false},workflow);
  store.update(rendered.run.id,{phase:'completed',artifacts:[artifact]});
  const reviewed=p.evaluate(created.id,'owner',{expectedRevision:rendered.production.revision,runId:rendered.run.id,specHash:rendered.run.specHash,artifactSha256:artifact.sha256,criteria:[{id:'visible',status:'unverified',evidence:'Not shown'}],decision:'needs_user'}).production;
  const input={requestId:randomUUID(),expectedRevision:reviewed.revision,sourceRunId:rendered.run.id,artifactSha256:artifact.sha256,decision:'accept',feedback:''};
  return {store,p,reviewed,input};
}
test('user adoption is bound to the evaluated candidate and never rewrites uncertainty or agent completion',async t=>{
  const f=await fixture(t);
  assert.throws(()=>f.p.userDecision(f.reviewed.id,'foreign',f.input),/会話/);
  assert.throws(()=>f.p.userDecision(f.reviewed.id,'owner',{...f.input,artifactSha256:'b'.repeat(64)}),/成果物/);
  assert.throws(()=>f.p.userDecision(f.reviewed.id,'owner',{...f.input,expectedRevision:0}),/状態/);
  const accepted=f.p.userDecision(f.reviewed.id,'owner',f.input);
  assert.equal(accepted.production.phase,'needs_user');assert.equal(accepted.production.evaluations[0].criteria[0].status,'unverified');
  assert.equal(accepted.production.latestUserDecision.decision,'accept');assert.equal(accepted.production.attempts.length,1);
  const replay=f.p.userDecision(f.reviewed.id,'owner',f.input);assert.equal(replay.created,false);assert.equal(replay.production.userDecisions.length,1);
  assert.throws(()=>f.p.userDecision(f.reviewed.id,'owner',{...f.input,feedback:'changed'}),/requestId/);
});
test('rejection reopens the same production for planning and its durable delivery claim never creates a generation',async t=>{
  const f=await fixture(t),result=f.p.userDecision(f.reviewed.id,'owner',{...f.input,decision:'reject',feedback:'Keep the face; adjust light.'});
  assert.equal(result.production.phase,'revising');assert.equal(result.production.activeFeedback.sourceRunId,f.input.sourceRunId);
  assert.equal(result.production.attempts.length,1);assert.equal(result.production.evaluations[0].criteria[0].status,'unverified');
  const id=result.production.id,planningRequestId=result.decision.planningRequestId;
  assert.equal(f.p.planningDelivery(id,'owner',{planningRequestId,state:'sending'}).claimed,true);
  assert.equal(f.p.planningDelivery(id,'owner',{planningRequestId,state:'sending'}).claimed,false);
  assert.equal(f.p.planningDelivery(id,'owner',{planningRequestId,state:'accepted'}).state,'accepted');
  assert.equal(f.p.planningDelivery(id,'owner',{planningRequestId,state:'sending'}).claimed,false);
  assert.equal(f.p.get(id,'owner').revision,result.production.revision,'transport receipts do not invalidate workflow revisions');
  const stopped={...f.p.get(id,'owner'),phase:'cancelled',cancelRequested:true};f.p.write(stopped,'fixture_stop');
  assert.throws(()=>f.p.planningDelivery(id,'owner',{planningRequestId,state:'sending'}),/停止済み/);
});
test('single-production cancellation does not abort the conversation or another production',async()=>{
  let aborted=0;const cancelled=[];const id=randomUUID(),other=randomUUID();
  const p={id,attempts:[],revision:4,latestRunId:null},otherProduction={id:other,cancelRequested:false};
  let response;
  await productionRoute({req:{method:'POST',headers:{'x-dsh-session':'owner'}},res:{},path:`/api/productions/${id}/cancel-owned`,url:new URL('http://local/'),role:'admin',store:{get:()=>null},engine:{work:new Map()},productions:{get:()=>p,cancel:(selected,session,input)=>{assert.equal(selected,id);assert.equal(session,'owner');assert.equal(input.expectedRevision,4);return {...p,cancelRequested:true};}},workflows:{},body:async()=>({expectedRevision:4,expectedRunId:null}),json:(_res,status,value)=>{response={status,value};},abortSession:()=>{aborted++;},cancelProductionPe:p=>cancelled.push(p.id)});
  assert.equal(response.status,202);assert.equal(aborted,0);assert.deepEqual(cancelled,[id]);assert.equal(otherProduction.cancelRequested,false);
});
test('PE cancellation failure still schedules recovery for that production without aborting the session',async()=>{
  const id=randomUUID(),runId=randomUUID(),launched=[];let aborts=0;
  await assert.rejects(productionRoute({req:{method:'POST',headers:{'x-dsh-session':'owner'}},res:{},path:`/api/productions/${id}/cancel-owned`,url:new URL('http://local/'),role:'admin',store:{get:r=>({id:r,phase:'generating'})},engine:{work:new Map(),launch:(...args)=>launched.push(args)},productions:{get:()=>({id}),cancel:()=>({id,attempts:[runId]})},workflows:{},body:async()=>({expectedRevision:4,expectedRunId:runId}),json:()=>{},abortSession:()=>{aborts++;},cancelProductionPe:()=>{throw Error('PE cancellation unknown');}}),error=>error.status===503 && /停止の受付後/.test(error.message));
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(launched,[[runId,true]]);assert.equal(aborts,0);
});
const origin='http://127.0.0.1:3080';
const request=body=>new Request(origin+ACTIONS_PATH,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Local-Studio-Action':'1'},body:JSON.stringify(body)});
test('planning resumption uses the saved request ID, reconciles a durable receipt and never resends an uncertain claim',async()=>{
  const id=randomUUID(),run=randomUUID(),planningId=randomUUID();let sends=0,receipt=false,claimed=false;
  const production={id,sessionId:'owner',phase:'revising',latestRunId:run,latestUserDecision:{decision:'reject',sourceRunId:run,artifactSha256:artifact.sha256,planningRequestId:planningId,feedback:'Adjust light'}};
  const handler=actionsHandler({dshOrigin:origin,sessionQuery:{async observeSession(){return {events:[],[Symbol.dispose](){}};}},controllerRequest:async(path,options)=>{
    if(path===`/api/productions/${id}`)return {production};
    if(path.endsWith('/planning-delivery')){if(options.body.state==='sending'){if(claimed)return {claimed:false,state:'sending'};claimed=true;return {claimed:true};}return {state:'accepted'};}
    throw Error('Unexpected');
  },planningReceipt:async()=>receipt,sendPlanning:async(_request,session,p)=>{sends++;assert.equal(session,'owner');assert.equal(p.requestId,planningId);assert.match(p.text,/計画・相談のみ/);throw Error('Lost reply');}});
  const body={sessionId:'owner',action:'plan-production',productionId:id,planningRequestId:planningId};
  assert.equal((await handler(request(body))).status,503);assert.equal(sends,1);
  assert.equal((await handler(request(body))).status,409);assert.equal(sends,1);
  receipt=true;assert.equal((await handler(request(body))).status,202);assert.equal(sends,1,'reconciliation does not create another user turn');
  assert.equal((await handler(request({...body,sessionId:'foreign'}))).status,404);
});
