import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {RunStore} from '../apps/controller/store.mjs';
import {SearchService} from '../apps/controller/search/service.mjs';
import {pinSearchStopDatabase} from '../apps/dsh-plugins/local-genai/search-stop-db.mjs';
import {createGateway} from '../apps/dsh-plugins/local-genai/gateway.mjs';
import {migrateFixture,stageAndRecord} from './support/cutover-fixture.mjs';

test('stop-only gateway write prevents delayed same-turn admission and cannot stop a newer turn',async()=>{
 const root=await mkdtemp(join(tmpdir(),'search-stop-fixture-'));await mkdir(join(root,'data/controller'),{recursive:true});const store=new RunStore(join(root,'data/controller/controller.db')),search=new SearchService({root,store}),guard=pinSearchStopDatabase(root);
 try{
  const session='desktop:owned';search.registerUserTurn(session,1);assert.equal(guard.stop(session,1),'stopped');
  assert.throws(()=>search.registerUserTurn(session,1),e=>e.code==='SESSION_STOPPED');assert.throws(()=>search.ensureSessionOpen(session),e=>e.code==='SESSION_STOPPED');
  search.registerUserTurn(session,2);assert.equal(guard.stop(session,1),'superseded');search.ensureSessionOpen(session);
  assert.equal(guard.stop(session,2),'stopped');assert.throws(()=>search.ensureSessionOpen(session),e=>e.code==='SESSION_STOPPED');
  search.registerUserTurn('other',1);search.ensureSessionOpen('other');
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});
test('cutover stop writes affect only the new generation, preserving the old stopped turn',async()=>{
 const root=await mkdtemp(join(tmpdir(),'search-stop-cutover-'));await mkdir(join(root,'data/controller'),{recursive:true});const store=new RunStore(join(root,'data/controller/controller.db')),search=new SearchService({root,store}),guard=pinSearchStopDatabase(root);
 try{search.registerUserTurn('owned',1);assert.equal(guard.stop('owned',1),'stopped');migrateFixture(store);stageAndRecord(store,{session_id:'owned',generation_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',boundary_turn:1,boundary_seq:5,session_hash:'1'.repeat(64),ledger_hash:'2'.repeat(64),database_hash:'3'.repeat(64),controller_hash:'4'.repeat(64),host_hash:'5'.repeat(64),backup_hash:'6'.repeat(64)});search.registerUserTurn('owned',2);assert.throws(()=>guard.stop('owned',1),/legacy turn/);assert.equal(guard.stop('owned',2),'stopped');assert.throws(()=>search.registerUserTurn('owned',2),e=>e.code==='SESSION_STOPPED');assert.equal(store.db.prepare("SELECT stopped_at FROM search_session_turns WHERE session_id='owned'").get().stopped_at,1);assert.equal(store.db.prepare("SELECT stopped_at FROM search_cutover_turns WHERE session_id='owned'").get().stopped_at,2);}finally{store.close();await rm(root,{recursive:true,force:true});}
});
test('missing or uninitialized databases never receive a stop write',async()=>{
 const root=await mkdtemp(join(tmpdir(),'search-stop-missing-'));await mkdir(join(root,'data/controller'),{recursive:true});
 try{assert.throws(()=>pinSearchStopDatabase(root));await writeFile(join(root,'data/controller/controller.db'),'broken');assert.throws(()=>pinSearchStopDatabase(root));}
 finally{await rm(root,{recursive:true,force:true});}
});
test('a pinned database replacement or new SQL trigger fails closed',async()=>{
 const root=await mkdtemp(join(tmpdir(),'search-stop-swap-'));await mkdir(join(root,'data/controller'),{recursive:true});const path=join(root,'data/controller/controller.db');let store=new RunStore(path);new SearchService({root,store});const guard=pinSearchStopDatabase(root);
 try{
  store.db.exec("CREATE TRIGGER forbid_search_stop BEFORE UPDATE ON search_session_turns BEGIN SELECT RAISE(ABORT,'fixture'); END");assert.throws(()=>guard.stop('owned',1),/schema changed/);store.db.exec('DROP TRIGGER forbid_search_stop');
  store.close();store=null;await rename(path,path+'.original');const replacementPath=path+'.replacement',replacement=new RunStore(replacementPath);new SearchService({root,store:replacement});replacement.close();await rename(replacementPath,path);
  assert.throws(()=>guard.stop('owned',1),/generation changed/);assert.throws(()=>new RunStore(path),/generation differs/);
 }finally{store?.close();await rm(root,{recursive:true,force:true});}
});
test('abort persists the exact stop before a failed cancellation HTTP request and late registration',async()=>{
 const root=await mkdtemp(join(tmpdir(),'search-stop-abort-'));await mkdir(join(root,'data/controller'),{recursive:true});const store=new RunStore(join(root,'data/controller/controller.db')),search=new SearchService({root,store}),hooks=new Map(),ctx={on:(name,fn)=>hooks.set(name,fn)};let finishRegistration,cancelCalls=0;
 const gateway=await createGateway(ctx,{runtimeRoot:root},{loadConfiguration:async()=>({controllerUrl:'http://127.0.0.1:3090',token:'x'.repeat(64)}),loadDshLlmBindings:async()=>({LlmError:class extends Error{},IMAGE_OFFLOAD_REQUIRED_CODE:'fixture'}),isManagedAgent:()=>true,createOwnerContext:async()=>({birth:{},owner:{activate(){},needsLegacyAttestation(){return false;},async begin(){},async complete(){}}}),fetch:async (url,options)=>{
  if(url.endsWith('/gateway-register'))return Response.json({sessionId:'owned',hostId:JSON.parse(options.body).hostId,registered:true});if(url.endsWith('/user-turn'))return new Promise(resolve=>{finishRegistration=resolve;});if(url.endsWith('/cancel-turn')){cancelCalls++;throw Error('offline');}throw Error('unexpected');
 }});
 try{
  const abort=new AbortController(),agent={options:{provider:'local-strata',model:'strata-core'},session:{id:'owned',snapshotEvents:()=>[{type:'turn/start',data:{turn:1}}]}};
  const run=hooks.get('agent/pre-step')({agent,turn:1,step:1,messages:[{source:{kind:'user'}}],signal:abort.signal},()=>assert.fail('Aborted turn must not continue'));
  while(!finishRegistration)await new Promise(resolve=>setImmediate(resolve));abort.abort(Error('synthetic stop'));assert.throws(()=>search.registerUserTurn('owned',1),e=>e.code==='SESSION_STOPPED');
  finishRegistration(Response.json({sessionId:'owned',turn:1}));await assert.rejects(run,/synthetic stop/);assert.equal(cancelCalls,1);assert.throws(()=>search.ensureSessionOpen('owned'),e=>e.code==='SESSION_STOPPED');
 }finally{await gateway.dispose();store.close();await rm(root,{recursive:true,force:true});}
});
test('stop database failure is reported even when delegated work otherwise returns normally',async()=>{
 const hooks=new Map(),ctx={on:(name,fn)=>hooks.set(name,fn)};let finishNext,entered;
 const ready=new Promise(resolve=>{entered=resolve;}),next=new Promise(resolve=>{finishNext=resolve;});
 const gateway=await createGateway(ctx,{runtimeRoot:process.cwd()},{loadConfiguration:async()=>({controllerUrl:'http://127.0.0.1:3090',token:'x'.repeat(64)}),loadDshLlmBindings:async()=>({LlmError:class extends Error{},IMAGE_OFFLOAD_REQUIRED_CODE:'fixture'}),isManagedAgent:()=>true,createOwnerContext:async()=>({birth:{},owner:{activate(){},needsLegacyAttestation(){return false;},async begin(){},async complete(){}}}),pinSearchStopDatabase:()=>({stop(){throw Error('database unavailable');}}),fetch:async(url,options)=>{if(url.endsWith('/gateway-register'))return Response.json({sessionId:'owned',hostId:JSON.parse(options.body).hostId,registered:true});if(url.endsWith('/user-turn'))return Response.json({sessionId:'owned',turn:1});throw Error('cancel HTTP offline');}});
 try{const abort=new AbortController(),agent={options:{provider:'local-strata',model:'strata-core'},session:{id:'owned',snapshotEvents:()=>[{type:'turn/start',data:{turn:1}}]}};
  const run=hooks.get('agent/pre-step')({agent,turn:1,step:1,messages:[{source:{kind:'user'}}],signal:abort.signal},async()=>{entered();return next;});await ready;abort.abort(Error('stop'));finishNext('normal');
  await assert.rejects(run,error=>error.uncertain===true&&/could not be durably recorded/.test(error.message));
  await assert.rejects(hooks.get('agent/pre-step')({agent,turn:2,step:1,messages:[{source:{kind:'user'}}],signal:new AbortController().signal},()=>assert.fail('A new turn cannot reopen an unresolved stop')),/could not be durably recorded/);
 }finally{finishNext();await gateway.dispose();}
});
test('a concurrent Controller SQLite transaction serializes before the exact stop row',async()=>{
 const root=await mkdtemp(join(tmpdir(),'search-stop-concurrent-'));await mkdir(join(root,'data/controller'),{recursive:true});const file=join(root,'data/controller/controller.db'),store=new RunStore(file),search=new SearchService({root,store}),guard=pinSearchStopDatabase(root);search.registerUserTurn('owned',1);
 const code="const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec('PRAGMA busy_timeout=3000; BEGIN IMMEDIATE;');process.stdout.write('locked');setTimeout(()=>{d.exec('COMMIT');d.close();},300);";
 const child=spawn(process.execPath,['-e',code,file],{stdio:['ignore','pipe','pipe'],windowsHide:true});
 try{await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',code=>{if(code!==0)reject(Error('Lock fixture failed'));});});assert.equal(guard.stop('owned',1),'stopped');await new Promise((resolve,reject)=>child.once('exit',code=>code===0?resolve():reject(Error('Lock fixture failed'))));assert.throws(()=>search.ensureSessionOpen('owned'),e=>e.code==='SESSION_STOPPED');}
 finally{if(child.exitCode===null)child.kill();store.close();await rm(root,{recursive:true,force:true});}
});
