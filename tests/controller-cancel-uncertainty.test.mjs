import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {ApiError,RunStore} from '../apps/controller/store.mjs';
import {ProductionStore} from '../apps/controller/productions.mjs';
import {createControllerServer} from '../apps/controller/http.mjs';
import {createPlugin} from '../apps/dsh-plugins/local-genai/index.mjs';

const profile='moss-image-sft-int8-v1',session='fixture-session';
async function fixture(t,{mossPe,search}={}){
  const store=new RunStore(':memory:'),productions=new ProductionStore(store);
  const p=productions.create(session,{requestId:randomUUID(),modelProfile:profile,brief:{request:'test',criteria:[{id:'C1',description:'test'}],invariants:[]}}).production;
  const hold=createServer();await new Promise(ok=>hold.listen(0,'127.0.0.1',ok));const port=hold.address().port;await new Promise(ok=>hold.close(ok));
  const engine={work:new Set(),launch(){throw Error('unexpected background execution');}};
  const server=createControllerServer({store,productions,workflows:{},engine,token:'admin-test-token',dshToken:'synthetic-only',port,profile,mossPe,search});
  await new Promise((ok,fail)=>server.once('error',fail).listen(port,'127.0.0.1',ok));
  t.after(async()=>{server.closeAllConnections();await new Promise(ok=>server.close(ok));store.close();});
  const root=`http://127.0.0.1:${port}`;
  const post=(path,body,admin=false)=>fetch(root+path,{method:'POST',headers:{Authorization:'Bearer '+(admin?'admin-test-token':'synthetic-only'),'X-DSH-Session':session,'Content-Type':'application/json'},body:JSON.stringify(body)});
  return {store,productions,p,post,root,engine};
}
const error409=()=>new ApiError(409,'injected cleanup conflict');

for(const action of ['cancel','cancel-owned'])test(`${action}: post-commit 4xx cleanup errors become unknown`,async t=>{
  const f=await fixture(t,{mossPe:{cancelProduction(){throw error409();},work:new Set()}});
  const body=action==='cancel-owned'?{expectedRevision:0,expectedRunId:null}:{};
  const response=await f.post(`/api/productions/${f.p.id}/${action}`,body,action==='cancel-owned');
  assert.equal(response.status,503);assert.equal(f.productions.get(f.p.id,session).cancelRequested,true);
});

test('post-commit abortSession 4xx remains unknown after production cancellation',async t=>{
  const f=await fixture(t,{search:{validateStopTurn(){},cancelSession(){throw error409();}}});
  const response=await f.post(`/api/productions/${f.p.id}/cancel`,{});
  assert.equal(response.status,503);assert.equal(f.productions.get(f.p.id,session).cancelRequested,true);
});

test('pre-commit invalid target and revision remain definite 4xx without mutation',async t=>{
  const f=await fixture(t);
  const bad=await f.post(`/api/productions/${f.p.id}/cancel`,{expectedRunId:null,expectedRevision:0});assert.equal(bad.status,400);
  const conflict=await f.post(`/api/productions/${f.p.id}/cancel-owned`,{expectedRunId:null,expectedRevision:9},true);assert.equal(conflict.status,409);
  assert.equal(f.productions.get(f.p.id,session).cancelRequested,false);
});

test('DSH marks a post-commit cleanup error unresolved and blocks a new production',async t=>{
  const f=await fixture(t,{mossPe:{cancelProduction(){throw error409();},work:new Set()}}),definitions=new Map(),scope={};
  const ctx={tools:{register:x=>definitions.set(x.name,x),presentAs(){},guard(){}},attachments:{},llm:{},agents:{get:()=>null},effect:g=>g(),systemPrompt:{section(){},getSectionOrder:()=>0,suppressRuntimeContext(){}},on:()=>()=>{}};
  const plugin=await createPlugin(ctx,{role:'studio',runtimeRoot:process.cwd()},{scopeOf:()=>scope,scopeChainOf:()=>[scope],defineTool:x=>x,loadConfiguration:async()=>({controllerUrl:'http://127.0.0.1:3090',token:'synthetic-only'}),fetch:(address,options)=>{const u=new URL(address);return fetch(f.root+u.pathname+u.search,options);}});
  t.after(()=>plugin.dispose());let call=0;
  const run=(name,args)=>definitions.get(name).execute(args,{callId:`review-${++call}`,signal:new AbortController().signal,agent:{session:{id:session}}});
  await assert.rejects(run('local_production_cancel',{productionId:f.p.id}),error=>error.uncertain===true&&error.status===503);
  assert.equal(f.productions.get(f.p.id,session).cancelRequested,true);
  await assert.rejects(run('local_production_create',{request:'test',criteria:[{id:'C1',description:'test'}],invariants:[],modelProfile:profile}),/previous mutation is unresolved/);
});

test('admin run cancellation: post-commit 4xx cleanup failures remain unknown',async t=>{
  const f=await fixture(t,{search:{validateStopTurn(){},cancelSession(){throw error409();}}});
  const created=f.store.create({requestId:randomUUID(),spec:{modelProfile:profile}},{decorate:()=>({productionId:f.p.id,sessionId:session})}).run;
  f.engine.work.add(created.id);
  const response=await f.post(`/api/runs/${created.id}/cancel`,{},true);
  assert.equal(response.status,503);assert.equal(f.productions.get(f.p.id,session).cancelRequested,true);assert.equal(f.store.get(created.id).cancelRequested,true);
});

test('admin run cancellation: rejection before mutation remains 4xx',async t=>{
  const f=await fixture(t,{search:{validateStopTurn(){throw error409();}}});
  const created=f.store.create({requestId:randomUUID(),spec:{modelProfile:profile}},{decorate:()=>({productionId:f.p.id,sessionId:session})}).run;
  const response=await f.post(`/api/runs/${created.id}/cancel`,{},true);
  assert.equal(response.status,409);assert.equal(f.productions.get(f.p.id,session).cancelRequested,false);assert.equal(f.store.get(created.id).cancelRequested,false);
});
