import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {createPlugin} from '../apps/dsh-plugins/local-genai/index.mjs';
import {RunStore} from '../apps/controller/store.mjs';
import {ProductionStore} from '../apps/controller/productions.mjs';
import {createControllerServer} from '../apps/controller/http.mjs';
import {MossPeCoordinator} from '../apps/controller/moss-pe-controller.mjs';
import {buildMossOfficialGraph} from '../apps/controller/moss-official.mjs';
import {buildQwen21Graph} from '../apps/controller/qwen21-workflow.mjs';
import {workflowGraphHash} from '../apps/controller/workflows.mjs';

const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
async function fixture(fetch){
  const definitions=new Map(),scope={};
  const ctx={tools:{register:x=>definitions.set(x.name,x),presentAs(){},guard(){}},attachments:{},llm:{resolveModelInfo:async()=>({inputModalities:['image']})},agents:{get:()=>null},effect:f=>f(),systemPrompt:{section(){},getSectionOrder:()=>0,suppressRuntimeContext(){}},on:()=>()=>{}};
  const plugin=await createPlugin(ctx,{role:'studio',runtimeRoot:process.cwd()},{scopeOf:()=>scope,scopeChainOf:()=>[scope],defineTool:x=>x,loadConfiguration:async()=>({controllerUrl:'http://127.0.0.1:3090',token:'synthetic-only'}),fetch});
  let seq=0;const call=(name,args)=>definitions.get(name).execute(args,{callId:`call-${++seq}`,signal:new AbortController().signal,agent:{session:{id:'session',requestHeader:()=>({config:{provider:'local-strata',model:'strata-core'}})}}});
  const create=(args={})=>call('local_production_create',{request:' A portrait ',criteria:[{id:'C1',description:' portrait '}],invariants:[],modelProfile:'moss-image-sft-int8-v1',...args});
  return {call,create,dispose:()=>plugin.dispose()};
}

test('lost production response is reconciled only by exact owned saved input without resubmission',async t=>{
  const store=new RunStore(':memory:'),productions=new ProductionStore(store);t.after(()=>store.db.close());
  let original,mode='missing',postCount=0;
  const f=await fixture(async(address,options)=>{
    const url=new URL(address);
    if(url.pathname==='/api/productions'&&options.method==='POST'){
      postCount++;const body=JSON.parse(options.body);original=productions.create('session',body).production;throw Error('lost response after commit');
    }
    if(url.pathname==='/api/productions'&&options.method==='GET'){
      assert.equal(url.searchParams.get('requestId'),original.requestId);
      if(mode==='missing')return json({productions:[]});
      if(mode==='mismatch')return json({productions:[{...original,sessionId:'other'}]});
      return json({productions:[original]});
    }
    throw Error('unexpected request');
  });t.after(f.dispose);
  let id;await assert.rejects(f.create(),e=>(id=e.requestId,e.uncertain));
  await assert.rejects(f.call('local_production_reconcile_create',{requestId:id}),/No unique/);
  mode='mismatch';await assert.rejects(f.call('local_production_reconcile_create',{requestId:id}),/differs/);
  await assert.rejects(f.create(),/previous mutation is unresolved/);
  mode='match';const result=await f.call('local_production_reconcile_create',{requestId:id});
  assert.equal(result.production.id,original.id);assert.equal(result.reconciled,true);assert.equal(postCount,1);
});

test('PE ownership and production binding must validate before uncertainty can clear',async t=>{
  let id,mode='owner',postCount=0;
  const brief={request:'portrait',invariants:[],modelProfile:'moss-image-sft-official-v1'},hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex'),briefHash=hash(brief);
  const run=()=>{const spec={productionId:'prod',briefHash,prompt:'a',reason:'test',seed:'1',inputAssetId:null,modelProfile:brief.modelProfile};return {id:'run',requestId:id,kind:'moss-pe',sessionId:mode==='owner'?'other':'session',productionId:'prod',productionRevision:1,phase:'queued',spec,specHash:hash(spec)};};
  const f=await fixture(async(address,options)=>{
    const url=new URL(address);
    if(url.pathname==='/api/moss-pe/status')return json({available:true});
    if(url.pathname==='/api/moss-pe'&&options.method==='POST'){id=JSON.parse(options.body).requestId;throw Error('lost');}
    if(url.pathname==='/api/moss-pe'&&options.method==='GET')return json({run:run()});
    if(url.pathname==='/api/productions/prod')return json({production:{id:'prod',sessionId:'session',revision:1,briefHash,brief,promptEnhancements:mode==='binding'?[]:['run']}});
    if(url.pathname==='/api/productions'&&options.method==='POST'){postCount++;return json({production:{id:'new',revision:0}});}
    throw Error('unexpected');
  });t.after(f.dispose);
  await assert.rejects(f.call('local_moss_pe_start',{productionId:'prod',expectedRevision:0,prompt:'a',seed:'1',reason:'test'}),e=>e.uncertain);
  await assert.rejects(f.call('local_moss_pe_result',{productionId:'prod',requestId:id}),/ownership/);
  mode='binding';await assert.rejects(f.call('local_moss_pe_result',{productionId:'prod',requestId:id}),/binding/);
  await assert.rejects(f.create(),/previous mutation is unresolved/);
  mode='match';assert.equal((await f.call('local_moss_pe_result',{productionId:'prod',requestId:id})).runId,'run');
  assert.equal((await f.create()).production.id,'new');assert.equal(postCount,1);
});

test('a parallel cancellation keeps normal mutations blocked until its own response',async t=>{
  let first,cancel,createCount=0;
  const f=await fixture(async(address)=>{
    const path=new URL(address).pathname;
    if(path==='/api/productions'&&++createCount===1)return new Promise(resolve=>{first=resolve;});
    if(path.endsWith('/cancel'))return new Promise(resolve=>{cancel=resolve;});
    if(path==='/api/productions')return json({production:{id:'next',revision:0}});
    throw Error('unexpected');
  });t.after(f.dispose);
  const pending=f.create();await new Promise(r=>setImmediate(r));const stopping=f.call('local_production_cancel',{productionId:'prod'});await new Promise(r=>setImmediate(r));
  first(json({production:{id:'prod',revision:0}}));await pending;
  await assert.rejects(f.create(),/Another mutation/);assert.equal(createCount,1);
  cancel(json({production:{id:'prod',revision:1}}));await stopping;
  assert.equal((await f.create()).production.id,'next');
});

test('real Controller brief normalization for edit, ordered inputs and structured fields is verified',async t=>{
  const ids=['00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003'];
  const store=new RunStore(':memory:'),productions=new ProductionStore(store,{assets:{get:id=>({purpose:id===ids[2]?'reference':'input'})}});t.after(()=>store.db.close());
  let original,changed=false;
  const f=await fixture(async(address,options)=>{
    const url=new URL(address);
    if(url.pathname==='/api/productions'&&options.method==='POST'){original=productions.create('session',JSON.parse(options.body)).production;throw Error('lost');}
    if(url.pathname==='/api/productions'&&options.method==='GET')return json({productions:[changed?{...original,brief:{...original.brief,inputAssetIds:[...original.brief.inputAssetIds].reverse()}}:original]});
    throw Error('unexpected');
  });t.after(f.dispose);
  let id;await assert.rejects(f.create({modelProfile:'moss-image-sft-official-v1',mode:'edit',inputAssetId:ids[0],inputAssetIds:ids.slice(0,2),referenceAssetIds:[ids[2]],requiredConditions:[' keep '],preferredConditions:[],avoid:[' watermark '],steps:[' edit '],usage:' test '}),e=>(id=e.requestId,e.uncertain));
  changed=true;await assert.rejects(f.call('local_production_reconcile_create',{requestId:id}),/differs/);
  changed=false;assert.equal((await f.call('local_production_reconcile_create',{requestId:id})).production.id,original.id);
});

test('reconcile cannot clear the create while a cancellation begins during the read',async t=>{
  const store=new RunStore(':memory:'),productions=new ProductionStore(store);t.after(()=>store.db.close());
  let original,completeRead,completeCancel;
  const f=await fixture(async(address,options)=>{
    const path=new URL(address).pathname;
    if(path==='/api/productions'&&options.method==='POST'){original=productions.create('session',JSON.parse(options.body)).production;throw Error('lost');}
    if(path==='/api/productions'&&options.method==='GET')return new Promise(resolve=>{completeRead=resolve;});
    if(path.endsWith('/cancel'))return new Promise(resolve=>{completeCancel=resolve;});
    throw Error('unexpected');
  });t.after(f.dispose);
  let id;await assert.rejects(f.create(),e=>(id=e.requestId,e.uncertain));
  const read=f.call('local_production_reconcile_create',{requestId:id});await new Promise(r=>setImmediate(r));
  const cancel=f.call('local_production_cancel',{productionId:original.id});await new Promise(r=>setImmediate(r));
  completeRead(json({productions:[original]}));await assert.rejects(read,/state changed/);
  await assert.rejects(f.create(),/previous mutation is unresolved/);
  completeCancel(json({production:{id:original.id,revision:1}}));await cancel;
  const reread=f.call('local_production_reconcile_create',{requestId:id});await new Promise(r=>setImmediate(r));completeRead(json({productions:[original]}));
  assert.equal((await reread).reconciled,true);
});

test('independent uncertain cancellation is not erased by a successful create reconciliation',async t=>{
  const store=new RunStore(':memory:'),productions=new ProductionStore(store);t.after(()=>store.db.close());let original;
  const f=await fixture(async(address,options)=>{
    const path=new URL(address).pathname;
    if(path==='/api/productions'&&options.method==='POST'){original=productions.create('session',JSON.parse(options.body)).production;throw Error('lost create');}
    if(path.endsWith('/cancel'))throw Error('lost cancellation');
    if(path==='/api/productions'&&options.method==='GET')return json({productions:[original]});
    throw Error('unexpected');
  });t.after(f.dispose);
  let id;await assert.rejects(f.create(),e=>(id=e.requestId,e.uncertain));
  await assert.rejects(f.call('local_production_cancel',{productionId:original.id}),e=>e.uncertain);
  const result=await f.call('local_production_reconcile_create',{requestId:id});assert.equal(result.otherUnresolved,1);
  await assert.rejects(f.create(),/previous mutation is unresolved/);
});

test('real Controller HTTP and SQLite recover an acknowledged-on-server create without a second POST',async t=>{
  const store=new RunStore(':memory:'),productions=new ProductionStore(store,{defaultModelProfile:'moss-image-sft-int8-v1'});
  const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const workflows={catalog:async()=>({modelProfiles:[{id:'moss-image-sft-int8-v1',available:true}],capabilities:[{modelProfile:'moss-image-sft-int8-v1',mode:'t2i'}]})};
  const controller=createControllerServer({store,productions,workflows,engine:{work:new Set(),launch(){}},token:'admin',dshToken:'synthetic-only',port,profile:'moss-image-sft-int8-v1'});
  await new Promise((resolve,reject)=>controller.once('error',reject).listen(port,'127.0.0.1',resolve));
  t.after(async()=>{controller.closeAllConnections();await new Promise(resolve=>controller.close(resolve));store.close();});
  let post=0,get=0;
  const f=await fixture(async(address,options)=>{
    const source=new URL(address);assert.equal(source.origin,'http://127.0.0.1:3090');
    const response=await fetch(`http://127.0.0.1:${port}${source.pathname}${source.search}`,options);
    if(options.method==='POST'){post++;assert.equal(response.status,201);await response.arrayBuffer();throw Error('response lost after server commit');}
    get++;return response;
  });t.after(f.dispose);
  let id;await assert.rejects(f.create(),e=>(id=e.requestId,e.uncertain));
  const recovered=await f.call('local_production_reconcile_create',{requestId:id});
  assert.equal(recovered.reconciled,true);assert.equal(post,1);assert.equal(get,1);
  assert.equal(productions.list('session',id)[0].id,recovered.production.id);
});

for(const family of ['moss','qwen'])test(`${family} PE reconciliation accepts a real Coordinator run with its exact original whitespace and defaults`,async t=>{
  const profile=family==='moss'?'moss-image-sft-official-v1':'qwen-image-2.1-base-v1';
  const store=new RunStore(':memory:'),productions=new ProductionStore(store),adapter={},gate={};t.after(()=>store.close());
  const p=productions.create('session',{requestId:'production-fixture-1234567',modelProfile:profile,brief:{request:'portrait',criteria:[{id:'C1',description:'portrait'}],invariants:[]}}).production;
  const pe=new MossPeCoordinator({store,productions,adapter,gate,verifyEpoch:async()=>({}),family,...(family==='qwen'?{licenseCheck:async()=>true}:{})});
  let requestId,posts=0;
  const f=await fixture(async(address,options)=>{
    const url=new URL(address),base=`/api/${family}-pe`;
    if(url.pathname===`${base}/status`)return json({available:true});
    if(url.pathname===base&&options.method==='POST'){posts++;const body=JSON.parse(options.body);requestId=body.requestId;pe.create(p.id,'session',body);throw Error('response lost after PE creation');}
    if(url.pathname===base&&options.method==='GET')return json({run:pe.find(p.id,'session',url.searchParams.get('requestId'))});
    if(url.pathname===`/api/productions/${p.id}`)return json({production:productions.get(p.id,'session')});
    throw Error('unexpected request');
  });t.after(f.dispose);
  const args={productionId:p.id,expectedRevision:0,prompt:' preserve spaces ',seed:'1',reason:' test reason ',...(family==='qwen'?{mode:'t2i'}:{})};
  await assert.rejects(f.call(`local_${family}_pe_start`,args),e=>e.uncertain);
  const recovered=await f.call(`local_${family}_pe_result`,{productionId:p.id,requestId});
  assert.equal(recovered.runId,pe.find(p.id,'session',requestId).id);assert.equal(posts,1);
});

for(const family of ['moss','qwen'])test(`${family} prepared render response loss reconciles the owned SQLite run via actual Controller HTTP without resubmitting`,async t=>{
  const profile=family==='moss'?'moss-image-sft-official-v1':'qwen-image-2.1-base-v1',store=new RunStore(':memory:'),productions=new ProductionStore(store);
  const p=productions.create('session',{requestId:'production-fixture-1234567',modelProfile:profile,brief:{request:'portrait',criteria:[{id:'C1',description:'portrait'}],invariants:[]}}).production;
  const request={modelProfile:profile,mode:'t2i',prompt:'A portrait',negativePrompt:family==='moss'?'text':'',seed:'42',width:768,height:1024,steps:25,inputAssets:[],...(family==='qwen'?{variant:'base',sessionId:'session'}:{})};
  const built=family==='moss'?buildMossOfficialGraph(request):buildQwen21Graph(request),workflow={schemaVersion:family==='moss'?4:5,id:'11111111-1111-4111-8111-111111111111',productionId:p.id,modelProfile:profile,mode:'t2i',inputAssetIds:[],request,graph:built.graph,output:built.output,sha256:workflowGraphHash(built.graph),rationale:'fixture'};
  productions.bindWorkflow(p.id,'session',0,workflow);
  const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  let savedMode='valid';
  const workflows={get:async id=>{
    assert.equal(id,workflow.id);
    if(savedMode==='missing')throw Error('snapshot unavailable');
    if(savedMode==='changed')return {...workflow,request:{...workflow.request,prompt:'changed independently'}};
    return structuredClone(workflow);
  }};let launches=0,post=0,get=0,alter=null;
  const controller=createControllerServer({store,productions,workflows,engine:{work:new Set(),launch(){launches++;}},token:'admin',dshToken:'synthetic-only',port,profile});
  await new Promise((resolve,reject)=>controller.once('error',reject).listen(port,'127.0.0.1',resolve));
  t.after(async()=>{controller.closeAllConnections();await new Promise(resolve=>controller.close(resolve));store.close();});
  const f=await fixture(async(address,options)=>{
    const source=new URL(address);assert.equal(source.origin,'http://127.0.0.1:3090');
    const response=await fetch(`http://127.0.0.1:${port}${source.pathname}${source.search}`,options);
    if(options.method==='POST'){post++;assert.equal(response.status,202);await response.arrayBuffer();throw Error('lost render response after admission');}
    get++;
    if(alter){const value=await response.json();alter(value);return json(value);}
    return response;
  });t.after(f.dispose);
  let id;await assert.rejects(f.call('local_prepared_render',{productionId:p.id,expectedRevision:1,workflowId:workflow.id}),e=>(id=e.requestId,e.uncertain));
  const wrong=await fetch(`http://127.0.0.1:${port}/api/productions/${p.id}/run-by-request?${new URLSearchParams({requestId:id})}`,{headers:{Authorization:'Bearer synthetic-only','X-DSH-Session':'different-session'}});assert.equal(wrong.status,404);
  const missing=await fetch(`http://127.0.0.1:${port}/api/productions/${p.id}/run-by-request?requestId=nonexistent-request-id`,{headers:{Authorization:'Bearer synthetic-only','X-DSH-Session':'session'}});assert.equal(missing.status,404);
  const duplicate=await fetch(`http://127.0.0.1:${port}/api/productions/${p.id}/run-by-request?requestId=${id}&requestId=${id}`,{headers:{Authorization:'Bearer synthetic-only','X-DSH-Session':'session'}});assert.equal(duplicate.status,400);
  for(const mode of ['missing','changed']){
    savedMode=mode;await assert.rejects(f.call('local_render_reconcile',{productionId:p.id,requestId:id}),/HTTP 409/);
    await assert.rejects(f.create(),/previous mutation is unresolved/);
  }
  savedMode='valid';
  const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
  for(const mutate of [
    x=>{x.run.sessionId='other';},
    x=>{x.run.spec.prompt='different';},
    x=>{x.run.spec.workflow.graph[family==='moss'?'unet':'diffusion'].inputs.unet_name='other';x.run.specHash=hash(x.run.spec);},
    x=>{x.production.attempts=[];},
    x=>{x.run.productionRevision++;},
    x=>{x.production.brief.request='different';},
  ]){
    alter=mutate;await assert.rejects(f.call('local_render_reconcile',{productionId:p.id,requestId:id}),/evidence differs/);
    await assert.rejects(f.create(),/previous mutation is unresolved/);
  }
  alter=null;
  const recovered=await f.call('local_render_reconcile',{productionId:p.id,requestId:id});
  assert.equal(recovered.phase,'queued');assert.equal(post,1);assert.equal(get,9);assert.equal(launches,1);
  assert.equal(store.get(recovered.runId).requestId,id);
});
