import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer as reservePort} from 'node:net';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,lstatSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {searchRoute} from '../apps/controller/search-http.mjs';
import {createControllerServer} from '../apps/controller/http.mjs';
import {RunStore} from '../apps/controller/store.mjs';
import {SearchService} from '../apps/controller/search/service.mjs';
import {updateOwnerManifest} from '../apps/controller/search/owner-manifest.mjs';
import {updateSearchLedgerManifest} from '../apps/controller/search/ledger-schema.mjs';
import {migrateFixture,stageAndRecord} from './support/cutover-fixture.mjs';
import {ProductionStore} from '../apps/controller/productions.mjs';

function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}

test('real HTTP rejects an old proposal and requires fresh approval after a fixture cutover',async t=>{
 const base=resolve(tmpdir()),root=mkdtempSync(join(base,'http-cutover-')),store=new RunStore(':memory:'),hostId=randomUUID(),ticks='638000000000000000',executable='C:\\Apps\\DSH\\dsh.exe',sent=[];
 migrateFixture(store);const productions=new ProductionStore(store),ownerProbe={processes:async pids=>pids.map(pid=>({pid,startTimeUtcTicks:ticks,executable}))},search=new SearchService({root,store,requireTurnOwner:true,ownerProbe,fetchImpl:async url=>{sent.push(new URL(url).searchParams.get('q'));return Response.json({results:[]});}});
 store.transaction(()=>{store.db.prepare("INSERT INTO search_session_host_generations VALUES(?,?,?,'active',?,?)").run('owner',hostId,1234,ticks,executable);store.db.prepare("INSERT INTO search_turn_owners VALUES(?,?,?,'active',1,NULL,NULL)").run('owner',1,hostId);updateOwnerManifest(store.db);});await search.registerUserTurn('owner',1,hostId);
 const old=await search.propose({sessionId:'owner',turn:1,queries:['old fixture'],purpose:'fixture',requestId:randomUUID(),requestPayloadHash:'a'.repeat(64)}),row={session_id:'owner',generation_id:randomUUID(),boundary_turn:1,boundary_seq:5,session_hash:'1'.repeat(64),ledger_hash:'2'.repeat(64),database_hash:'3'.repeat(64),controller_hash:'4'.repeat(64),host_hash:'5'.repeat(64),backup_hash:'6'.repeat(64)};stageAndRecord(store,row);
 const holder=reservePort();await new Promise(ok=>holder.listen(0,'127.0.0.1',ok));const port=holder.address().port;await new Promise(ok=>holder.close(ok));const server=createControllerServer({store,engine:{work:new Set()},productions,workflows:{},search,token:'admin-secret',dshToken:'dsh-secret',port});await new Promise(ok=>server.listen(port,'127.0.0.1',ok));
 t.after(async()=>{server.closeAllConnections();await new Promise(ok=>server.close(ok));store.close();assert.ok(resolve(root).startsWith(base+sep));const walk=p=>{const s=lstatSync(p);assert.equal(s.isSymbolicLink(),false);if(s.isDirectory())for(const n of readdirSync(p))walk(join(p,n));};walk(root);rmSync(root,{recursive:true});});
 const call=(path,input,admin=false)=>fetch(`http://127.0.0.1:${port}${path}`,{method:'POST',headers:{Authorization:`Bearer ${admin?'admin-secret':'dsh-secret'}`,'X-DSH-Session':'owner','Content-Type':'application/json'},body:JSON.stringify(input)});
 assert.ok([409,503].includes((await call(`/api/search-proposals/${old.id}/approve`,{queries:old.queries,engine:old.engine,proposalHash:old.proposalHash},true)).status));assert.deepEqual(sent,[]);
 store.transaction(()=>{store.db.prepare("UPDATE search_proposal_receipts SET state='started' WHERE proposal_id=?").run(old.id);updateSearchLedgerManifest(store);store.db.prepare("INSERT INTO search_turn_owners VALUES('owner',2,?,'active',6,NULL,NULL)").run(hostId);updateOwnerManifest(store.db);});
 assert.equal((await call('/api/search-proposals/user-turn',{turn:2,hostId})).status,200);const response=await call('/api/search-proposals',{sessionId:'owner',turn:2,requestId:randomUUID(),queries:['new fixture'],purpose:'fixture'});assert.equal(response.status,201);const fresh=(await response.json()).proposal;assert.ok(fresh);assert.deepEqual(sent,[]);assert.equal((await call(`/api/search-proposals/${fresh.id}/approve`,{queries:fresh.queries,engine:fresh.engine,proposalHash:fresh.proposalHash},true)).status,202);
 for(let i=0;i<40&&!sent.length;i++)await new Promise(ok=>setTimeout(ok,10));assert.deepEqual(sent,['new fixture']);assert.equal(store.db.prepare('SELECT state FROM search_proposal_receipts WHERE proposal_id=?').get(old.id).state,'started');
});

test('HTTP waits for asynchronous proposal and approval before responding or sending',async()=>{
  const sessionId='owner',proposal={id:randomUUID(),sessionId,productionId:null,kind:'queries',queries:['fixture'],engine:'duckduckgo',proposalHash:'a'.repeat(64),phase:'awaiting_approval'},pending=deferred(),entered=deferred();let response,background=0;
  const search={enabled:true,ensureCurrentTurn:()=>{},propose:async()=>{entered.resolve();await pending.promise;return proposal;},findProposalByRequest:()=>({proposal,receipt:{state:'committed'}}),status:()=>proposal,approve:async()=>{entered.resolve();await pending.promise;proposal.phase='approved';}};
  const invoke=(method,path,input,role='dsh')=>searchRoute({req:{method,headers:{'x-dsh-session':sessionId}},res:{},path,url:new URL('http://local'+path),role,productions:{},search,body:async()=>input,json:(_r,status,value)=>response={status,value},backgroundSearch:()=>background++});
  const post=invoke('POST','/api/search-proposals',{sessionId,turn:1,requestId:randomUUID(),queries:['fixture'],purpose:'fixture'});await entered.promise;assert.equal(response,undefined);pending.resolve();await post;assert.equal(response.status,201);
  const approveWait=deferred(),approveEntered=deferred();search.approve=async()=>{approveEntered.resolve();await approveWait.promise;proposal.phase='approved';};response=undefined;
  const approving=invoke('POST',`/api/search-proposals/${proposal.id}/approve`,{queries:proposal.queries,engine:proposal.engine,proposalHash:proposal.proposalHash},'admin');await approveEntered.promise;assert.equal(response,undefined);assert.equal(background,0);approveWait.resolve();await approving;assert.equal(response.status,202);assert.equal(background,1);
});

test('a failed asynchronous approval never starts the background search',async()=>{
  const proposal={id:randomUUID(),sessionId:'owner',productionId:null,kind:'queries',queries:['fixture'],engine:'duckduckgo',proposalHash:'a'.repeat(64),phase:'awaiting_approval'};let background=0,response;
  const search={enabled:true,status:()=>proposal,approve:async()=>{await Promise.resolve();const error=Error('identity unavailable');error.status=503;throw error;}};
  await assert.rejects(searchRoute({req:{method:'POST',headers:{'x-dsh-session':'owner'}},res:{},path:`/api/search-proposals/${proposal.id}/approve`,url:new URL('http://local/api/search-proposals/'+proposal.id+'/approve'),role:'admin',productions:{},search,body:async()=>({queries:proposal.queries,engine:proposal.engine,proposalHash:proposal.proposalHash}),json:(_r,status,value)=>response={status,value},backgroundSearch:()=>background++}),e=>e.status===503);
  assert.equal(background,0);assert.equal(response,undefined);
});

test('real HTTP keeps shutdown blocked and accepts stop while registration waits',async t=>{
  const entered=deferred(),release=deferred();let stopped=false,committed=false;
  const search={enabled:true,active:new Map(),persistenceFault:false,list:()=>[],registerUserTurn:async()=>{entered.resolve();await release.promise;if(stopped){const e=Error('stopped');e.status=409;throw e;}committed=true;},cancelTurn:()=>{stopped=true;return [];}};
  const holder=reservePort();await new Promise(ok=>holder.listen(0,'127.0.0.1',ok));const port=holder.address().port;await new Promise(ok=>holder.close(ok));
  const server=createControllerServer({store:{controllerId:randomUUID(),active:()=>null},engine:{work:new Set()},productions:{},workflows:{},search,token:'admin-secret',dshToken:'dsh-secret',port});await new Promise(ok=>server.listen(port,'127.0.0.1',ok));
  t.after(async()=>{release.resolve();server.closeAllConnections();await new Promise(ok=>server.close(ok));});
  const call=(path,input,admin=false)=>fetch(`http://127.0.0.1:${port}${path}`,{method:'POST',headers:{Authorization:`Bearer ${admin?'admin-secret':'dsh-secret'}`,'X-DSH-Session':'owner','Content-Type':'application/json'},body:JSON.stringify(input)});
  const pending=call('/api/search-proposals/user-turn',{turn:1,hostId:randomUUID()});await entered.promise;
  const status=await fetch(`http://127.0.0.1:${port}/api/host-switch-status`,{headers:{Authorization:'Bearer admin-secret'}});assert.ok((await status.json()).busy.includes('controller-admission'));
  assert.equal((await call('/api/shutdown',{},true)).status,409);assert.equal((await call('/api/search-proposals/cancel-turn',{turn:1})).status,200);
  release.resolve();assert.equal((await pending).status,409);assert.equal(committed,false);
});

for(const stopSource of ['search-turn','production'])test(`real strict SearchService does not register a turn stopped by ${stopSource} during Host observation`,async t=>{
  const base=resolve(tmpdir()),root=mkdtempSync(join(base,'http-strict-search-')),store=new RunStore(':memory:'),entered=deferred(),release=deferred(),hostId=randomUUID(),ticks='638000000000000000',executable='C:\\Apps\\DSH\\dsh.exe';
  const productions=new ProductionStore(store),production=productions.create('owner',{requestId:randomUUID(),brief:{request:'portrait',modelProfile:'qwen-photo-v1',mode:'t2i',criteria:[{id:'C1',description:'portrait'}],invariants:[]}}).production;
  const ownerProbe={processes:async pids=>{entered.resolve();await release.promise;return pids.map(pid=>({pid,startTimeUtcTicks:ticks,executable}));}},search=new SearchService({root,store,requireTurnOwner:true,ownerProbe});
  store.transaction(()=>{store.db.prepare("INSERT INTO search_session_host_generations VALUES(?,?,?,'active',?,?)").run('owner',hostId,1234,ticks,executable);store.db.prepare("INSERT INTO search_turn_owners VALUES(?,?,?,'active',1,NULL,NULL)").run('owner',1,hostId);updateOwnerManifest(store.db);});
  const holder=reservePort();await new Promise(ok=>holder.listen(0,'127.0.0.1',ok));const port=holder.address().port;await new Promise(ok=>holder.close(ok));
  const server=createControllerServer({store,engine:{work:new Set()},productions,workflows:{},search,token:'admin-secret',dshToken:'dsh-secret',port});await new Promise(ok=>server.listen(port,'127.0.0.1',ok));
  t.after(async()=>{release.resolve();server.closeAllConnections();await new Promise(ok=>server.close(ok));store.close();assert.ok(resolve(root).startsWith(base+sep));const walk=p=>{const s=lstatSync(p);assert.equal(s.isSymbolicLink(),false);if(s.isDirectory())for(const n of readdirSync(p))walk(join(p,n));};walk(root);rmSync(root,{recursive:true});});
  const call=(path,input,admin=false)=>fetch(`http://127.0.0.1:${port}${path}`,{method:'POST',headers:{Authorization:`Bearer ${admin?'admin-secret':'dsh-secret'}`,'X-DSH-Session':'owner','Content-Type':'application/json'},body:JSON.stringify(input)});
  const pending=call('/api/search-proposals/user-turn',{turn:1,hostId});await entered.promise;
  const health=await fetch(`http://127.0.0.1:${port}/health`);assert.equal(health.status,200);assert.equal((await health.json()).ready,true);assert.equal((await call('/api/shutdown',{},true)).status,409);
  const stopped=stopSource==='search-turn'?await call('/api/search-proposals/cancel-turn',{turn:1}):await call(`/api/productions/${production.id}/cancel`,{requestId:randomUUID(),searchTurn:1});
  assert.equal(stopped.status,stopSource==='search-turn'?200:202);release.resolve();const result=await pending;assert.ok([409,503].includes(result.status));
  assert.equal(store.db.prepare('SELECT stopped_at FROM search_session_turns WHERE session_id=?').get('owner').stopped_at,1);
  if(stopSource==='production')assert.equal(productions.get(production.id,'owner').cancelRequested,true);
});
