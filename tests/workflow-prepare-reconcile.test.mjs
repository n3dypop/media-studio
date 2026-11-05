// Independent local-only review of workflow admission, persistence and recovery.
// Real WorkflowRegistry, HTTP routing and SQLite; fake ComfyUI schema only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,unlink,rmdir,lstat,realpath,rename,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {buildMossOfficialGraph} from '../apps/controller/moss-official.mjs';
import {WorkflowRegistry} from '../apps/controller/workflows.mjs';
import {RunStore} from '../apps/controller/store.mjs';
import {ProductionStore} from '../apps/controller/productions.mjs';
import {createControllerServer} from '../apps/controller/http.mjs';
import {createPlugin} from '../apps/dsh-plugins/local-genai/index.mjs';

const parent=tmpdir();
const profile='moss-image-sft-official-v1';
const gate=()=>{let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release};};

async function setup(t){
  const base=await realpath(parent),root=await mkdtemp(join(base,'review-workflow-admission-'));
  assert.ok(resolve(root).startsWith(resolve(base)+sep));assert.equal((await lstat(root)).isSymbolicLink(),false);
  const store=new RunStore(':memory:'),productions=new ProductionStore(store);
  const p=productions.create('review-session',{requestId:randomUUID(),modelProfile:profile,brief:{request:'portrait',criteria:[{id:'C1',description:'portrait'}],invariants:[]}}).production;
  const official={prompt:'A portrait',negativePrompt:'',seed:'42',width:768,height:1024,steps:25};
  const graph=buildMossOfficialGraph({...official,modelProfile:profile,mode:'t2i',inputAssets:[]}).graph;
  // A synthetic local schema, derived solely from the generated fixture graph.
  const objects={};
  for(const node of Object.values(graph)){
    const schema=objects[node.class_type]??={input:{required:{}},output:Array(8).fill('FIXTURE')};
    for(const [key,value] of Object.entries(node.inputs))schema.input.required[key]=[Array.isArray(value)?'FIXTURE':typeof value==='number'?(Number.isInteger(value)?'INT':'FLOAT'):typeof value==='boolean'?'BOOLEAN':'STRING'];
  }
  const registry=new WorkflowRegistry({root,adapter:{modelProfile:profile,profile:graph,request:async route=>{assert.equal(route,'/object_info');return objects;}},assets:{}});
  const hold=createServer();await new Promise(ok=>hold.listen(0,'127.0.0.1',ok));const port=hold.address().port;await new Promise(ok=>hold.close(ok));
  const server=createControllerServer({store,productions,workflows:registry,engine:{work:new Set(),launch(){throw Error('generation prohibited in fixture');}},token:'admin',dshToken:'synthetic-only',port,profile});
  await new Promise((ok,fail)=>server.once('error',fail).listen(port,'127.0.0.1',ok));
  t.after(async()=>{
    server.closeAllConnections();await new Promise(ok=>server.close(ok));store.close();
    assert.equal(await realpath(root),root);assert.ok(root.startsWith(base+sep));
    const drafts=join(root,'workflows','drafts');
    try{for(const name of await readdir(drafts)){assert.match(name,/^[a-f0-9-]+\.json(?:\.hold)?$/);const file=join(drafts,name),s=await lstat(file);assert.ok(s.isFile()&&!s.isSymbolicLink());await unlink(file);}await rmdir(drafts);await rmdir(join(root,'workflows'));}catch(e){if(e.code!=='ENOENT')throw e;}
    await rmdir(root);
  });
  const url=`http://127.0.0.1:${port}`,headers={Authorization:'Bearer synthetic-only','X-DSH-Session':'review-session','Content-Type':'application/json'};
  const draft=(requestId,overrides={})=>({productionId:p.id,expectedRevision:0,modelProfile:profile,mode:'t2i',official,inputRoles:[],rationale:'test',...(requestId===undefined?{}:{requestId}),...overrides});
  const post=(path,body)=>fetch(url+path,{method:'POST',headers,body:JSON.stringify(body)});
  const get=(path,session='review-session')=>fetch(url+path,{headers:{...headers,'X-DSH-Session':session}});
  return {root,store,productions,registry,p,draft,post,get,url};
}

test('pre-admission invalid workflow is definite and can be corrected in the same production',async t=>{
  const f=await setup(t),first=randomUUID();
  const invalid=await f.post('/api/workflows/draft',f.draft(first,{official:{...f.draft(first).official,width:17}}));
  assert.ok(invalid.status>=400&&invalid.status<500,`pre-write input rejection was ${invalid.status}`);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM workflow_preparations').get().n,0);
  const fixed=await f.post('/api/workflows/draft',f.draft(randomUUID()));assert.equal(fixed.status,201,await fixed.text());
});

test('DSH resolves the same saved workflow after HTTP reply loss without sending another draft',async t=>{
  const f=await setup(t),definitions=new Map(),scope={};let posts=0,gets=0,tamper=false;
  const ctx={tools:{register:x=>definitions.set(x.name,x),presentAs(){},guard(){}},attachments:{},llm:{},agents:{get:()=>null},effect:fn=>fn(),systemPrompt:{section(){},getSectionOrder:()=>0,suppressRuntimeContext(){}},on:()=>()=>{}};
  const wrapped=async(address,options)=>{
    const source=new URL(address),target=new URL(source.pathname+source.search,f.url),response=await fetch(target,options);
    if(options.method==='POST'){posts++;assert.equal(response.status,201);await response.arrayBuffer();throw Error('response lost after committed preparation');}
    gets++;if(!tamper)return response;const value=await response.json();value.receipt.payloadHash='0'.repeat(64);return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
  };
  const plugin=await createPlugin(ctx,{role:'studio',runtimeRoot:f.root},{scopeOf:()=>scope,scopeChainOf:()=>[scope],defineTool:x=>x,loadConfiguration:async()=>({controllerUrl:'http://127.0.0.1:3090',token:'synthetic-only'}),fetch:wrapped});
  t.after(()=>plugin.dispose());let serial=0;
  const call=(name,args)=>definitions.get(name).execute(args,{callId:`call-${++serial}`,signal:new AbortController().signal,agent:{session:{id:'review-session'}}});
  const args=f.draft(randomUUID());delete args.requestId;
  let id;await assert.rejects(call('local_moss_official_prepare',args),e=>(id=e.requestId,e.uncertain));
  tamper=true;await assert.rejects(call('local_workflow_reconcile',{productionId:f.p.id,requestId:id}),/differs/);
  await assert.rejects(call('local_moss_official_prepare',args),/previous mutation is unresolved/);
  tamper=false;const result=await call('local_workflow_reconcile',{productionId:f.p.id,requestId:id});
  assert.equal(result.reconciled,true);assert.equal(posts,1);assert.equal(gets,2);assert.equal(result.production.revision,1);
});

test('a malformed admission request ID is definitely rejected without a durable reservation',async t=>{
  const f=await setup(t),bad=await f.post('/api/workflows/draft',f.draft('bad'));
  assert.equal(bad.status,400,await bad.text());
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM workflow_preparations').get().n,0);
  const valid=await f.post('/api/workflows/draft',f.draft(randomUUID()));assert.equal(valid.status,201,await valid.text());
});

test('pending admission blocks duplicate or legacy requests; committed receipt requires exact intact snapshot',async t=>{
  const f=await setup(t),entered=gate(),resume=gate(),original=f.registry.saveDraft.bind(f.registry);
  f.registry.saveDraft=async options=>original({...options,beforeWrite:async snapshot=>{await options.beforeWrite(snapshot);entered.release();await resume.promise;}});
  const requestId=randomUUID(),pending=f.post('/api/workflows/draft',f.draft(requestId));await entered.promise;
  try {
  const state=f.store.db.prepare('SELECT state FROM workflow_preparations WHERE request_id=?').get(requestId);assert.equal(state.state,'started');
  for(const another of [randomUUID(),undefined]){const result=await f.post('/api/workflows/draft',f.draft(another));assert.equal(result.status,409,await result.text());}
  const render=await f.post(`/api/productions/${f.p.id}/render-prepared`,{requestId:randomUUID(),workflowId:randomUUID(),expectedRevision:0});assert.equal(render.status,409,await render.text());
  const before=await f.get(`/api/productions/${f.p.id}/workflow-by-request?requestId=${requestId}`);assert.equal(before.status,409);
  resume.release();const saved=await pending;assert.equal(saved.status,201,await saved.clone().text());const {workflow}=await saved.json();
  const route=`/api/productions/${f.p.id}/workflow-by-request?requestId=${requestId}`;
  const wrong=await f.get(route,'another-session');assert.equal(wrong.status,404);
  const found=await f.get(route);assert.equal(found.status,200,await found.clone().text());const record=await found.json();assert.equal(record.receipt.workflowId,workflow.id);
  const file=join(f.root,'workflows','drafts',`${workflow.id}.json`),bytes=await readFile(file),altered=JSON.parse(bytes);altered.rationale='tampered independently';await writeFile(file,JSON.stringify(altered));
  assert.equal((await f.get(route)).status,409);await writeFile(file,bytes);
  await rename(file,file+'.hold');assert.equal((await f.get(route)).status,409);await rename(file+'.hold',file);
  assert.equal((await f.get(route)).status,200);
  } finally {resume.release();await pending.catch(()=>{});}
});

test('bind failure after file save remains unknown and blocks further drafts and renders',async t=>{
  const f=await setup(t),requestId=randomUUID();f.productions.bindWorkflow=()=>{const e=new Error('injected bind conflict');e.status=409;throw e;};
  const failed=await f.post('/api/workflows/draft',f.draft(requestId));assert.equal(failed.status,503,await failed.text());
  const row=f.store.db.prepare('SELECT state FROM workflow_preparations WHERE request_id=?').get(requestId);assert.equal(row.state,'started');
  assert.equal((await readdir(join(f.root,'workflows','drafts'))).length,1);
  assert.equal((await f.get(`/api/productions/${f.p.id}/workflow-by-request?requestId=${requestId}`)).status,409);
  assert.equal((await f.post('/api/workflows/draft',f.draft(randomUUID()))).status,409);
  assert.equal((await f.post(`/api/productions/${f.p.id}/render-prepared`,{requestId:randomUUID(),workflowId:randomUUID(),expectedRevision:0})).status,409);
});

test('concurrent validation loser is definitely rejected before its own admission',async t=>{
  const f=await setup(t),seen=[gate(),gate()],allow=[gate(),gate()],reserved=gate(),finish=gate();let n=0;
  const original=f.registry.saveDraft.bind(f.registry);
  f.registry.saveDraft=async options=>original({...options,beforeWrite:async snapshot=>{
    const i=n++;seen[i].release();await allow[i].promise;
    await options.beforeWrite(snapshot);
    if(i===0){reserved.release();await finish.promise;}
  }});
  const id1=randomUUID(),id2=randomUUID();let first,second;
  try {
    first=f.post('/api/workflows/draft',f.draft(id1));await seen[0].promise;
    second=f.post('/api/workflows/draft',f.draft(id2));await seen[1].promise;
    allow[0].release();await reserved.promise;allow[1].release();
    const refused=await second;assert.equal(refused.status,409,await refused.text());
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM workflow_preparations WHERE request_id=?').get(id2).n,0);
    finish.release();const accepted=await first;assert.equal(accepted.status,201,await accepted.text());
  } finally {for(const g of [...allow,finish])g.release();await Promise.allSettled([first,second].filter(Boolean));}
});

test('an unresolved draft blocks creating another production in the same session but not an unrelated session',async t=>{
  const f=await setup(t),entered=gate(),resume=gate(),original=f.registry.saveDraft.bind(f.registry);
  f.registry.saveDraft=async options=>original({...options,beforeWrite:async snapshot=>{await options.beforeWrite(snapshot);entered.release();await resume.promise;}});
  f.registry.catalog=async()=>({modelProfiles:[{id:profile,available:true}],capabilities:[{modelProfile:profile,mode:'t2i'}]});
  const requestId=randomUUID(),pending=f.post('/api/workflows/draft',f.draft(requestId));await entered.promise;
  try {
    const input={requestId:randomUUID(),modelProfile:profile,brief:{request:'another production',criteria:[{id:'C1',description:'portrait'}],invariants:[]}};
    const same=await f.post('/api/productions',input);assert.equal(same.status,409,await same.text());
    const other=await fetch(new URL('/api/productions',same.url),{method:'POST',headers:{Authorization:'Bearer synthetic-only','X-DSH-Session':'unrelated-session','Content-Type':'application/json'},body:JSON.stringify({...input,requestId:randomUUID()})});
    assert.equal(other.status,201,await other.text());
  } finally {resume.release();await pending.catch(()=>{});}
});

test('an unresolved draft blocks rendering an already existing production in that session',async t=>{
  const f=await setup(t),p2=f.productions.create('review-session',{requestId:randomUUID(),modelProfile:profile,brief:{request:'another portrait',criteria:[{id:'C1',description:'portrait'}],invariants:[]}}).production;
  const official={prompt:'another portrait',negativePrompt:'',seed:'42',width:768,height:1024,steps:25};
  const w2=await f.registry.saveDraft({productionId:p2.id,sessionId:'review-session',modelProfile:profile,mode:'t2i',official,inputRoles:[],briefInputIds:[],rationale:'test'});
  const bound=f.productions.bindWorkflow(p2.id,'review-session',0,w2);
  const entered=gate(),resume=gate(),original=f.registry.saveDraft.bind(f.registry);
  f.registry.saveDraft=async options=>original({...options,beforeWrite:async snapshot=>{await options.beforeWrite(snapshot);entered.release();await resume.promise;}});
  const pending=f.post('/api/workflows/draft',f.draft(randomUUID()));await entered.promise;
  try {
    const render=await f.post(`/api/productions/${p2.id}/render-prepared`,{requestId:randomUUID(),workflowId:w2.id,expectedRevision:bound.revision});
    assert.equal(render.status,409,await render.text());assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM runs').get().n,0);
  } finally {resume.release();await pending.catch(()=>{});}
});

test('stopping the owned production remains available while workflow admission is pending',async t=>{
  const f=await setup(t),entered=gate(),resume=gate(),original=f.registry.saveDraft.bind(f.registry);
  f.registry.saveDraft=async options=>original({...options,beforeWrite:async snapshot=>{await options.beforeWrite(snapshot);entered.release();await resume.promise;}});
  const requestId=randomUUID(),pending=f.post('/api/workflows/draft',f.draft(requestId));await entered.promise;
  try {
    const stopped=await f.post(`/api/productions/${f.p.id}/cancel`,{});assert.equal(stopped.status,202,await stopped.text());
    assert.equal(f.productions.get(f.p.id,'review-session').cancelRequested,true);
    resume.release();const interrupted=await pending;assert.equal(interrupted.status,503,await interrupted.text());
    assert.equal(f.store.db.prepare('SELECT state FROM workflow_preparations WHERE request_id=?').get(requestId).state,'started');
  } finally {resume.release();await pending.catch(()=>{});}
});
