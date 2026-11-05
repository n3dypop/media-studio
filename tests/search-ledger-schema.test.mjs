import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {RunStore} from '../apps/controller/store.mjs';
import {initializeSearchLedger,updateSearchLedgerManifest,validateSearchSessionTurns} from '../apps/controller/search/ledger-schema.mjs';
import {beginCutover} from '../apps/controller/search/cutover-ledger.mjs';
import {commitPreparedCutover} from '../apps/controller/search/cutover-transaction.mjs';
import {fixtureRow,migrateFixture} from './support/cutover-fixture.mjs';

function fixture(t){const store=new RunStore(':memory:');t.after(()=>store.close());migrateFixture(store);return store;}
for(const name of ['search_proposal_receipts','search_proposal_abandons','search_approval_claims','search_run_claims','search_item_claims','search_proposal_cancels','search_proposal_turn_bindings','search_proposal_rejections','search_proposal_pending_generation'])test(`${name} cannot be silently recreated after search migration`,t=>{
  const s=fixture(t);s.db.exec(`DROP ${name==='search_proposal_pending_generation'?'INDEX':'TABLE'} ${name}`);assert.throws(()=>initializeSearchLedger(s),/missing after migration/);
});
test('search primary-key collation and unique-index predicate are checked',t=>{
  for(const mode of ['pk','index']){const s=fixture(t);if(mode==='pk'){const sql=s.db.prepare("SELECT sql FROM sqlite_master WHERE name='search_proposal_abandons'").get().sql;s.db.exec('DROP TABLE search_proposal_abandons');s.db.exec(sql.replace('session_id TEXT','session_id TEXT COLLATE NOCASE'));}else s.db.exec("DROP INDEX search_proposal_pending_generation; CREATE UNIQUE INDEX search_proposal_pending_generation ON search_proposal_receipts(session_id,generation_id) WHERE state='committed'");assert.throws(()=>initializeSearchLedger(s),/schema is invalid|index differs/,mode);}
});
test('a lost claim, or a missing manifest after migration, blocks startup',t=>{
  for(const mode of ['claim','manifest']){const s=fixture(t);s.transaction(()=>{s.db.prepare('INSERT INTO search_run_claims VALUES(?,?,?,?,?)').run(randomUUID(),'owner','a'.repeat(64),randomUUID(),new Date().toISOString());updateSearchLedgerManifest(s);});if(mode==='claim')s.db.exec('DELETE FROM search_run_claims');else s.db.exec("DELETE FROM meta WHERE key='searchReceiptManifest:v1'");assert.throws(()=>initializeSearchLedger(s),/manifest differs|marker or manifest is invalid/,mode);}
});
test('an abandonment audit prevents an unsafe unmarked rebaseline',t=>{
  const s=fixture(t),proposalId=randomUUID(),requestId=randomUUID();s.event(proposalId,'search_proposal_abandoned',{sessionId:'owner',requestId,payloadHash:'a'.repeat(64),proposalHash:'b'.repeat(64)});s.db.exec("DELETE FROM meta WHERE key IN ('searchReceiptSchema:v1','searchReceiptManifest:v1')");assert.throws(()=>initializeSearchLedger(s),/generation marker is invalid/);
});
test('rejection audit distinguishes identical request IDs in different sessions',t=>{
  const s=fixture(t),requestId=randomUUID(),recordedAt=new Date().toISOString();s.transaction(()=>{for(const sessionId of ['owner-a','owner-b']){s.db.prepare('INSERT INTO search_proposal_rejections VALUES(?,?,?,?,?)').run(sessionId,requestId,'a'.repeat(64),400,recordedAt);s.event(requestId,'search_proposal_rejected',{sessionId,requestId,payloadHash:'a'.repeat(64),httpStatus:400,recordedAt});}updateSearchLedgerManifest(s);});assert.doesNotThrow(()=>initializeSearchLedger(s));
});
test('initial search ledger migration rolls back atomically on marker failure',t=>{
  const s=new RunStore(':memory:');t.after(()=>s.close());s.db.exec("CREATE TRIGGER fail_search_manifest BEFORE INSERT ON meta WHEN NEW.key='searchReceiptManifest:v1' BEGIN SELECT RAISE(ABORT,'injected manifest'); END");assert.throws(()=>initializeSearchLedger(s),/injected manifest/);assert.equal(s.db.prepare("SELECT name FROM sqlite_master WHERE name='search_proposal_receipts'").get(),undefined);s.db.exec('DROP TRIGGER fail_search_manifest');initializeSearchLedger(s);
});
function legacyReceiptDatabase(t){const s=fixture(t);s.transaction(()=>{s.db.exec("DROP INDEX search_proposal_pending_generation; ALTER TABLE search_proposal_receipts DROP COLUMN generation_id; CREATE UNIQUE INDEX search_proposal_pending_session ON search_proposal_receipts(session_id) WHERE state='started'; DELETE FROM meta WHERE key='searchReceiptGenerations:v1'");s.db.prepare('INSERT INTO search_proposal_receipts VALUES(?,?,?,?,?,?)').run('owner','legacy-request','a'.repeat(64),randomUUID(),'b'.repeat(64),'started');updateSearchLedgerManifest(s);});return s;}
test('old receipt schema migrates without changing old receipt data or reusing old requests',t=>{
 const s=legacyReceiptDatabase(t),before=s.db.prepare('SELECT * FROM search_proposal_receipts').get(),row=fixtureRow('owner');initializeSearchLedger(s);assert.equal(s.db.prepare('PRAGMA table_info(search_proposal_receipts)').all().length,6);assert.throws(()=>initializeSearchLedger(s,{enableGenerationSchema:true}),/fence or durable pending/);beginCutover(s,row,()=>true);commitPreparedCutover(s,row,()=>true);const after=s.db.prepare('SELECT * FROM search_proposal_receipts').get();assert.deepEqual(Object.values(after).slice(0,6),Object.values(before));assert.equal(after.generation_id,'legacy');assert.equal(s.db.prepare("SELECT value FROM meta WHERE key='searchReceiptGenerations:v1'").get().value,'done');assert.doesNotThrow(()=>initializeSearchLedger(s));assert.throws(()=>s.db.prepare('INSERT INTO search_proposal_receipts VALUES(?,?,?,?,?,?)').run('owner','other','a'.repeat(64),randomUUID(),'b'.repeat(64),'started'),/columns/);
});
test('receipt generation migration rolls back old schema and manifest on a failed marker',t=>{
 const s=legacyReceiptDatabase(t),before=s.db.prepare("SELECT value FROM meta WHERE key='searchReceiptManifest:v1'").get().value,row=fixtureRow('owner');beginCutover(s,row,()=>true);s.db.exec("CREATE TRIGGER fail_generation_marker BEFORE INSERT ON meta WHEN NEW.key='searchReceiptGenerations:v1' BEGIN SELECT RAISE(ABORT,'injected generation marker'); END");assert.throws(()=>commitPreparedCutover(s,row,()=>true),/injected generation marker/);assert.equal(s.db.prepare("SELECT value FROM meta WHERE key='searchReceiptManifest:v1'").get().value,before);assert.equal(s.db.prepare('PRAGMA table_info(search_proposal_receipts)').all().length,6);assert.ok(s.db.prepare("SELECT 1 FROM sqlite_master WHERE name='search_proposal_pending_session'").get());assert.equal(s.db.prepare('SELECT count(*) AS n FROM search_cutover_pending').get().n,1);
});
test('search session turn schema requires a binary session primary key',t=>{
  const s=fixture(t);s.db.exec('CREATE TABLE search_session_turns(session_id TEXT PRIMARY KEY,latest INTEGER NOT NULL,stopped_at INTEGER)');assert.doesNotThrow(()=>validateSearchSessionTurns(s.db));
  s.db.exec('DROP TABLE search_session_turns; CREATE TABLE search_session_turns(session_id TEXT COLLATE NOCASE PRIMARY KEY,latest INTEGER NOT NULL,stopped_at INTEGER)');assert.throws(()=>validateSearchSessionTurns(s.db),/turn schema is invalid/);
});
