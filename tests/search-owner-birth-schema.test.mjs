import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,lstatSync,readdirSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {RunStore} from '../apps/controller/store.mjs';
import {SearchService} from '../apps/controller/search/service.mjs';
import {updateOwnerManifest} from '../apps/controller/search/owner-manifest.mjs';

function fixture(t,verifyHostIdentity=()=>true){
  const base=resolve(tmpdir()),root=mkdtempSync(join(base,'search-owner-birth-')),store=new RunStore(':memory:'),ownerProbe={processes:async pids=>pids.flatMap(pid=>{const row={pid,start_time_utc_ticks:'638000000000000000',executable:'C:\\Apps\\DSH\\dsh.exe'};return verifyHostIdentity(row)?[{pid,startTimeUtcTicks:row.start_time_utc_ticks,executable:row.executable}]:[];})},make=()=>new SearchService({root,store,requireTurnOwner:true,ownerProbe}),search=make();
  t.after(()=>{store.close();assert.ok(resolve(root).startsWith(base+sep));const visit=p=>{const s=lstatSync(p);assert.equal(s.isSymbolicLink(),false);if(s.isDirectory())for(const n of readdirSync(p))visit(join(p,n));};visit(root);rmSync(root,{recursive:true});});
  return {root,store,search,make};
}
function owner(f,{session='owner',turn=1,hostId=randomUUID(),ticks='638000000000000000',executable='C:\\Apps\\DSH\\dsh.exe'}={}){
  f.store.transaction(()=>{f.store.db.prepare('INSERT INTO search_session_host_generations(session_id,host_id,pid,state,start_time_utc_ticks,executable) VALUES(?,?,?,?,?,?)').run(session,hostId,1234,'active',ticks,executable);f.store.db.prepare("INSERT INTO search_turn_owners VALUES(?,?,?,'active',1,NULL,NULL)").run(session,turn,hostId);updateOwnerManifest(f.store.db);});return {session,turn,hostId};
}

test('strict owner is bound to the host birth values and an unavailable verifier fails closed',async t=>{
  let checked;const f=fixture(t,row=>{checked=row;return row.pid===1234&&row.start_time_utc_ticks==='638000000000000000'&&row.executable==='C:\\Apps\\DSH\\dsh.exe';}),o=owner(f);
  await f.search.registerUserTurn(o.session,o.turn,o.hostId);assert.equal(checked.start_time_utc_ticks,'638000000000000000');
  f.search.ownerProbe={processes:async()=>[]};await assert.rejects(f.search.registerUserTurn(o.session,o.turn,o.hostId),e=>e.status===503);
});

test('old Host rows are migrated without inventing birth identity or enabling a turn',async t=>{
  const f=fixture(t),hostId=randomUUID();f.store.db.exec("DROP TABLE search_session_host_generations; CREATE TABLE search_session_host_generations(session_id TEXT NOT NULL,host_id TEXT NOT NULL,pid INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('active','superseded')),PRIMARY KEY(session_id,host_id)); CREATE UNIQUE INDEX search_session_active_host ON search_session_host_generations(session_id) WHERE state='active'; DELETE FROM meta WHERE key IN ('searchSessionHostBirth:v1','searchTurnOwnershipIntegrity:v1','searchTurnOwnershipManifest:v1')");
  f.store.db.prepare("INSERT INTO search_session_host_generations VALUES(?,?,?,'active')").run('owner',hostId,1234);f.store.db.prepare("INSERT INTO search_turn_owners VALUES(?,?,?,'active',1,NULL,NULL)").run('owner',1,hostId);
  const restored=f.make(),row=f.store.db.prepare('SELECT * FROM search_session_host_generations').get();assert.equal(row.start_time_utc_ticks,'');assert.equal(row.executable,'');assert.equal(row.state,'active');
  await assert.rejects(restored.registerUserTurn('owner',1,hostId),e=>e.status===503);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM search_session_turns').get().n,0);
});

test('birth migration rolls back its columns and marker on a database failure',t=>{
  const f=fixture(t);f.store.db.exec("DROP TABLE search_session_host_generations; CREATE TABLE search_session_host_generations(session_id TEXT NOT NULL,host_id TEXT NOT NULL,pid INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('active','superseded')),PRIMARY KEY(session_id,host_id)); CREATE UNIQUE INDEX search_session_active_host ON search_session_host_generations(session_id) WHERE state='active'; DELETE FROM meta WHERE key IN ('searchSessionHostBirth:v1','searchTurnOwnershipIntegrity:v1','searchTurnOwnershipManifest:v1'); CREATE TRIGGER fail_birth_marker BEFORE INSERT ON meta WHEN NEW.key='searchSessionHostBirth:v1' BEGIN SELECT RAISE(ABORT,'injected birth marker failure'); END");
  assert.throws(f.make,/injected birth marker failure/);assert.equal(f.store.db.prepare('PRAGMA table_info(search_session_host_generations)').all().length,4);assert.equal(f.store.db.prepare("SELECT value FROM meta WHERE key='searchSessionHostBirth:v1'").get(),undefined);
  f.store.db.exec('DROP TRIGGER fail_birth_marker');assert.doesNotThrow(f.make);
});

test('owner changes without updating the independent manifest are held',async t=>{
  const f=fixture(t),o=owner(f);await f.search.registerUserTurn(o.session,o.turn,o.hostId);
  f.store.db.prepare('UPDATE search_session_host_generations SET start_time_utc_ticks=? WHERE session_id=?').run('638000000000000001',o.session);
  await assert.rejects(f.search.registerUserTurn(o.session,o.turn,o.hostId),e=>e.status===503);assert.throws(f.make,/owner manifest differs/);
});

test('claim and all owner writes roll back if the owner manifest cannot be committed',async t=>{
  const f=fixture(t),o=owner(f);await f.search.registerUserTurn(o.session,o.turn,o.hostId);
  const p=await f.search.propose({sessionId:o.session,turn:o.turn,queries:['fixture'],purpose:'fixture'});await f.search.approve(p.id,{queries:p.queries,engine:p.engine,actor:'user',proposalHash:p.proposalHash});
  f.store.db.exec("CREATE TRIGGER fail_owner_manifest BEFORE UPDATE ON meta WHEN NEW.key='searchTurnOwnershipManifest:v1' BEGIN SELECT RAISE(ABORT,'injected owner manifest'); END");
  await assert.rejects(f.search.run(p.id,{sessionId:o.session}),e=>e.status===503);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM search_run_claims').get().n,0);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM search_turn_owner_run_states').get().n,0);
});

for(const table of ['search_turn_owners','search_turn_owner_run_states','search_turn_owner_recoveries','search_turn_owner_run_processes','search_turn_owner_uncertain_claims','search_turn_owner_legacy_attestations','search_turn_owner_legacy_migrations','search_session_host_generations'])test(`${table} rejects a nonbinary primary key`,t=>{
  const f=fixture(t),sql=f.store.db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(table).sql,column=table.includes('run_states')||table.includes('run_processes')||table.includes('uncertain_claims')?'proposal_id':'session_id',changed=sql.replace(`${column} TEXT`,`${column} TEXT COLLATE NOCASE`);assert.notEqual(sql,changed);
  f.store.db.exec(`DROP TABLE ${table}`);f.store.db.exec(changed);if(table==='search_session_host_generations')f.store.db.exec("CREATE UNIQUE INDEX search_session_active_host ON search_session_host_generations(session_id) WHERE state='active'");
  assert.throws(f.make,/schema differs/);
});
