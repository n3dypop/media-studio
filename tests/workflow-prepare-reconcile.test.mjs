// Independent local-only review of workflow admission, persistence and recovery.
// Real WorkflowRegistry, HTTP routing and SQLite; fake ComfyUI schema only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,readdir,unlink,rmdir,lstat,realpath,rename,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {buildMossOfficialGraph} from '../apps/controller/moss-official.mjs';
import {WorkflowRegistry} from '../apps/controller/workflows.mjs';
import {RunStore,digest} from '../apps/controller/store.mjs';
import {ProductionStore} from '../apps/controller/productions.mjs';
import {createControllerServer} from '../apps/controller/http.mjs';
import {openMutationJournal} from '../apps/dsh-plugins/local-genai/durable-journal.mjs';
import {runDurableOwnedMutation,reconcileDurableOwnedMutation} from '../apps/dsh-plugins/local-genai/durable-coordinator.mjs';

const parent=tmpdir();
const profile='moss-image-sft-official-v1';
const gate=()=>{let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release};};

async function setup(t,{disk=false}={}){
  const base=await realpath(parent),root=await mkdtemp(join(base,'review-workflow-admission-'));
  assert.ok(resolve(root).startsWith(resolve(base)+sep));assert.equal((await lstat(root)).isSymbolicLink(),false);
  const dbPath=disk?join(root,'recovery.sqlite'):':memory:',store=new RunStore(dbPath),productions=new ProductionStore(store);
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
    if(disk)for(const suffix of ['','-wal','-shm','.provision'])try{const file=dbPath+suffix,s=await lstat(file);assert.ok(s.isFile()&&!s.isSymbolicLink());await unlink(file);}catch(e){if(e.code!=='ENOENT')throw e;}
    await rmdir(root);
  });
  const url=`http://127.0.0.1:${port}`,headers={Authorization:'Bearer synthetic-only','X-DSH-Session':'review-session','Content-Type':'application/json'};
  const draft=(requestId,overrides={})=>({productionId:p.id,expectedRevision:0,modelProfile:profile,mode:'t2i',official,inputRoles:[],rationale:'test',...(requestId===undefined?{}:{requestId}),...overrides});
  const post=(path,body)=>fetch(url+path,{method:'POST',headers,body:JSON.stringify(body)});
  const get=(path,session='review-session')=>fetch(url+path,{headers:{...headers,'X-DSH-Session':session}});
  return {root,dbPath,store,productions,registry,p,draft,post,get,url};
}

test('invalid workflow has a durable rejected receipt and can be corrected with a new request',async t=>{
  const f=await setup(t),first=randomUUID();
  const invalid=await f.post('/api/workflows/draft',f.draft(first,{official:{...f.draft(first).official,width:17}}));
  assert.ok(invalid.status>=400&&invalid.status<500,`pre-write input rejection was ${invalid.status}`);
  const row=f.store.db.prepare('SELECT state FROM workflow_preparations WHERE request_id=?').get(first);assert.equal(row.state,'rejected');
  const proof=await f.get(`/api/workflow-requests/by-request?requestId=${first}`);assert.equal(proof.status,200);assert.equal((await proof.json()).receipt.state,'rejected');
  const fixed=await f.post('/api/workflows/draft',f.draft(randomUUID()));assert.equal(fixed.status,201,await fixed.text());
});

test('DSH distinguishes a verified canvas rejection from an unverifiable response',async t=>{
  const f=await setup(t);
  for(const tamper of [false,true]){
    const base=await realpath(parent),root=await mkdtemp(join(base,'review-workflow-rejection-'));
    await mkdir(join(root,'data'));
    const journal=await openMutationJournal(root);
    t.after(async()=>{journal.close();assert.equal(await realpath(root),root);assert.ok(root.startsWith(base+sep));await rm(root,{recursive:true,force:true});});
    const name='local_moss_official_prepare',callId='prepare';
    const events=[{seq:0,type:'tool/call',data:{callId,name,turn:1,step:1}}];
    const session={id:'review-session',surface:{nodes:[]},snapshotEvents:()=>events,deriveMessages:()=>[]};
    const sessions={flush:async()=>true};
    const persistence={flush:async()=>{},open:async(id,access)=>({id,access,read:async()=>({events}),close:async()=>{}})};
    const requestId=randomUUID(),valid=f.draft(requestId),input={...valid,official:{...valid.official,width:1344,height:756}};
    let posts=0,reads=0;
    const run=runDurableOwnedMutation({journal,session,sessions,persistence,mapSessionId:id=>id,currentCallId:callId,toolName:name,
      operation:'workflow-draft',targetId:f.p.id,input,correlationHash:digest({expectedRevision:input.expectedRevision}),wireProof:async()=>true,
      async send(){
        posts++;
        const response=await f.post('/api/workflows/draft',input);
        assert.equal(response.status,400);
        const {receipt,error}=await response.json();
        return {receipt,diagnostic:error};
      },
      async readProof(intent,direct){
        reads++;
        assert.equal(intent.requestId,requestId);
        assert.equal(direct.receipt.state,'rejected');
        const response=await f.get(`/api/workflow-requests/by-request?requestId=${requestId}`);
        assert.equal(response.status,200);
        const proof=await response.json();
        if(tamper)proof.receipt.payloadHash='0'.repeat(64);
        return proof;
      },
    });
    if(tamper){
      await assert.rejects(run,/unresolved/i);
      assert.equal(journal.pending(session.id)[0].state,'intent');
    }else{
      const result=await run;
      assert.equal(result.value.state,'rejected');
      assert.match(result.value.diagnostic,/16-pixel aligned/);
      assert.equal(journal.pending(session.id)[0].outcome,'rejected');
    }
    assert.equal(posts,1);
    assert.equal(reads,1);
    assert.equal(f.productions.get(f.p.id,session.id).revision,0);
  }
});

test('durable DSH coordinator resolves the same saved workflow after HTTP reply loss without another draft',async t=>{
  const f=await setup(t),base=await realpath(parent),root=await mkdtemp(join(base,'review-workflow-journal-'));assert.ok(root.startsWith(base+sep));await mkdir(join(root,'data'));let journal=await openMutationJournal(root),posts=0,gets=0,tamper=false;
  t.after(async()=>{journal.close();assert.equal(await realpath(root),root);assert.ok(root.startsWith(base+sep));await rm(root,{recursive:true,force:true});});
  const events=[],session={id:'review-session',surface:{nodes:[]},snapshotEvents:()=>events,deriveMessages:()=>[]},sessions={flush:async()=>true},persistence={flush:async()=>{},open:async(id,access)=>({id,access,read:async seq=>({events:events.filter(x=>x.seq===seq)}),close:async()=>{}})},common={journal,session,sessions,persistence,mapSessionId:id=>id,wireProof:async()=>true};let serial=0;
  const call=name=>{const callId=`call-${++serial}`;events.push({seq:events.length,type:'tool/call',data:{callId,name,turn:1,step:serial}});return callId;},args=f.draft(randomUUID()),id=args.requestId;
  const readProof=async()=>{gets++;const status=await f.get(`/api/workflow-requests/by-request?requestId=${id}`);assert.equal(status.status,200);assert.equal((await status.json()).receipt.state,'committed');const response=await f.get(`/api/productions/${f.p.id}/workflow-by-request?requestId=${id}`);assert.equal(response.status,200);const value=await response.json();if(tamper)value.receipt.payloadHash='0'.repeat(64);return value;};
  const mutate=()=>runDurableOwnedMutation({...common,currentCallId:call('local_moss_official_prepare'),toolName:'local_moss_official_prepare',operation:'workflow-draft',targetId:f.p.id,input:args,correlationHash:digest({expectedRevision:args.expectedRevision}),send:async()=>{posts++;const response=await f.post('/api/workflows/draft',args);assert.equal(response.status,201);await response.arrayBuffer();throw Error('response lost after committed preparation');},readProof});
  const reconcile=()=>reconcileDurableOwnedMutation({...common,currentCallId:call('local_workflow_reconcile'),toolName:'local_workflow_reconcile',operation:'workflow-draft',targetId:f.p.id,requestId:id,readProof});
  await assert.rejects(mutate(),/response lost/);journal.close();journal=await openMutationJournal(root);common.journal=journal;
  tamper=true;await assert.rejects(reconcile(),/unresolved/);await assert.rejects(mutate(),/unresolved|pending|open|UNIQUE/i);
  tamper=false;const result=await reconcile();assert.equal(posts,1);assert.equal(gets,2);assert.equal(result.value.production.revision,1);assert.equal(journal.pending('review-session')[0].state,'receipt');
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

test('concurrent workflow admission records the loser as rejected before validation',async t=>{
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
    second=f.post('/api/workflows/draft',f.draft(id2));
    const refused=await second;assert.equal(refused.status,409,await refused.text());
    assert.equal(f.store.db.prepare('SELECT state FROM workflow_preparations WHERE request_id=?').get(id2).state,'rejected');
    assert.equal(n,1,'the competing workflow never enters validation');
    allow[0].release();await reserved.promise;
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

test('admin can abandon only the exact inspected pending draft; late file write cannot bind and the receipt replays',async t=>{
  const f=await setup(t),entered=gate(),resume=gate(),original=f.registry.saveDraft.bind(f.registry);
  f.registry.saveDraft=async options=>original({...options,beforeWrite:async snapshot=>{await options.beforeWrite(snapshot);entered.release();await resume.promise;}});
  const requestId=randomUUID(),pending=f.post('/api/workflows/draft',f.draft(requestId));await entered.promise;
  const route=`/api/productions/${f.p.id}/workflow-recovery`,headers={Authorization:'Bearer admin','X-DSH-Session':'review-session','Content-Type':'application/json'};
  const inspect=()=>fetch(`${f.url}${route}?requestId=${requestId}`,{headers}),abandon=input=>fetch(f.url+route,{method:'POST',headers,body:JSON.stringify(input)});
  try {
    assert.equal((await f.get(`${route}?requestId=${requestId}`)).status,403);
    assert.equal((await f.post(route,{})).status,403);
    const response=await inspect();assert.equal(response.status,200);const inspected=await response.json(),receipt=inspected.receipt;
    assert.equal(receipt.state,'started');assert.equal(receipt.productionId,f.p.id);assert.equal(receipt.sessionId,'review-session');
    const input={requestId,payloadHash:receipt.payloadHash,expectedRevision:receipt.expectedRevision,observedRevision:inspected.production.revision};
    for(const invalid of [{...input,payloadHash:'0'.repeat(64)},{...input,expectedRevision:99},{...input,observedRevision:99}]){
      const denied=await abandon(invalid);assert.equal(denied.status,409,await denied.text());
      assert.equal(f.store.db.prepare('SELECT state FROM workflow_preparations WHERE request_id=?').get(requestId).state,'started');
    }
    const accepted=await abandon(input);assert.equal(accepted.status,200,await accepted.clone().text());const first=await accepted.json();assert.equal(first.receipt.state,'abandoned');assert.equal(first.created,true);
    const duplicate=await abandon(input);assert.equal(duplicate.status,200);const repeated=await duplicate.json();assert.equal(repeated.created,false);assert.deepEqual(repeated.receipt,first.receipt);
    assert.equal((await abandon({...input,observedRevision:1})).status,409);
    resume.release();const late=await pending;assert.equal(late.status,503,await late.text());
    assert.equal((await readdir(join(f.root,'workflows','drafts'))).length,1,'late file is retained');
    assert.equal(f.productions.get(f.p.id,'review-session').workflowId,null);
    assert.equal(f.productions.get(f.p.id,'review-session').revision,0);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM events WHERE type='workflow_preparation_abandoned'").get().n,1);
    assert.equal((await f.post('/api/workflows/draft',f.draft(requestId))).status,409,'abandoned request identity cannot be reused');
    const next=await f.post('/api/workflows/draft',f.draft(randomUUID()));assert.equal(next.status,201,await next.text());
  } finally {resume.release();await pending.catch(()=>{});}
});

test('committed workflow cannot be abandoned and remains independently retrievable',async t=>{
  const f=await setup(t),requestId=randomUUID(),saved=await f.post('/api/workflows/draft',f.draft(requestId));assert.equal(saved.status,201);
  const route=`/api/productions/${f.p.id}/workflow-recovery`,headers={Authorization:'Bearer admin','X-DSH-Session':'review-session','Content-Type':'application/json'};
  const inspection=await fetch(`${f.url}${route}?requestId=${requestId}`,{headers}),{receipt,production}=await inspection.json();assert.equal(receipt.state,'committed');
  const result=await fetch(f.url+route,{method:'POST',headers,body:JSON.stringify({requestId,payloadHash:receipt.payloadHash,expectedRevision:receipt.expectedRevision,observedRevision:production.revision})});
  assert.equal(result.status,409);assert.equal((await f.get(`/api/productions/${f.p.id}/workflow-by-request?requestId=${requestId}`)).status,200);
});

test('separate process abandons an in-flight durable preparation and the late bind cannot commit',async t=>{
  const f=await setup(t,{disk:true}),entered=gate(),resume=gate(),original=f.registry.saveDraft.bind(f.registry);
  f.registry.saveDraft=async options=>original({...options,beforeWrite:async snapshot=>{await options.beforeWrite(snapshot);entered.release();await resume.promise;}});
  const requestId=randomUUID(),pending=f.post('/api/workflows/draft',f.draft(requestId));await entered.promise;
  try {
    const row=f.productions.inspectWorkflowRecovery(f.p.id,'review-session',requestId),r=row.receipt;
    const data={dbPath:f.dbPath,id:f.p.id,session:'review-session',input:{requestId,payloadHash:r.payloadHash,expectedRevision:r.expectedRevision,observedRevision:row.production.revision}};
    const script=`import {RunStore} from ${JSON.stringify(pathToFileURL(resolve('apps/controller/store.mjs')).href)};import {ProductionStore} from ${JSON.stringify(pathToFileURL(resolve('apps/controller/productions.mjs')).href)};const d=JSON.parse(process.env.WORKFLOW_RECOVERY_FIXTURE);const s=new RunStore(d.dbPath);const p=new ProductionStore(s);const result=p.abandonWorkflowPreparation(d.id,d.session,d.input);console.log(JSON.stringify(result));s.close();`;
    const child=spawn(process.execPath,['--input-type=module','-e',script],{env:{...process.env,WORKFLOW_RECOVERY_FIXTURE:JSON.stringify(data)},stdio:['ignore','pipe','pipe'],windowsHide:true});let output='',error='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>error+=c);
    const code=await new Promise((done,fail)=>{child.on('error',fail);child.on('exit',done);});assert.equal(code,0,error);assert.equal(JSON.parse(output).receipt.state,'abandoned');
    resume.release();assert.equal((await pending).status,503);assert.equal(f.productions.get(f.p.id,'review-session').workflowId,null);
    assert.equal(f.productions.inspectWorkflowRecovery(f.p.id,'review-session',requestId).receipt.state,'abandoned');
    const reopenedStore=new RunStore(f.dbPath),reopened=new ProductionStore(reopenedStore);
    try {assert.equal(reopened.inspectWorkflowRecovery(f.p.id,'review-session',requestId).receipt.state,'abandoned');assert.equal(reopened.abandonWorkflowPreparation(f.p.id,'review-session',data.input).created,false);assert.equal(reopened.get(f.p.id,'review-session').revision,0);}finally{reopenedStore.close();}
  } finally {resume.release();await pending.catch(()=>{});}
});

test('revision change and failed audit write both leave the pending workflow locked',async t=>{
  const f=await setup(t),requestId=randomUUID(),input=f.draft(requestId);
  f.productions.beginWorkflowPreparation(f.p.id,'review-session',input);
  const r=f.productions.inspectWorkflowRecovery(f.p.id,'review-session',requestId).receipt,proof={requestId,payloadHash:r.payloadHash,expectedRevision:r.expectedRevision,observedRevision:0};
  const originalEvent=f.store.event.bind(f.store);f.store.event=()=>{throw Error('audit unavailable');};
  assert.throws(()=>f.productions.abandonWorkflowPreparation(f.p.id,'review-session',proof),/audit unavailable/);f.store.event=originalEvent;
  assert.equal(f.productions.inspectWorkflowRecovery(f.p.id,'review-session',requestId).receipt.state,'started');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM workflow_preparation_abandons').get().n,0);
  f.productions.cancel(f.p.id,'review-session');
  assert.throws(()=>f.productions.abandonWorkflowPreparation(f.p.id,'review-session',proof),/状態が変化/);
  assert.equal(f.productions.inspectWorkflowRecovery(f.p.id,'review-session',requestId).receipt.state,'started');
  assert.equal(f.productions.abandonWorkflowPreparation(f.p.id,'review-session',{...proof,observedRevision:1}).created,true);
});

test('a rejected request is hash-bound and no delayed copy or changed same-ID retry enters validation',async t=>{
  const f=await setup(t),id=randomUUID(),input=f.draft(id,{official:{...f.draft(id).official,width:17}}),original=f.registry.saveDraft.bind(f.registry);let calls=0;
  f.registry.saveDraft=async options=>{calls++;return original(options);};
  const first=await f.post('/api/workflows/draft',input);assert.equal(first.status,400);
  const {receipt}=await (await f.get(`/api/workflow-requests/by-request?requestId=${id}`)).json();
  assert.equal(receipt.state,'rejected');assert.equal(receipt.payloadHash,digest(input));assert.equal(receipt.productionId,f.p.id);assert.equal(receipt.sessionId,'review-session');assert.equal(receipt.operation,'workflow-draft');assert.equal(receipt.reason,'rejected-before-workflow-write');assert.equal(receipt.inputCacheMayExist,true);
  assert.equal((await f.post('/api/workflows/draft',input)).status,409);
  assert.equal((await f.post('/api/workflows/draft',f.draft(id))).status,409);
  assert.equal(calls,1);assert.equal(f.productions.get(f.p.id,'review-session').revision,0);
  assert.equal((await f.get(`/api/workflow-requests/by-request?requestId=${id}`,'other-session')).status,404);
  assert.equal((await f.post('/api/workflows/draft',f.draft(randomUUID()))).status,201);
});

test('a nonexistent production is rejected without leaking another session and its fence survives a DB reopen',async t=>{
  const f=await setup(t,{disk:true}),id=randomUUID(),input=f.draft(id,{productionId:randomUUID()});
  assert.equal((await f.post('/api/workflows/draft',input)).status,404);
  const response=await f.get(`/api/workflow-requests/by-request?requestId=${id}`);assert.equal(response.status,200);const {receipt}=await response.json();assert.equal(receipt.state,'rejected');assert.equal(receipt.productionId,input.productionId);assert.equal(receipt.payloadHash,digest(input));
  assert.equal((await f.get(`/api/workflow-requests/by-request?requestId=${id}`,'other-session')).status,404);
  const otherStore=new RunStore(f.dbPath),other=new ProductionStore(otherStore);try{assert.deepEqual(other.inspectWorkflowRequest('review-session',id).receipt,receipt);assert.equal(other.reserveWorkflowPreparation('review-session',input).admitted,false);}finally{otherStore.close();}
});

test('uppercase UUID admitted by the client preflight is durably rejected when no exact production exists',async t=>{
  const f=await setup(t),id=randomUUID(),input=f.draft(id,{productionId:randomUUID().toUpperCase()});
  assert.equal((await f.post('/api/workflows/draft',input)).status,404);
  const {receipt}=await (await f.get(`/api/workflow-requests/by-request?requestId=${id}`)).json();
  assert.equal(receipt.state,'rejected');assert.equal(receipt.productionId,input.productionId);assert.equal(receipt.payloadHash,digest(input));
});

test('rejection-audit failure preserves started state and never labels an uncertain write rejected',async t=>{
  const f=await setup(t),id=randomUUID(),input=f.draft(id,{official:{...f.draft(id).official,width:17}});
  f.store.db.exec("CREATE TRIGGER fail_workflow_rejection BEFORE INSERT ON workflow_preparation_rejections BEGIN SELECT RAISE(ABORT,'injected'); END");
  assert.equal((await f.post('/api/workflows/draft',input)).status,503);
  assert.equal(f.store.db.prepare('SELECT state FROM workflow_preparations WHERE request_id=?').get(id).state,'started');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM workflow_preparation_rejections WHERE request_id=?').get(id).n,0);
  assert.equal((await (await f.get(`/api/workflow-requests/by-request?requestId=${id}`)).json()).receipt.state,'started');
  assert.equal((await f.post('/api/workflows/draft',input)).status,409);
});

test('admin can abandon only its own exact orphan fence without resolving its nonexistent target',async t=>{
  const f=await setup(t,{disk:true}),id=randomUUID(),input=f.draft(id,{productionId:randomUUID()}),fence=f.productions.reserveWorkflowPreparation('review-session',input);
  const proof={requestId:id,productionId:input.productionId,payloadHash:fence.payloadHash,expectedRevision:input.expectedRevision},path='/api/workflow-requests/abandon';
  const admin=(value,session='review-session')=>fetch(f.url+path,{method:'POST',headers:{Authorization:'Bearer admin','X-DSH-Session':session,'Content-Type':'application/json'},body:JSON.stringify(value)});
  assert.equal((await f.post(path,proof)).status,403);assert.equal((await admin(proof,'other-session')).status,404);assert.equal((await admin({...proof,payloadHash:'0'.repeat(64)})).status,404);
  const first=await admin(proof);assert.equal(first.status,200);const value=await first.json();assert.equal(value.created,true);assert.equal(value.receipt.state,'abandoned');assert.equal(value.receipt.workflowFileMayExist,true);assert.equal(value.receipt.inputCacheMayExist,true);
  assert.equal((await (await admin(proof)).json()).created,false);assert.equal((await (await f.get(`/api/workflow-requests/by-request?requestId=${id}`)).json()).receipt.state,'abandoned');
  assert.equal((await f.post('/api/workflows/draft',input)).status,409);
  const otherStore=new RunStore(f.dbPath),other=new ProductionStore(otherStore);try{assert.equal(other.inspectWorkflowRequest('review-session',id).receipt.state,'abandoned');assert.equal(other.abandonWorkflowFence('review-session',proof).created,false);}finally{otherStore.close();}
  assert.equal(f.productions.get(f.p.id,'review-session').workflowId,null);
});

test('admin fence abandonment prevents an already admitted late file from binding, preserving the file',async t=>{
  const f=await setup(t),entered=gate(),resume=gate(),original=f.registry.saveDraft.bind(f.registry),id=randomUUID(),input=f.draft(id);
  f.registry.saveDraft=async options=>original({...options,beforeWrite:async snapshot=>{await options.beforeWrite(snapshot);entered.release();await resume.promise;}});
  const pending=f.post('/api/workflows/draft',input);await entered.promise;
  try{
    const proof={requestId:id,productionId:f.p.id,payloadHash:digest(input),expectedRevision:0};
    const response=await fetch(f.url+'/api/workflow-requests/abandon',{method:'POST',headers:{Authorization:'Bearer admin','X-DSH-Session':'review-session','Content-Type':'application/json'},body:JSON.stringify(proof)});assert.equal(response.status,200,await response.clone().text());
    resume.release();assert.equal((await pending).status,503);assert.equal(f.productions.get(f.p.id,'review-session').workflowId,null);assert.equal(f.productions.get(f.p.id,'review-session').revision,0);
    assert.equal((await readdir(join(f.root,'workflows','drafts'))).length,1);assert.equal((await (await f.get(`/api/workflow-requests/by-request?requestId=${id}`)).json()).receipt.state,'abandoned');
  }finally{resume.release();await pending.catch(()=>{});}
});

test('fence abandonment audit failure rolls back and preserves the started request',async t=>{
  const f=await setup(t),id=randomUUID(),input=f.draft(id),fence=f.productions.reserveWorkflowPreparation('review-session',input),proof={requestId:id,productionId:f.p.id,payloadHash:fence.payloadHash,expectedRevision:0};
  f.store.db.exec("CREATE TRIGGER fail_fence_abandon BEFORE INSERT ON workflow_request_fence_abandons BEGIN SELECT RAISE(ABORT,'injected'); END");
  const result=await fetch(f.url+'/api/workflow-requests/abandon',{method:'POST',headers:{Authorization:'Bearer admin','X-DSH-Session':'review-session','Content-Type':'application/json'},body:JSON.stringify(proof)});assert.equal(result.status,500);
  assert.equal(f.productions.inspectWorkflowRequest('review-session',id).receipt.state,'started');assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM workflow_request_fence_abandons').get().n,0);
});

test('two independent Controller processes reserve one workflow request and cannot reopen a rejected identity',async t=>{
  const f=await setup(t,{disk:true}),id=randomUUID(),input=f.draft(id),data={dbPath:f.dbPath,session:'review-session',input};
  const script=`import {RunStore} from ${JSON.stringify(pathToFileURL(resolve('apps/controller/store.mjs')).href)};import {ProductionStore} from ${JSON.stringify(pathToFileURL(resolve('apps/controller/productions.mjs')).href)};const x=JSON.parse(process.env.WORKFLOW_FENCE_FIXTURE),s=new RunStore(x.dbPath);try{console.log(JSON.stringify(new ProductionStore(s).reserveWorkflowPreparation(x.session,x.input)));}finally{s.close();}`;
  const launch=()=>new Promise((done,fail)=>{const child=spawn(process.execPath,['--input-type=module','-e',script],{env:{...process.env,WORKFLOW_FENCE_FIXTURE:JSON.stringify(data)},stdio:['ignore','pipe','pipe'],windowsHide:true});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',fail);child.on('exit',code=>code===0?done(JSON.parse(out)):fail(Error(err)));});
  const [first,second]=await Promise.all([launch(),launch()]);assert.deepEqual([first.admitted,second.admitted].sort(),[false,true]);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM workflow_preparations WHERE session_id=? AND request_id=?').get('review-session',id).n,1);
  const prep=first.admitted?first:second,receipt=f.productions.rejectWorkflowPreparation('review-session',f.p.id,input,prep,400);assert.equal(receipt.state,'rejected');
  const late=await launch();assert.equal(late.admitted,false);assert.equal(late.state,'rejected');assert.equal(f.productions.get(f.p.id,'review-session').workflowId,null);
});
