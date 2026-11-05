import test from 'node:test';
import assert from 'node:assert/strict';
import {durableCompletedTurn,durableLegacyTurnAttestation,pinTurnOwnerDatabase} from '../apps/dsh-plugins/local-genai/turn-owner.mjs';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RunStore} from '../apps/controller/store.mjs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {initializeOwnerManifest,updateOwnerManifest} from '../apps/controller/search/owner-manifest.mjs';
import {initializeCutoverLedger,beginCutover,withCutoverCommitScope,recordCutover} from '../apps/controller/search/cutover-ledger.mjs';
function seedOwnerInfra(store){store.db.exec("CREATE TABLE search_turn_owner_run_states(proposal_id TEXT PRIMARY KEY,session_id TEXT,turn INTEGER,host_id TEXT,run_id TEXT,state TEXT); CREATE TABLE search_run_claims(proposal_id TEXT PRIMARY KEY,session_id TEXT,proposal_hash TEXT,run_id TEXT,claimed_at TEXT); CREATE TABLE search_proposal_turn_bindings(proposal_id TEXT PRIMARY KEY,session_id TEXT,proposal_hash TEXT,turn INTEGER,turn_hash TEXT); CREATE TABLE search_turn_owner_recoveries(session_id TEXT,turn INTEGER,host_id TEXT,start_seq INTEGER,observed_latest INTEGER,observed_stopped_at INTEGER,claims_hash TEXT,recorded_at TEXT,PRIMARY KEY(session_id,turn)); CREATE TABLE search_turn_owner_run_processes(proposal_id TEXT PRIMARY KEY,run_id TEXT,controller_instance TEXT,pid INTEGER); CREATE TABLE search_turn_owner_uncertain_claims(proposal_id TEXT PRIMARY KEY,session_id TEXT,turn INTEGER,host_id TEXT,run_id TEXT,controller_instance TEXT,pid INTEGER,recorded_at TEXT); CREATE TABLE search_turn_owner_legacy_attestations(session_id TEXT,turn INTEGER,host_id TEXT,start_seq INTEGER,end_seq INTEGER,event_count INTEGER,events_hash TEXT,end_event_hash TEXT,PRIMARY KEY(session_id,turn)); CREATE TABLE search_turn_owner_legacy_migrations(session_id TEXT,turn INTEGER,host_id TEXT,attestation_hash TEXT,observed_latest INTEGER,observed_stopped_at INTEGER,history_hash TEXT,recorded_at TEXT,PRIMARY KEY(session_id,turn)); CREATE TABLE search_session_host_generations(session_id TEXT NOT NULL,host_id TEXT NOT NULL,pid INTEGER NOT NULL,state TEXT NOT NULL,start_time_utc_ticks TEXT NOT NULL DEFAULT '',executable TEXT NOT NULL DEFAULT '',PRIMARY KEY(session_id,host_id)); CREATE UNIQUE INDEX search_session_active_host ON search_session_host_generations(session_id) WHERE state='active'; CREATE TABLE search_session_turns(session_id TEXT PRIMARY KEY,latest INTEGER,stopped_at INTEGER); INSERT INTO meta(key,value) VALUES('searchTurnOwners:v1','done'),('searchSessionHosts:v1','done');");const insert=store.db.prepare("INSERT INTO search_session_host_generations VALUES(?,?,?,'active',?,?)");for(const sessionId of ['owned','desktop:owned'])insert.run(sessionId,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',process.pid,'638000000000000000',process.execPath);initializeOwnerManifest(store.db);initializeCutoverLedger(store.db);}
function seedLegacy(store){store.db.exec("CREATE TABLE search_proposal_receipts(session_id TEXT,state TEXT); INSERT INTO meta(key,value) VALUES('searchTurnLegacy:v1','done');");}
function refresh(store){updateOwnerManifest(store.db);}
function fixture(){
 const events=[{seq:1,type:'turn/start',data:{turn:1}},{seq:5,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}],stored=structuredClone(events),session={id:'owned',snapshotEvents:()=>events};
 const sessions={flush:async()=>true},persistence={flush:async()=>{},open:async(id,access)=>({id,access,read:async seq=>({events:stored.filter(x=>x.seq===seq)}),close:async()=>{}})};
 return {events,stored,session,sessions,persistence,turn:1};
}
test('turn completion requires exactly one durable start and completed end',async()=>{const f=fixture(),result=await durableCompletedTurn(f);assert.equal(result.turn,1);assert.equal(result.startSeq,1);assert.equal(result.endSeq,5);assert.match(result.endEventHash,/^[a-f0-9]{64}$/);});
test('stopping alone, abort, duplicate boundary, missing flush and changed storage remain unresolved',async()=>{
 for(const mutate of [f=>f.events.pop(),f=>{f.events[1].data.reason.kind='aborted';},f=>f.events.push({...f.events[1],seq:6}),f=>{f.sessions.flush=async()=>false;},f=>{f.stored[1].data.reason.kind='error';},f=>{f.persistence.open=async()=>({id:'other',access:'read',close:async()=>{}});}]){const f=fixture();mutate(f);await assert.rejects(durableCompletedTurn(f));}
});
test('legacy attestation requires every stored event and returns hashes without contents',async()=>{
 const f=fixture();f.events[1].seq=3;f.stored[1].seq=3;f.events.splice(1,0,{seq:2,type:'message',data:{text:'private fixture'}});f.stored.splice(1,0,structuredClone(f.events[1]));const attestation=await durableLegacyTurnAttestation(f);assert.equal(attestation.eventCount,3);assert.match(attestation.eventsHash,/^[a-f0-9]{64}$/);assert.ok(!JSON.stringify(attestation).includes('private fixture'));
 f.stored[1].data.text='changed';await assert.rejects(durableLegacyTurnAttestation(f),/range differs/);f.stored[1].data.text='private fixture';f.events.splice(1,1);await assert.rejects(durableLegacyTurnAttestation(f),/range is incomplete/);
});
test('owner remains active across reopen until the same Host proves a durable completed turn',async()=>{
 const root=await mkdtemp(join(tmpdir(),'turn-owner-'));await mkdir(join(root,'data/controller'),{recursive:true});const store=new RunStore(join(root,'data/controller/controller.db'));
 store.db.exec("CREATE TABLE search_turn_owners(session_id TEXT NOT NULL,turn INTEGER NOT NULL,host_id TEXT NOT NULL,state TEXT NOT NULL,start_seq INTEGER NOT NULL,end_seq INTEGER,end_event_hash TEXT,PRIMARY KEY(session_id,turn));");
 seedOwnerInfra(store);
 const hostId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',f=fixture(),args={...f,mapSessionId:id=>'desktop:'+id,hostId};
 try{let owner=pinTurnOwnerDatabase(root);assert.equal((await owner.begin(args)).state,'active');owner=pinTurnOwnerDatabase(root);
  await assert.rejects(owner.begin({...args,turn:2}),/start|unresolved/);await assert.rejects(owner.complete({...args,hostId:other}),/no longer active/);
  assert.equal((await owner.complete(args)).state,'completed');const row=store.db.prepare('SELECT * FROM search_turn_owners').get();assert.equal(row.session_id,'desktop:owned');assert.equal(row.state,'completed');assert.equal(row.end_seq,5);
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});
test('legacy histories and aborted turns are not silently marked complete',async()=>{
 const root=await mkdtemp(join(tmpdir(),'turn-owner-legacy-'));await mkdir(join(root,'data/controller'),{recursive:true});const store=new RunStore(join(root,'data/controller/controller.db'));
 store.db.exec("CREATE TABLE search_turn_owners(session_id TEXT NOT NULL,turn INTEGER NOT NULL,host_id TEXT NOT NULL,state TEXT NOT NULL,start_seq INTEGER NOT NULL,end_seq INTEGER,end_event_hash TEXT,PRIMARY KEY(session_id,turn));");
 seedOwnerInfra(store);
 seedLegacy(store);
 const f=fixture(),owner=pinTurnOwnerDatabase(root),args={...f,mapSessionId:id=>id,hostId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'};
 try{f.events[0].data.turn=2;f.stored[0].data.turn=2;await assert.rejects(owner.begin({...args,turn:2}),/Prior search turn ownership/);f.events[0].data.turn=1;f.stored[0].data.turn=1;await owner.begin(args);f.events[1].data.reason.kind='aborted';f.stored[1].data.reason.kind='aborted';await assert.rejects(owner.complete(args),/no unique normal end/);assert.equal(store.db.prepare('SELECT state FROM search_turn_owners').get().state,'active');}
 finally{store.close();await rm(root,{recursive:true,force:true});}
});
test('verified fixture cutover preserves an old active owner and starts only a later turn',async()=>{
 const root=await mkdtemp(join(tmpdir(),'turn-owner-cutover-'));await mkdir(join(root,'data/controller'),{recursive:true});const store=new RunStore(join(root,'data/controller/controller.db'));store.db.exec("CREATE TABLE search_turn_owners(session_id TEXT NOT NULL,turn INTEGER NOT NULL,host_id TEXT NOT NULL,state TEXT NOT NULL,start_seq INTEGER NOT NULL,end_seq INTEGER,end_event_hash TEXT,PRIMARY KEY(session_id,turn));");seedOwnerInfra(store);const hostId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',f=fixture(),owner=pinTurnOwnerDatabase(root),args={...f,mapSessionId:id=>id,hostId};
 try{store.transaction(()=>{store.db.prepare("INSERT INTO search_turn_owners VALUES('owned',1,?,'active',1,NULL,NULL)").run(hostId);store.db.prepare("INSERT INTO meta(key,value) VALUES('searchReceiptGenerations:v1','done')").run();updateOwnerManifest(store.db);});const row={session_id:'owned',generation_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',boundary_turn:1,boundary_seq:5,session_hash:'1'.repeat(64),ledger_hash:'2'.repeat(64),database_hash:'3'.repeat(64),controller_hash:'4'.repeat(64),host_hash:'5'.repeat(64),backup_hash:'6'.repeat(64)};beginCutover(store,row,()=>true);store.transaction(()=>withCutoverCommitScope(store.db,()=>recordCutover(store.db,row,()=>true)));f.events.push({seq:6,type:'turn/start',data:{turn:2}});f.stored.push(structuredClone(f.events.at(-1)));assert.equal((await owner.begin({...args,turn:2})).state,'active');assert.equal(store.db.prepare("SELECT state FROM search_turn_owners WHERE session_id='owned' AND turn=1").get().state,'active');await assert.rejects(owner.complete({...args,turn:1}),/cutover boundary/);}finally{store.close();await rm(root,{recursive:true,force:true});}
});
test('legacy baseline requires explicit Controller migration for the exact attested turn',async()=>{
 const root=await mkdtemp(join(tmpdir(),'turn-owner-legacy-approved-'));await mkdir(join(root,'data/controller'),{recursive:true});const store=new RunStore(join(root,'data/controller/controller.db'));store.db.exec("CREATE TABLE search_turn_owners(session_id TEXT NOT NULL,turn INTEGER NOT NULL,host_id TEXT NOT NULL,state TEXT NOT NULL,start_seq INTEGER NOT NULL,end_seq INTEGER,end_event_hash TEXT,PRIMARY KEY(session_id,turn));");seedOwnerInfra(store);seedLegacy(store);
 const f=fixture();f.events[1].seq=3;f.stored[1].seq=3;f.events.splice(1,0,{seq:2,type:'message',data:{text:'private fixture'}});f.stored.splice(1,0,structuredClone(f.events[1]));const hostId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',owner=pinTurnOwnerDatabase(root),args={...f,mapSessionId:id=>id,hostId};
 try{assert.equal(owner.needsLegacyAttestation({sessionId:'owned',hostId,turn:2}),true);const evidence=await owner.attestLegacy(args);assert.equal(evidence.turn,1);f.events.push({seq:4,type:'turn/start',data:{turn:2}});f.stored.push(structuredClone(f.events.at(-1)));await assert.rejects(owner.begin({...args,turn:2}),/no approved legacy baseline/);
  const row=store.db.prepare('SELECT * FROM search_turn_owner_legacy_attestations').get(),attestationHash=createHash('sha256').update(JSON.stringify(row)).digest('hex');store.db.prepare("INSERT INTO search_turn_owner_legacy_migrations VALUES('owned',1,?,?,NULL,NULL,?,'2026-01-01T00:00:00.000Z')").run(hostId,attestationHash,'a'.repeat(64));refresh(store);assert.equal(owner.needsLegacyAttestation({sessionId:'owned',hostId,turn:2}),false);assert.equal((await owner.begin({...args,turn:2})).state,'active');
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});
test('turn owner refuses a modified schema before recording ownership',async()=>{
 const root=await mkdtemp(join(tmpdir(),'turn-owner-schema-'));await mkdir(join(root,'data/controller'),{recursive:true});const store=new RunStore(join(root,'data/controller/controller.db'));
 store.db.exec("CREATE TABLE search_turn_owners(session_id TEXT NOT NULL,turn INTEGER NOT NULL,host_id TEXT NOT NULL,state TEXT NOT NULL,start_seq INTEGER NOT NULL,end_seq INTEGER,end_event_hash TEXT,PRIMARY KEY(session_id,turn)); CREATE TRIGGER turn_owner_untrusted AFTER INSERT ON search_turn_owners BEGIN SELECT 1; END;");
 seedOwnerInfra(store);
 const f=fixture(),owner=pinTurnOwnerDatabase(root),args={...f,mapSessionId:id=>id,hostId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'};
 try{await assert.rejects(owner.begin(args),/schema differs/);assert.equal(store.db.prepare('SELECT count(*) AS n FROM search_turn_owners').get().n,0);}finally{store.close();await rm(root,{recursive:true,force:true});}
});
test('owner manifest rejects an out-of-band row change without repairing it',async()=>{
 const root=await mkdtemp(join(tmpdir(),'turn-owner-manifest-'));await mkdir(join(root,'data/controller'),{recursive:true});const store=new RunStore(join(root,'data/controller/controller.db'));store.db.exec("CREATE TABLE search_turn_owners(session_id TEXT NOT NULL,turn INTEGER NOT NULL,host_id TEXT NOT NULL,state TEXT NOT NULL,start_seq INTEGER NOT NULL,end_seq INTEGER,end_event_hash TEXT,PRIMARY KEY(session_id,turn));");seedOwnerInfra(store);
 const f=fixture(),owner=pinTurnOwnerDatabase(root),args={...f,mapSessionId:id=>id,hostId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'};
 try{await owner.begin(args);store.db.prepare("UPDATE search_turn_owners SET start_seq=99 WHERE session_id='owned'").run();await assert.rejects(owner.complete(args),/manifest.*differs/i);assert.equal(store.db.prepare('SELECT start_seq FROM search_turn_owners').get().start_seq,99);}finally{store.close();await rm(root,{recursive:true,force:true});}
});
test('Host activation refuses an alive prior generation and never revives a superseded Host',async()=>{
 const root=await mkdtemp(join(tmpdir(),'turn-owner-host-'));await mkdir(join(root,'data/controller'),{recursive:true});const store=new RunStore(join(root,'data/controller/controller.db'));store.db.exec("CREATE TABLE search_turn_owners(session_id TEXT NOT NULL,turn INTEGER NOT NULL,host_id TEXT NOT NULL,state TEXT NOT NULL,start_seq INTEGER NOT NULL,end_seq INTEGER,end_event_hash TEXT,PRIMARY KEY(session_id,turn));");seedOwnerInfra(store);store.db.exec('DELETE FROM search_session_host_generations');refresh(store);
 const owner=pinTurnOwnerDatabase(root),hostId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',identity={pid:process.pid,start_time_utc_ticks:'638000000000000000',executable:process.execPath};
 try{assert.equal(owner.activate({sessionId:'owned',hostId,identity}).state,'active');assert.equal(owner.activate({sessionId:'owned',hostId,identity}).state,'active');assert.throws(()=>owner.activate({sessionId:'owned',hostId:other,identity}),/prior Host may still be alive/);
  store.db.prepare("UPDATE search_session_host_generations SET state='superseded' WHERE host_id=?").run(hostId);refresh(store);assert.throws(()=>owner.activate({sessionId:'owned',hostId,identity}),/cannot be reused/);
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});
test('Host activation supersedes only a previous PID confirmed absent',async()=>{
 const root=await mkdtemp(join(tmpdir(),'turn-owner-host-dead-'));await mkdir(join(root,'data/controller'),{recursive:true});const store=new RunStore(join(root,'data/controller/controller.db'));store.db.exec("CREATE TABLE search_turn_owners(session_id TEXT NOT NULL,turn INTEGER NOT NULL,host_id TEXT NOT NULL,state TEXT NOT NULL,start_seq INTEGER NOT NULL,end_seq INTEGER,end_event_hash TEXT,PRIMARY KEY(session_id,turn));");seedOwnerInfra(store);store.db.exec('DELETE FROM search_session_host_generations');refresh(store);
 const dead=spawnSync(process.execPath,['-e',''],{windowsHide:true});assert.equal(dead.status,0);assert.ok(dead.pid>0);const owner=pinTurnOwnerDatabase(root),old='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',hostId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',identity={pid:process.pid,start_time_utc_ticks:'638000000000000000',executable:process.execPath};
 try{store.db.prepare("INSERT INTO search_session_host_generations VALUES(?,?,?,'active',?,?)").run('owned',old,dead.pid,identity.start_time_utc_ticks,identity.executable);refresh(store);assert.equal(owner.activate({sessionId:'owned',hostId,identity}).state,'active');assert.equal(store.db.prepare('SELECT state FROM search_session_host_generations WHERE host_id=?').get(old).state,'superseded');}
 finally{store.close();await rm(root,{recursive:true,force:true});}
});
test('malformed prior completion cannot authorize a later turn',async()=>{
 const root=await mkdtemp(join(tmpdir(),'turn-owner-corrupt-'));await mkdir(join(root,'data/controller'),{recursive:true});const store=new RunStore(join(root,'data/controller/controller.db'));
 store.db.exec("CREATE TABLE search_turn_owners(session_id TEXT NOT NULL,turn INTEGER NOT NULL,host_id TEXT NOT NULL,state TEXT NOT NULL,start_seq INTEGER NOT NULL,end_seq INTEGER,end_event_hash TEXT,PRIMARY KEY(session_id,turn)); INSERT INTO search_turn_owners VALUES('owned',1,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','completed',1,NULL,NULL);");
 seedOwnerInfra(store);
 const f=fixture();f.events[0].data.turn=2;f.stored[0].data.turn=2;const owner=pinTurnOwnerDatabase(root),args={...f,turn:2,mapSessionId:id=>id,hostId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'};
 try{await assert.rejects(owner.begin(args),/unresolved or malformed/);assert.equal(store.db.prepare('SELECT count(*) AS n FROM search_turn_owners').get().n,1);}finally{store.close();await rm(root,{recursive:true,force:true});}
});
test('missing Controller migration marker prevents ownership creation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'turn-owner-unmigrated-'));await mkdir(join(root,'data/controller'),{recursive:true});const store=new RunStore(join(root,'data/controller/controller.db'));
 store.db.exec("CREATE TABLE search_turn_owners(session_id TEXT NOT NULL,turn INTEGER NOT NULL,host_id TEXT NOT NULL,state TEXT NOT NULL,start_seq INTEGER NOT NULL,end_seq INTEGER,end_event_hash TEXT,PRIMARY KEY(session_id,turn));");
 seedOwnerInfra(store);store.db.prepare("DELETE FROM meta WHERE key='searchTurnOwners:v1'").run();
 const f=fixture(),owner=pinTurnOwnerDatabase(root),args={...f,mapSessionId:id=>id,hostId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'};
 try{await assert.rejects(owner.begin(args),/migration is not complete/);assert.equal(store.db.prepare('SELECT count(*) AS n FROM search_turn_owners').get().n,0);}finally{store.close();await rm(root,{recursive:true,force:true});}
});
test('in-flight or unbound search claim prevents turn completion',async()=>{
 const root=await mkdtemp(join(tmpdir(),'turn-owner-claim-'));await mkdir(join(root,'data/controller'),{recursive:true});const store=new RunStore(join(root,'data/controller/controller.db'));
 store.db.exec("CREATE TABLE search_turn_owners(session_id TEXT NOT NULL,turn INTEGER NOT NULL,host_id TEXT NOT NULL,state TEXT NOT NULL,start_seq INTEGER NOT NULL,end_seq INTEGER,end_event_hash TEXT,PRIMARY KEY(session_id,turn));");seedOwnerInfra(store);
 const f=fixture(),hostId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',owner=pinTurnOwnerDatabase(root),args={...f,mapSessionId:id=>id,hostId},hash='1'.repeat(64);
 try{await owner.begin(args);store.db.prepare('INSERT INTO search_run_claims VALUES(?,?,?,?,?)').run('p','owned',hash,'run','2026-01-01T00:00:00.000Z');await assert.rejects(owner.complete(args),/no valid turn binding/);
  store.db.prepare('INSERT INTO search_proposal_turn_bindings VALUES(?,?,?,?,?)').run('p','owned',hash,1,hash);store.db.prepare('INSERT INTO search_turn_owner_run_states VALUES(?,?,?,?,?,?)').run('p','owned',1,hostId,'run','started');store.db.prepare("INSERT INTO meta(key,value) VALUES('searchTurnRunProcesses:v1','done')").run();store.db.prepare('INSERT INTO search_turn_owner_run_processes VALUES(?,?,?,?)').run('p','run','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',process.pid);refresh(store);await assert.rejects(owner.complete(args),/remains unresolved/);assert.equal(store.db.prepare('SELECT state FROM search_turn_owners').get().state,'active');
  store.db.prepare("UPDATE search_turn_owner_run_states SET state='completed'").run();refresh(store);assert.equal((await owner.complete(args)).state,'completed');
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});
test('an abandoned turn requires exact recovery, stop and claim evidence',async()=>{
 const root=await mkdtemp(join(tmpdir(),'turn-owner-abandoned-'));await mkdir(join(root,'data/controller'),{recursive:true});const store=new RunStore(join(root,'data/controller/controller.db'));
 store.db.exec("CREATE TABLE search_turn_owners(session_id TEXT NOT NULL,turn INTEGER NOT NULL,host_id TEXT NOT NULL,state TEXT NOT NULL,start_seq INTEGER NOT NULL,end_seq INTEGER,end_event_hash TEXT,PRIMARY KEY(session_id,turn));");seedOwnerInfra(store);
 const f=fixture(),hostId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',owner=pinTurnOwnerDatabase(root),args={...f,mapSessionId:id=>id,hostId},claimsHash=createHash('sha256').update('[]').digest('hex');
 try{store.db.prepare("INSERT INTO search_turn_owners VALUES('owned',1,?,'abandoned',1,NULL,NULL)").run(hostId);refresh(store);f.events[0].data.turn=2;f.stored[0].data.turn=2;await assert.rejects(owner.begin({...args,turn:2}),/recovery evidence/);
  store.db.prepare("INSERT INTO search_session_turns VALUES('owned',1,1)").run();store.db.prepare("INSERT INTO search_turn_owner_recoveries VALUES('owned',1,?,1,NULL,NULL,?,'2026-01-01T00:00:00.000Z')").run(hostId,claimsHash);refresh(store);assert.equal((await owner.begin({...args,turn:2})).state,'active');
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});
test('uncertain claim requires the original process and recovery audit without claiming it was unsent',async()=>{
 const root=await mkdtemp(join(tmpdir(),'turn-owner-uncertain-'));await mkdir(join(root,'data/controller'),{recursive:true});const store=new RunStore(join(root,'data/controller/controller.db'));
 store.db.exec("CREATE TABLE search_turn_owners(session_id TEXT NOT NULL,turn INTEGER NOT NULL,host_id TEXT NOT NULL,state TEXT NOT NULL,start_seq INTEGER NOT NULL,end_seq INTEGER,end_event_hash TEXT,PRIMARY KEY(session_id,turn));");seedOwnerInfra(store);store.db.exec("INSERT INTO meta(key,value) VALUES('searchTurnRunProcesses:v1','done');");
 const f=fixture(),hostId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',instance='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',owner=pinTurnOwnerDatabase(root),args={...f,mapSessionId:id=>id,hostId},hash='1'.repeat(64),recorded='2026-01-01T00:00:00.000Z';
 try{store.db.prepare("INSERT INTO search_turn_owners VALUES('owned',1,?,'abandoned',1,NULL,NULL)").run(hostId);store.db.prepare("INSERT INTO search_session_turns VALUES('owned',1,1)").run();store.db.prepare('INSERT INTO search_run_claims VALUES(?,?,?,?,?)').run('p','owned',hash,'run',recorded);store.db.prepare('INSERT INTO search_proposal_turn_bindings VALUES(?,?,?,?,?)').run('p','owned',hash,1,hash);store.db.prepare('INSERT INTO search_turn_owner_run_states VALUES(?,?,?,?,?,?)').run('p','owned',1,hostId,'run','started');const before=store.db.prepare('SELECT * FROM search_turn_owner_run_states').all(),claimsHash=createHash('sha256').update(JSON.stringify(before)).digest('hex');store.db.prepare("UPDATE search_turn_owner_run_states SET state='uncertain'").run();store.db.prepare('INSERT INTO search_turn_owner_run_processes VALUES(?,?,?,?)').run('p','run',instance,1234);store.db.prepare("INSERT INTO search_turn_owner_recoveries VALUES('owned',1,?,1,NULL,NULL,?,?)").run(hostId,claimsHash,recorded);refresh(store);f.events[0].data.turn=2;f.stored[0].data.turn=2;await assert.rejects(owner.begin({...args,turn:2}),/Uncertain search claim evidence differs/);
  store.db.prepare('INSERT INTO search_turn_owner_uncertain_claims VALUES(?,?,?,?,?,?,?,?)').run('p','owned',1,hostId,'run',instance,1234,recorded);refresh(store);assert.equal((await owner.begin({...args,turn:2})).state,'active');assert.equal(store.db.prepare('SELECT state FROM search_turn_owner_run_states').get().state,'uncertain');
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});
