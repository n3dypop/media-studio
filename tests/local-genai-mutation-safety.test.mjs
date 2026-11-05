import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,rm,realpath} from 'node:fs/promises';
import {join,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {RunStore} from '../apps/controller/store.mjs';
import {ProductionStore} from '../apps/controller/productions.mjs';
import {createControllerServer} from '../apps/controller/http.mjs';
import {MossPeCoordinator} from '../apps/controller/moss-pe-controller.mjs';
import {buildMossOfficialGraph} from '../apps/controller/moss-official.mjs';
import {buildQwen21Graph} from '../apps/controller/qwen21-workflow.mjs';
import {workflowGraphHash} from '../apps/controller/workflows.mjs';
import {openMutationJournal} from '../apps/dsh-plugins/local-genai/durable-journal.mjs';
import {runDurableOwnedMutation,reconcileDurableOwnedMutation} from '../apps/dsh-plugins/local-genai/durable-coordinator.mjs';

async function durableFixture(t){
 const base=await realpath(tmpdir()),root=await mkdtemp(join(base,'mutation-safety-journal-'));assert.ok(root.startsWith(base+sep));await mkdir(join(root,'data'));let journal=await openMutationJournal(root);t.after(async()=>{journal.close();assert.equal(await realpath(root),root);assert.ok(root.startsWith(base+sep));await rm(root,{recursive:true,force:true});});
 const events=[],session={id:'session',surface:{nodes:[]},snapshotEvents:()=>events,deriveMessages:()=>[]},sessions={flush:async()=>true},persistence={flush:async()=>{},open:async(id,access)=>({id,access,read:async seq=>({events:events.filter(x=>x.seq===seq)}),close:async()=>{}})},common={journal,session,sessions,persistence,mapSessionId:id=>id,wireProof:async()=>true};let step=0;
 const call=name=>{const callId=`call-${++step}`;events.push({seq:events.length,type:'tool/call',data:{callId,name,turn:1,step}});return callId;};
 return {common,call,reopen:async()=>{journal.close();journal=await openMutationJournal(root);common.journal=journal;},pending:()=>journal.pending('session')};
}
test('lost production response is reconciled only by exact owned saved input without resubmission',async t=>{
  const store=new RunStore(':memory:'),productions=new ProductionStore(store);t.after(()=>store.db.close());
  let original,mode='missing',postCount=0;const f=await durableFixture(t),id=randomUUID(),profile='moss-image-sft-int8-v1',input={requestId:id,modelProfile:profile,brief:{request:' A portrait ',criteria:[{id:'C1',description:' portrait '}],invariants:[]}},expected={request:'A portrait',criteria:[{id:'C1',description:'portrait'}],invariants:[],modelProfile:profile,mode:'t2i',inputAssetId:null,referenceAssetIds:[]},hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
  const readProof=async()=>({productions:mode==='missing'?[]:[mode==='mismatch'?{...original,sessionId:'other'}:original]}),send=async()=>{postCount++;original=productions.create('session',input).production;throw Error('lost response after commit');};
  const create=()=>runDurableOwnedMutation({...f.common,currentCallId:f.call('local_production_create'),toolName:'local_production_create',operation:'create',input,correlationHash:hash(expected),send,readProof});
  const reconcile=()=>reconcileDurableOwnedMutation({...f.common,currentCallId:f.call('local_production_reconcile_create'),toolName:'local_production_reconcile_create',operation:'create',requestId:id,readProof});
  await assert.rejects(create(),/lost response/);await f.reopen();await assert.rejects(reconcile(),/unresolved/);mode='mismatch';await assert.rejects(reconcile(),/unresolved/);await assert.rejects(create(),/unresolved|pending|open|UNIQUE/i);
  mode='match';const result=await reconcile();assert.equal(result.value.productions[0].id,original.id);assert.equal(postCount,1);assert.equal(f.pending()[0].state,'receipt');
});

test('PE ownership and production binding must validate before uncertainty can clear',async t=>{
  const store=new RunStore(':memory:'),productions=new ProductionStore(store),profile='moss-image-sft-official-v1';t.after(()=>store.close());const p=productions.create('session',{requestId:randomUUID(),modelProfile:profile,brief:{request:'portrait',criteria:[{id:'C1',description:'portrait'}],invariants:[]}}).production,pe=new MossPeCoordinator({store,productions,adapter:{},gate:{},verifyEpoch:async()=>({}),family:'moss'}),f=await durableFixture(t),id=randomUUID(),input={productionId:p.id,expectedRevision:0,prompt:'a',seed:'1',reason:'test',requestId:id};let postCount=0;
  const submit=()=>runDurableOwnedMutation({...f.common,currentCallId:f.call('local_moss_pe_start'),toolName:'local_moss_pe_start',operation:'moss-pe-start',targetId:p.id,input,send:async()=>{postCount++;pe.create(p.id,'session',input);throw Error('lost');},readProof:async()=>{throw Error('unexpected');}});
  await assert.rejects(submit(),/lost/);await f.reopen();const proof=pe.findStartReceipt(p.id,'session',id),reconcile=readProof=>reconcileDurableOwnedMutation({...f.common,currentCallId:f.call('local_pe_receipt_reconcile'),toolName:'local_pe_receipt_reconcile',operation:'moss-pe-start',targetId:p.id,requestId:id,readProof});
  const wrongOwner=structuredClone(proof);wrongOwner.run.sessionId='other';await assert.rejects(reconcile(async()=>wrongOwner),/unresolved/);const wrongBinding=structuredClone(proof);wrongBinding.production.promptEnhancements=[];await assert.rejects(reconcile(async()=>wrongBinding),/unresolved/);await assert.rejects(submit(),/unresolved|pending|open|UNIQUE/i);
  const result=await reconcile(async()=>proof);assert.equal(result.value.run.id,proof.run.id);assert.equal(postCount,1);assert.equal(f.pending()[0].state,'receipt');
});

test('real Controller brief normalization for edit, ordered inputs and structured fields is verified',async t=>{
  const ids=['00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003'];
  const store=new RunStore(':memory:'),productions=new ProductionStore(store,{assets:{get:id=>({purpose:id===ids[2]?'reference':'input'})}});t.after(()=>store.db.close());
  const f=await durableFixture(t),id=randomUUID(),profile='moss-image-sft-official-v1',brief={request:' A portrait ',criteria:[{id:'C1',description:' portrait '}],invariants:[],mode:'edit',inputAssetId:ids[0],inputAssetIds:ids.slice(0,2),referenceAssetIds:[ids[2]],requiredConditions:[' keep '],preferredConditions:[],avoid:[' watermark '],steps:[' edit '],usage:' test '},input={requestId:id,modelProfile:profile,brief},expected={request:'A portrait',criteria:[{id:'C1',description:'portrait'}],invariants:[],modelProfile:profile,mode:'edit',inputAssetId:ids[0],referenceAssetIds:[ids[2]],inputAssetIds:ids.slice(0,2),requiredConditions:['keep'],preferredConditions:[],avoid:['watermark'],steps:['edit'],usage:'test'},correlationHash=createHash('sha256').update(JSON.stringify(expected)).digest('hex');let original;
  await assert.rejects(runDurableOwnedMutation({...f.common,currentCallId:f.call('local_production_create'),toolName:'local_production_create',operation:'create',input,correlationHash,send:async()=>{original=productions.create('session',input).production;throw Error('lost');},readProof:async()=>{throw Error('unexpected');}}),/lost/);await f.reopen();assert.deepEqual(original.brief,expected);
  const reconcile=readProof=>reconcileDurableOwnedMutation({...f.common,currentCallId:f.call('local_production_reconcile_create'),toolName:'local_production_reconcile_create',operation:'create',requestId:id,readProof}),changed=structuredClone(original);changed.brief.inputAssetIds.reverse();changed.briefHash=createHash('sha256').update(JSON.stringify(changed.brief)).digest('hex');
  await assert.rejects(reconcile(async()=>({productions:[changed]})),/unresolved/);const value=await reconcile(async()=>({productions:[original]}));assert.equal(value.value.productions[0].id,original.id);assert.equal(f.pending()[0].state,'receipt');
});

test('real Controller HTTP and SQLite recover an acknowledged-on-server create without a second POST',async t=>{
  const store=new RunStore(':memory:'),productions=new ProductionStore(store,{defaultModelProfile:'moss-image-sft-int8-v1'});
  const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const workflows={catalog:async()=>({modelProfiles:[{id:'moss-image-sft-int8-v1',available:true}],capabilities:[{modelProfile:'moss-image-sft-int8-v1',mode:'t2i'}]})};
  const controller=createControllerServer({store,productions,workflows,engine:{work:new Set(),launch(){}},token:'admin',dshToken:'synthetic-only',port,profile:'moss-image-sft-int8-v1'});
  await new Promise((resolve,reject)=>controller.once('error',reject).listen(port,'127.0.0.1',resolve));
  t.after(async()=>{controller.closeAllConnections();await new Promise(resolve=>controller.close(resolve));store.close();});
  let post=0,get=0;const f=await durableFixture(t),id=randomUUID(),profile='moss-image-sft-int8-v1',input={requestId:id,modelProfile:profile,brief:{request:' A portrait ',criteria:[{id:'C1',description:' portrait '}],invariants:[]}},expected={request:'A portrait',criteria:[{id:'C1',description:'portrait'}],invariants:[],modelProfile:profile,mode:'t2i',inputAssetId:null,referenceAssetIds:[]},correlationHash=createHash('sha256').update(JSON.stringify(expected)).digest('hex'),headers={Authorization:'Bearer synthetic-only','X-DSH-Session':'session','Content-Type':'application/json'};
  const readProof=async()=>{get++;const response=await fetch(`http://127.0.0.1:${port}/api/productions?${new URLSearchParams({requestId:id})}`,{headers});assert.equal(response.status,200);return response.json();};
  await assert.rejects(runDurableOwnedMutation({...f.common,currentCallId:f.call('local_production_create'),toolName:'local_production_create',operation:'create',input,correlationHash,send:async()=>{post++;const response=await fetch(`http://127.0.0.1:${port}/api/productions`,{method:'POST',headers,body:JSON.stringify(input)});assert.equal(response.status,201);await response.arrayBuffer();throw Error('response lost after server commit');},readProof}),/response lost/);await f.reopen();
  const recovered=await reconcileDurableOwnedMutation({...f.common,currentCallId:f.call('local_production_reconcile_create'),toolName:'local_production_reconcile_create',operation:'create',requestId:id,readProof});assert.equal(post,1);assert.equal(get,1);assert.equal(productions.list('session',id)[0].id,recovered.value.productions[0].id);assert.equal(f.pending()[0].state,'receipt');
});

for(const family of ['moss','qwen'])test(`${family} PE reconciliation accepts a real Coordinator run with its exact original whitespace and defaults`,async t=>{
  const profile=family==='moss'?'moss-image-sft-official-v1':'qwen-image-2.1-base-v1';
  const store=new RunStore(':memory:'),productions=new ProductionStore(store),adapter={},gate={};t.after(()=>store.close());
  const p=productions.create('session',{requestId:randomUUID(),modelProfile:profile,brief:{request:'portrait',criteria:[{id:'C1',description:'portrait'}],invariants:[]}}).production;
  const pe=new MossPeCoordinator({store,productions,adapter,gate,verifyEpoch:async()=>({}),family,...(family==='qwen'?{licenseCheck:async()=>true}:{})});
  const base=await realpath(tmpdir()),root=await mkdtemp(join(base,'pe-start-journal-'));assert.ok(root.startsWith(base+sep));await mkdir(join(root,'data'));let journal=await openMutationJournal(root),posts=0;t.after(async()=>{journal.close();assert.equal(await realpath(root),root);assert.ok(root.startsWith(base+sep));await rm(root,{recursive:true,force:true});});
  const events=[],session={id:'session',surface:{nodes:[]},snapshotEvents:()=>events,deriveMessages:()=>[]},sessions={flush:async()=>true},persistence={flush:async()=>{},open:async(id,access)=>({id,access,read:async seq=>({events:events.filter(x=>x.seq===seq)}),close:async()=>{}})},common={journal,session,sessions,persistence,mapSessionId:id=>id,wireProof:async()=>true};let step=0;
  const call=name=>{const callId=`call-${++step}`;events.push({seq:events.length,type:'tool/call',data:{callId,name,turn:1,step}});return callId;},requestId=randomUUID(),input={productionId:p.id,expectedRevision:0,prompt:' preserve spaces ',seed:'1',reason:' test reason ',...(family==='qwen'?{mode:'t2i'}:{}),requestId},operation=`${family}-pe-start`;
  await assert.rejects(runDurableOwnedMutation({...common,currentCallId:call(`local_${family}_pe_start`),toolName:`local_${family}_pe_start`,operation,targetId:p.id,input,send:async()=>{posts++;pe.create(p.id,'session',input);throw Error('response lost after PE creation');},readProof:async()=>{throw Error('unexpected');}}),/response lost/);
  journal.close();journal=await openMutationJournal(root);common.journal=journal;
  const proof=pe.findStartReceipt(p.id,'session',requestId);const wrong=structuredClone(proof);wrong.run.sessionId='other';
  const reconcile=readProof=>reconcileDurableOwnedMutation({...common,currentCallId:call('local_pe_receipt_reconcile'),toolName:'local_pe_receipt_reconcile',operation,targetId:p.id,requestId,readProof});
  await assert.rejects(reconcile(async()=>wrong),/unresolved/);const recovered=await reconcile(async()=>proof);
  assert.equal(recovered.value.run.id,pe.find(p.id,'session',requestId).id);assert.equal(posts,1);assert.equal(journal.pending('session')[0].state,'receipt');
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
  const base=await realpath(tmpdir()),root=await mkdtemp(join(base,'prepared-render-journal-'));assert.ok(root.startsWith(base+sep));await mkdir(join(root,'data'));let journal=await openMutationJournal(root);t.after(async()=>{journal.close();assert.equal(await realpath(root),root);assert.ok(root.startsWith(base+sep));await rm(root,{recursive:true,force:true});});
  const events=[],session={id:'session',surface:{nodes:[]},snapshotEvents:()=>events,deriveMessages:()=>[]},sessions={flush:async()=>true},persistence={flush:async()=>{},open:async(id,access)=>({id,access,read:async seq=>({events:events.filter(x=>x.seq===seq)}),close:async()=>{}})},common={journal,session,sessions,persistence,mapSessionId:id=>id,wireProof:async()=>true};let step=0;
  const call=name=>{const callId=`call-${++step}`;events.push({seq:events.length,type:'tool/call',data:{callId,name,turn:1,step}});return callId;},id=randomUUID(),input={workflowId:workflow.id,expectedRevision:1,requestId:id},headers={Authorization:'Bearer synthetic-only','X-DSH-Session':'session','Content-Type':'application/json'};
  const readProof=async()=>{get++;const response=await fetch(`http://127.0.0.1:${port}/api/productions/${p.id}/run-by-request?${new URLSearchParams({requestId:id})}`,{headers});if(!response.ok)throw Error(`HTTP ${response.status}`);const value=await response.json();if(alter)alter(value);return value;};
  const reconcile=()=>reconcileDurableOwnedMutation({...common,currentCallId:call('local_render_reconcile'),toolName:'local_render_reconcile',operation:'prepared-render',targetId:p.id,requestId:id,readProof});
  const submit=()=>runDurableOwnedMutation({...common,currentCallId:call('local_prepared_render'),toolName:'local_prepared_render',operation:'prepared-render',targetId:p.id,input,send:async()=>{post++;const response=await fetch(`http://127.0.0.1:${port}/api/productions/${p.id}/render-prepared`,{method:'POST',headers,body:JSON.stringify(input)});assert.equal(response.status,202);await response.arrayBuffer();throw Error('lost render response after admission');},readProof});
  await assert.rejects(submit(),/lost render response/);journal.close();journal=await openMutationJournal(root);common.journal=journal;
  const wrong=await fetch(`http://127.0.0.1:${port}/api/productions/${p.id}/run-by-request?${new URLSearchParams({requestId:id})}`,{headers:{Authorization:'Bearer synthetic-only','X-DSH-Session':'different-session'}});assert.equal(wrong.status,404);
  const missing=await fetch(`http://127.0.0.1:${port}/api/productions/${p.id}/run-by-request?requestId=nonexistent-request-id`,{headers:{Authorization:'Bearer synthetic-only','X-DSH-Session':'session'}});assert.equal(missing.status,404);
  const duplicate=await fetch(`http://127.0.0.1:${port}/api/productions/${p.id}/run-by-request?requestId=${id}&requestId=${id}`,{headers:{Authorization:'Bearer synthetic-only','X-DSH-Session':'session'}});assert.equal(duplicate.status,400);
  for(const mode of ['missing','changed']){
    savedMode=mode;await assert.rejects(reconcile(),/HTTP 409/);
    await assert.rejects(submit(),/unresolved|pending|open|UNIQUE/i);
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
    alter=mutate;await assert.rejects(reconcile(),/unresolved/);
    await assert.rejects(submit(),/unresolved|pending|open|UNIQUE/i);
  }
  alter=null;
  const recovered=await reconcile();
  assert.equal(recovered.value.run.phase,'queued');assert.equal(post,1);assert.equal(get,9);assert.equal(launches,1);
  assert.equal(store.get(recovered.value.run.id).requestId,id);assert.equal(journal.pending('session')[0].state,'receipt');
});
