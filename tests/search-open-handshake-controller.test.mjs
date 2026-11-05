import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,lstatSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {RunStore} from '../apps/controller/store.mjs';
import {SearchService} from '../apps/controller/search/service.mjs';
import {updateOwnerManifest} from '../apps/controller/search/owner-manifest.mjs';
import {createSearchOpenHandshake} from '../apps/controller/search/open-handshake.mjs';
import {searchOpenKey,searchOpenRequestMac,searchOpenResponseMac} from '../apps/controller/search/open-handshake-codec.mjs';
import {migrateFixture,stageAndRecord} from './support/cutover-fixture.mjs';

function setup(t){
 const root=mkdtempSync(join(tmpdir(),'search-open-fixture-')),store=new RunStore(join(root,'controller.db')),hostId=randomUUID(),sessionId='synthetic-session',token='f'.repeat(64),ticks='638000000000000000',exe='C:\\Apps\\DSH\\dsh.exe';let mode='open',upstream=0,checks=[];
 const probe={processes:async ids=>ids.map(pid=>({pid,startTimeUtcTicks:ticks,executable:exe})),epoch:async({pid})=>({managed:{pid,startTimeUtcTicks:ticks,executable:exe},listener:{pid:mode==='wrong-port'?pid+1:pid,startTimeUtcTicks:ticks,executable:exe,parentPid:1}})};
 const gatewayFetch=async(_url,options)=>{const body=JSON.parse(options.body),{requestMac,...payload}=body;checks.push(payload);assert.equal(requestMac,searchOpenRequestMac(searchOpenKey(token,hostId),payload));if(mode==='closed'||mode==='block-fetch'&&payload.operation==='fetch')return new Response('',{status:403});if(mode==='timeout')return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(Error('timeout')),{once:true}));return Response.json({v:1,challenge:mode==='replay'?'a'.repeat(64):payload.challenge,open:true,responseMac:mode==='forged'?'0'.repeat(64):searchOpenResponseMac(searchOpenKey(token,hostId),payload)});};
 const search=new SearchService({root,store,requireTurnOwner:true,ownerProbe:probe,requireGatewayOpen:true,fetchImpl:async()=>{upstream++;return Response.json({results:[]});}}),gate=createSearchOpenHandshake({store,ownerProbe:probe,token,fetchImpl:gatewayFetch,timeoutMs:100});search.openHandshake=gate;
 store.transaction(()=>{store.db.prepare("INSERT INTO search_session_host_generations VALUES(?,?,?,'active',?,?)").run(sessionId,hostId,process.pid,ticks,exe);store.db.prepare("INSERT INTO search_turn_owners VALUES(?,?,?,'active',?,NULL,NULL)").run(sessionId,1,hostId,1);updateOwnerManifest(store.db);});
 t.after(()=>{store.close();const base=resolve(tmpdir());if(!resolve(root).startsWith(base+sep))throw Error('Unsafe fixture root');const walk=path=>{const item=lstatSync(path);if(item.isSymbolicLink())throw Error('Fixture contains a link');if(item.isDirectory())for(const child of readdirSync(path))walk(join(path,child));};walk(root);rmSync(root,{recursive:true,force:true});});return {store,search,gate,hostId,sessionId,token,probe,checks,setMode:value=>{mode=value;},get upstream(){return upstream;}};
}
async function proposal(f){await f.search.registerUserTurn(f.sessionId,1,f.hostId);return f.search.propose({sessionId:f.sessionId,turn:1,queries:['synthetic query'],purpose:'fixture',requestId:randomUUID(),requestPayloadHash:'a'.repeat(64)});}
const approve=(f,p)=>f.search.approve(p.id,{queries:p.queries,engine:p.engine,actor:'user',proposalHash:p.proposalHash});

test('normal completed turn uses a fresh authenticated open proof for approval, claims and fetch',async t=>{
 const f=setup(t),p=await proposal(f);f.store.transaction(()=>{f.store.db.prepare("UPDATE search_turn_owners SET state='completed',end_seq=2,end_event_hash=? WHERE session_id=?").run('b'.repeat(64),f.sessionId);updateOwnerManifest(f.store.db);});
 await assert.rejects(approve(f,p),e=>e.code==='SEARCH_GATEWAY_UNAVAILABLE');await f.gate.register({sessionId:f.sessionId,hostId:f.hostId,port:30001});await approve(f,p);assert.equal((await f.search.run(p.id,{sessionId:f.sessionId})).phase,'completed');assert.equal(f.upstream,1);assert.deepEqual(f.checks.map(x=>x.operation),['approve','claim','claim','fetch']);assert.equal(new Set(f.checks.map(x=>x.challenge)).size,4);
});
test('closed, forged, replayed and timed-out responses never approve or fetch',async t=>{
 const f=setup(t),p=await proposal(f);await f.gate.register({sessionId:f.sessionId,hostId:f.hostId,port:30002});for(const mode of ['closed','forged','replay','timeout']){f.setMode(mode);await assert.rejects(approve(f,p),e=>e.code==='SEARCH_GATEWAY_UNAVAILABLE');assert.equal(f.search.status(p.id,{sessionId:f.sessionId}).phase,'awaiting_approval');assert.equal(f.upstream,0);}assert.ok(f.search.list({sessionId:f.sessionId}).length===1);
});
test('different session, Host generation, same-port impersonation and Controller restart fail closed',async t=>{
 const f=setup(t),p=await proposal(f);await f.gate.register({sessionId:f.sessionId,hostId:f.hostId,port:30003});await assert.rejects(f.gate.requireOpen({sessionId:'different',turn:1,operation:'approve',proposalId:p.id}));f.setMode('wrong-port');await assert.rejects(f.gate.requireOpen({sessionId:f.sessionId,turn:1,operation:'approve',proposalId:p.id}));f.setMode('open');
 const restarted=createSearchOpenHandshake({store:f.store,ownerProbe:f.probe,token:f.token,fetchImpl:async()=>{throw Error('not called');},timeoutMs:100});await assert.rejects(restarted.requireOpen({sessionId:f.sessionId,turn:1,operation:'approve',proposalId:p.id}));
 f.store.transaction(()=>{f.store.db.prepare("UPDATE search_session_host_generations SET state='superseded' WHERE session_id=?").run(f.sessionId);f.store.db.prepare("INSERT INTO search_session_host_generations VALUES(?,?,?,'active',?,?)").run(f.sessionId,randomUUID(),process.pid,'638000000000000000','C:\\Apps\\DSH\\dsh.exe');updateOwnerManifest(f.store.db);});await assert.rejects(f.gate.requireOpen({sessionId:f.sessionId,turn:1,operation:'approve',proposalId:p.id}));
});
test('closing after claim prevents the outbound fetch and retains uncertainty without automatic retry',async t=>{
 const f=setup(t),p=await proposal(f);await f.gate.register({sessionId:f.sessionId,hostId:f.hostId,port:30004});await approve(f,p);f.setMode('block-fetch');const result=await f.search.run(p.id,{sessionId:f.sessionId});assert.equal(result.phase,'needs_attention');assert.equal(f.upstream,0);assert.equal(f.store.db.prepare('SELECT state FROM search_turn_owner_run_states WHERE proposal_id=?').get(p.id).state,'started');await assert.rejects(f.search.run(p.id,{sessionId:f.sessionId}));assert.equal(f.upstream,0);
});
test('gateway confirmation uses the new generation stop row while preserving the old stopped row',async t=>{
 const f=setup(t);await f.search.registerUserTurn(f.sessionId,1,f.hostId);f.search.cancelTurn(f.sessionId,1);migrateFixture(f.store);
 stageAndRecord(f.store,{session_id:f.sessionId,generation_id:randomUUID(),boundary_turn:1,boundary_seq:5,session_hash:'1'.repeat(64),ledger_hash:'2'.repeat(64),database_hash:'3'.repeat(64),controller_hash:'4'.repeat(64),host_hash:'5'.repeat(64),backup_hash:'6'.repeat(64)});f.store.transaction(()=>{f.store.db.prepare("INSERT INTO search_turn_owners VALUES(?,?,?,'active',6,NULL,NULL)").run(f.sessionId,2,f.hostId);updateOwnerManifest(f.store.db);});
 await f.search.registerUserTurn(f.sessionId,2,f.hostId);await f.gate.register({sessionId:f.sessionId,hostId:f.hostId,port:30005});const p=await f.search.propose({sessionId:f.sessionId,turn:2,queries:['new fixture'],purpose:'fixture',requestId:randomUUID(),requestPayloadHash:'a'.repeat(64)});await approve(f,p);assert.equal((await f.search.run(p.id,{sessionId:f.sessionId})).phase,'completed');assert.equal(f.store.db.prepare('SELECT stopped_at FROM search_session_turns WHERE session_id=?').get(f.sessionId).stopped_at,1);assert.equal(f.store.db.prepare('SELECT stopped_at FROM search_cutover_turns WHERE session_id=?').get(f.sessionId).stopped_at,null);
});
