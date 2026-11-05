import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,lstatSync,readdirSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {RunStore} from '../apps/controller/store.mjs';
import {SearchService} from '../apps/controller/search/service.mjs';
import {updateOwnerManifest} from '../apps/controller/search/owner-manifest.mjs';
import {updateSearchLedgerManifest} from '../apps/controller/search/ledger-schema.mjs';
import {migrateFixture,stageAndRecord} from './support/cutover-fixture.mjs';

function setup(t){
 const base=resolve(tmpdir()),root=mkdtempSync(join(base,'search-turn-owner-')),path=join(root,'controller.db'),store=new RunStore(path),hostId=randomUUID(),sent=[];
 // Synthetic verifier for controller-only fixture; real birth identity is tested separately.
 const ownerProbe={processes:async pids=>pids.map(pid=>({pid,startTimeUtcTicks:'638000000000000000',executable:'C:\\Apps\\DSH\\dsh.exe'}))};
 const options={root,store,requireTurnOwner:true,ownerProbe,verifyLegacyQuiescence:()=>true,fetchImpl:async url=>{sent.push(new URL(url).searchParams.get('q'));return Response.json({results:[]});}};
 migrateFixture(store);const search=new SearchService(options);
 t.after(()=>{store.close();assert.ok(resolve(root).startsWith(base+sep));const walk=p=>{const s=lstatSync(p);assert.equal(s.isSymbolicLink(),false);if(s.isDirectory())for(const n of readdirSync(p))walk(join(p,n));};walk(root);rmSync(root,{recursive:true});});
 const begin=(session='owner',turn=1,host=hostId)=>store.transaction(()=>{store.db.prepare("INSERT INTO search_session_host_generations VALUES(?,?,?,'active',?,?)").run(session,host,process.pid,'638000000000000000','C:\\Apps\\DSH\\dsh.exe');store.db.prepare("INSERT INTO search_turn_owners VALUES(?,?,?,'active',?,NULL,NULL)").run(session,turn,host,1);updateOwnerManifest(store.db);});
 const proposed=(session='owner',turn=1)=>search.propose({sessionId:session,turn,queries:['approved query'],purpose:'fixture',requestId:randomUUID(),requestPayloadHash:'a'.repeat(64)});
 const approve=p=>search.approve(p.id,{queries:p.queries,engine:p.engine,actor:'user',proposalHash:p.proposalHash});
 return {root,path,store,hostId,sent,search,begin,proposed,approve};
}
test('durable owner and matching host are required to register and mutate search',async t=>{
 const f=setup(t);await assert.rejects(f.search.registerUserTurn('owner',1,f.hostId),e=>e.code==='TURN_OWNER_UNKNOWN');f.begin();
 const noIdentity=new SearchService({root:f.root,store:f.store,requireTurnOwner:true});await assert.rejects(noIdentity.registerUserTurn('owner',1,f.hostId),e=>e.code==='TURN_OWNER_UNKNOWN');
 const wrongBirth=new SearchService({root:f.root,store:f.store,requireTurnOwner:true,ownerProbe:{processes:async pids=>pids.map(pid=>({pid,startTimeUtcTicks:'638000000000000001',executable:'C:\\Apps\\DSH\\dsh.exe'}))}});await assert.rejects(wrongBirth.registerUserTurn('owner',1,f.hostId),e=>e.code==='TURN_OWNER_UNKNOWN');
 await assert.rejects(f.search.registerUserTurn('owner',1,randomUUID()),e=>e.code==='TURN_OWNER_UNKNOWN');await f.search.registerUserTurn('owner',1,f.hostId);
 const p=await f.proposed();assert.equal(p.turn,1);f.store.transaction(()=>{f.store.db.prepare("UPDATE search_turn_owners SET state='abandoned' WHERE session_id='owner'").run();updateOwnerManifest(f.store.db);});
 await assert.rejects(f.approve(p),e=>e.code==='TURN_OWNER_UNKNOWN');
});
test('normal completed turn can be approved and sent before a later user turn',async t=>{
 const f=setup(t);f.begin();await f.search.registerUserTurn('owner',1,f.hostId);const p=await f.proposed();
 // This row simulates a turn/end verified by the gateway; no DSH claim is made here.
 f.store.transaction(()=>{f.store.db.prepare("UPDATE search_turn_owners SET state='completed',end_seq=2,end_event_hash=? WHERE session_id='owner'").run('b'.repeat(64));updateOwnerManifest(f.store.db);});
 await f.approve(p);assert.equal((await f.search.run(p.id,{sessionId:'owner'})).phase,'completed');assert.deepEqual(f.sent,['approved query']);
 assert.equal(f.store.db.prepare('SELECT state FROM search_turn_owner_run_states WHERE proposal_id=?').get(p.id).state,'completed');
});
test('after a fixture cutover old proposals cannot be approved, claimed or sent',async t=>{
 const f=setup(t);f.begin();await f.search.registerUserTurn('owner',1,f.hostId);const p=await f.proposed();
 const row={session_id:'owner',generation_id:randomUUID(),boundary_turn:1,boundary_seq:5,session_hash:'1'.repeat(64),ledger_hash:'2'.repeat(64),database_hash:'3'.repeat(64),controller_hash:'4'.repeat(64),host_hash:'5'.repeat(64),backup_hash:'6'.repeat(64)};
 stageAndRecord(f.store,row);
 await assert.rejects(async()=>f.approve(p),e=>['SEARCH_CUTOVER_UNAVAILABLE','TURN_OWNER_UNKNOWN','STALE_TURN'].includes(e.code));await assert.rejects(async()=>f.search.claimRun(f.search.records.get(p.id)),e=>['SEARCH_CUTOVER_UNAVAILABLE','TURN_OWNER_UNKNOWN','STALE_TURN'].includes(e.code));
 assert.deepEqual(f.sent,[]);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM search_run_claims WHERE proposal_id=?').get(p.id).n,0);
});
test('an unresolved old receipt stays fenced while a fresh proposal requires new approval',async t=>{
 const f=setup(t);f.begin();await f.search.registerUserTurn('owner',1,f.hostId);const old=await f.proposed();
 const row={session_id:'owner',generation_id:randomUUID(),boundary_turn:1,boundary_seq:5,session_hash:'1'.repeat(64),ledger_hash:'2'.repeat(64),database_hash:'3'.repeat(64),controller_hash:'4'.repeat(64),host_hash:'5'.repeat(64),backup_hash:'6'.repeat(64)};
 stageAndRecord(f.store,row);f.store.transaction(()=>{f.store.db.prepare("UPDATE search_session_turns SET stopped_at=? WHERE session_id='owner'").run(Number.MAX_SAFE_INTEGER);f.store.db.prepare("UPDATE search_proposal_receipts SET state='started' WHERE proposal_id=?").run(old.id);updateSearchLedgerManifest(f.store);f.store.db.prepare("INSERT INTO search_turn_owners VALUES('owner',2,?,'active',6,NULL,NULL)").run(f.hostId);updateOwnerManifest(f.store.db);});
 const receipt=f.store.db.prepare('SELECT * FROM search_proposal_receipts WHERE proposal_id=?').get(old.id);assert.throws(()=>f.search.abandonProposal({sessionId:receipt.session_id,requestId:receipt.request_id,payloadHash:receipt.payload_hash,proposalId:receipt.proposal_id,proposalHash:receipt.proposal_hash}),e=>e.code==='SEARCH_CUTOVER_UNAVAILABLE');assert.throws(()=>f.search.cancelTurn('owner',1),e=>e.code==='STALE_TURN');assert.equal(f.search.persistenceFault,false);f.search.ensureSessionOpen('other');await f.search.registerUserTurn('owner',2,f.hostId);const fresh=await f.proposed('owner',2);assert.notEqual(fresh.id,old.id);await assert.rejects(f.search.run(fresh.id,{sessionId:'owner'}),e=>e.code==='SEARCH_NOT_RUNNABLE');await f.approve(fresh);assert.equal((await f.search.run(fresh.id,{sessionId:'owner'})).phase,'completed');f.search.cancelTurn('owner',2);assert.equal(f.store.db.prepare("SELECT stopped_at FROM search_cutover_turns WHERE session_id='owner'").get().stopped_at,2);assert.equal(f.store.db.prepare("SELECT stopped_at FROM search_session_turns WHERE session_id='owner'").get().stopped_at,Number.MAX_SAFE_INTEGER);assert.throws(()=>f.search.cancelTurn('owner',1),e=>e.code==='STALE_TURN');assert.equal(f.store.db.prepare('SELECT state FROM search_proposal_receipts WHERE proposal_id=?').get(old.id).state,'started');assert.equal(f.store.db.prepare("SELECT state FROM search_turn_owners WHERE session_id='owner' AND turn=1").get().state,'active');
});
test('unfinished run remains durable and blocks recovery; other sessions stay independent',async t=>{
 const f=setup(t);f.begin();await f.search.registerUserTurn('owner',1,f.hostId);const p=await f.proposed();await f.approve(p);const runId=await f.search.claimRun(f.search.records.get(p.id));
 const evidence=f.search.inspectTurnOwner('owner',1);assert.equal(evidence.pendingClaims,1);
 const {pendingClaims,pendingProcesses,...input}=evidence;assert.throws(()=>f.search.abandonTurnOwner(input),e=>e.code==='TURN_CLAIM_UNCERTAIN');
 const other=new RunStore(f.path);try{const reopened=new SearchService({root:f.root,store:other,requireTurnOwner:true});assert.equal(reopened.inspectTurnOwner('owner',1).pendingClaims,1);}finally{other.close();}
 f.begin('other',1,randomUUID());await f.search.registerUserTurn('other',1,f.store.db.prepare("SELECT host_id FROM search_turn_owners WHERE session_id='other'").get().host_id);
 assert.ok(runId);
});
test('maintenance compares exact owner and snapshot, fences delayed callbacks and records a stop',async t=>{
 const f=setup(t);f.begin();await f.search.registerUserTurn('owner',1,f.hostId);const p=await f.proposed(),e=f.search.inspectTurnOwner('owner',1),{pendingClaims,pendingProcesses,...proof}=e;
 assert.throws(()=>f.search.abandonTurnOwner({...proof,claimsHash:'0'.repeat(64)}),e=>e.code==='TURN_OWNER_CHANGED');
 const receipt=f.search.abandonTurnOwner(proof);assert.equal(receipt.state,'abandoned');assert.equal(f.store.db.prepare("SELECT stopped_at FROM search_session_turns WHERE session_id='owner'").get().stopped_at,1);
 await assert.rejects(async()=>f.approve(p),e=>['SESSION_STOPPED','TURN_OWNER_UNKNOWN'].includes(e.code));
 assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM search_turn_owner_recoveries WHERE session_id='owner'").get().n,1);
});
test('recovery keeps an exited Controller claim uncertain and never permits the old search to resend',{timeout:15000},async t=>{
 const f=setup(t),child=spawn(process.execPath,['-e','process.stdin.resume();process.stdin.on("end",()=>process.exit(0))'],{stdio:['pipe','ignore','ignore'],windowsHide:true});
 await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
 t.after(()=>{if(child.exitCode===null)child.stdin.end();});
 f.begin();await f.search.registerUserTurn('owner',1,f.hostId);const p=await f.proposed();await f.approve(p);await f.search.claimRun(f.search.records.get(p.id));
 f.store.transaction(()=>{f.store.db.prepare('UPDATE search_turn_owner_run_processes SET pid=? WHERE proposal_id=?').run(child.pid,p.id);updateOwnerManifest(f.store.db);});
 const inspect=()=>{const {pendingClaims,pendingProcesses,...proof}=f.search.inspectTurnOwner('owner',1);return proof;};
 assert.throws(()=>f.search.abandonTurnOwner(inspect()),e=>e.code==='TURN_CLAIM_UNCERTAIN');
 child.stdin.end();await new Promise(resolve=>child.once('exit',resolve));
 assert.equal(f.search.abandonTurnOwner(inspect()).uncertainClaims,1);
 assert.equal(f.store.db.prepare('SELECT state FROM search_turn_owner_run_states WHERE proposal_id=?').get(p.id).state,'uncertain');
 assert.equal(f.store.db.prepare('SELECT pid FROM search_turn_owner_uncertain_claims WHERE proposal_id=?').get(p.id).pid,child.pid);
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM search_run_claims WHERE proposal_id=?').get(p.id).n,1);
 await assert.rejects(f.search.run(p.id,{sessionId:'owner'}));assert.deepEqual(f.sent,[]);
});
test('legacy baseline requires persisted attestation and refuses changed evidence or old unresolved claims',t=>{
 const f=setup(t);assert.throws(()=>f.search.inspectLegacyTurn('owner',2),e=>e.code==='LEGACY_EVIDENCE_UNKNOWN');
 f.store.transaction(()=>{f.store.db.prepare('INSERT INTO search_turn_owner_legacy_attestations VALUES(?,?,?,?,?,?,?,?)').run('owner',2,f.hostId,3,6,4,'a'.repeat(64),'b'.repeat(64));updateOwnerManifest(f.store.db);});
 const proof=f.search.inspectLegacyTurn('owner',2);
 const noQuiescence=new SearchService({root:f.root,store:f.store,requireTurnOwner:true,verifyHostIdentity:()=>true});assert.throws(()=>noQuiescence.migrateLegacyTurn(proof),e=>e.code==='LEGACY_EVIDENCE_UNKNOWN');
 assert.throws(()=>f.search.migrateLegacyTurn({...proof,historyHash:'0'.repeat(64)}),e=>e.code==='LEGACY_EVIDENCE_CHANGED');
 f.store.transaction(()=>{f.store.db.prepare('INSERT INTO search_run_claims VALUES(?,?,?,?,?)').run(randomUUID(),'owner','c'.repeat(64),randomUUID(),new Date().toISOString());updateSearchLedgerManifest(f.store);});
 assert.throws(()=>f.search.migrateLegacyTurn(proof),e=>e.code==='LEGACY_EVIDENCE_UNKNOWN');
 f.store.transaction(()=>{f.store.db.prepare('DELETE FROM search_run_claims WHERE session_id=?').run('owner');updateSearchLedgerManifest(f.store);});
 assert.equal(f.search.migrateLegacyTurn(proof).state,'legacy-baseline-approved');
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM search_turn_owners WHERE session_id=?').get('owner').n,0,'migration does not invent a historical Host owner');
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM search_turn_owner_legacy_migrations WHERE session_id=?').get('owner').n,1);
});
test('recovery waits until every separately recorded Controller process is absent',{timeout:15000},async t=>{
 const f=setup(t),children=[];
 for(let i=0;i<2;i++){const c=spawn(process.execPath,['-e','process.stdin.resume();process.stdin.on("end",()=>process.exit(0))'],{stdio:['pipe','ignore','ignore'],windowsHide:true});await new Promise((resolve,reject)=>{c.once('spawn',resolve);c.once('error',reject);});children.push(c);}
 t.after(()=>{for(const c of children)if(c.exitCode===null)c.stdin.end();});
 f.begin();await f.search.registerUserTurn('owner',1,f.hostId);
 for(const child of children){const p=await f.proposed();await f.approve(p);await f.search.claimRun(f.search.records.get(p.id));f.store.transaction(()=>{f.store.db.prepare('UPDATE search_turn_owner_run_processes SET pid=? WHERE proposal_id=?').run(child.pid,p.id);updateOwnerManifest(f.store.db);});}
 const inspect=()=>{const {pendingClaims,pendingProcesses,...proof}=f.search.inspectTurnOwner('owner',1);assert.equal(pendingClaims,2);return proof;};
 assert.throws(()=>f.search.abandonTurnOwner(inspect()),e=>e.code==='TURN_CLAIM_UNCERTAIN');children[0].stdin.end();await new Promise(resolve=>children[0].once('exit',resolve));
 assert.throws(()=>f.search.abandonTurnOwner(inspect()),e=>e.code==='TURN_CLAIM_UNCERTAIN');children[1].stdin.end();await new Promise(resolve=>children[1].once('exit',resolve));
 assert.equal(f.search.abandonTurnOwner(inspect()).uncertainClaims,2);assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM search_turn_owner_run_states WHERE state='uncertain'").get().n,2);
});
test('a real separate Controller claims with its own pid and cannot be recovered while alive',{timeout:15000},async t=>{
 const f=setup(t);f.begin();await f.search.registerUserTurn('owner',1,f.hostId);const p=await f.proposed();await f.approve(p);
 const script=`import {RunStore} from ${JSON.stringify(pathToFileURL(resolve('apps/controller/store.mjs')).href)};import {SearchService} from ${JSON.stringify(pathToFileURL(resolve('apps/controller/search/service.mjs')).href)};const x=JSON.parse(process.env.SEARCH_PID_FIXTURE),store=new RunStore(x.path),search=new SearchService({root:x.root,store,requireTurnOwner:true,ownerProbe:{processes:async pids=>pids.map(pid=>({pid,startTimeUtcTicks:'638000000000000000',executable:'C:\\\\Apps\\\\DSH\\\\dsh.exe'}))}});const record=search.records.get(x.id),runId=await search.claimRun(record);process.send({pid:process.pid,instance:search.controllerInstanceId,runId});process.stdin.resume();process.stdin.on('end',()=>{store.close();process.disconnect();});`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{env:{...process.env,SEARCH_PID_FIXTURE:JSON.stringify({root:f.root,path:f.path,id:p.id})},stdio:['pipe','ignore','pipe','ipc'],windowsHide:true});let errors='';child.stderr.on('data',x=>errors+=x);
 t.after(()=>{if(child.exitCode===null)child.stdin.end();});
 const message=await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',code=>reject(Error(`Controller exited early ${code}: ${errors}`)));});
 const inspect=()=>{const {pendingClaims,pendingProcesses,...proof}=f.search.inspectTurnOwner('owner',1);assert.equal(pendingClaims,1);assert.equal(pendingProcesses[0].pid,message.pid);assert.equal(pendingProcesses[0].controllerInstance,message.instance);return proof;};
 assert.throws(()=>f.search.abandonTurnOwner(inspect()),e=>e.code==='TURN_CLAIM_UNCERTAIN');
 child.stdin.end();await new Promise(resolve=>child.once('exit',resolve));
 f.store.db.exec("CREATE TRIGGER fail_uncertain_recovery BEFORE INSERT ON search_turn_owner_uncertain_claims BEGIN SELECT RAISE(ABORT,'injected'); END");
 assert.throws(()=>f.search.abandonTurnOwner(inspect()),/injected/);assert.equal(f.store.db.prepare('SELECT state FROM search_turn_owner_run_states WHERE proposal_id=?').get(p.id).state,'started');assert.equal(f.store.db.prepare("SELECT state FROM search_turn_owners WHERE session_id='owner'").get().state,'active');
 f.store.db.exec('DROP TRIGGER fail_uncertain_recovery');assert.equal(f.search.abandonTurnOwner(inspect()).uncertainClaims,1);
 assert.equal(f.store.db.prepare('SELECT run_id FROM search_turn_owner_uncertain_claims WHERE proposal_id=?').get(p.id).run_id,message.runId);
});
