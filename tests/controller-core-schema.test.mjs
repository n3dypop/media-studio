import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {RunStore} from '../apps/controller/store.mjs';
import {ProductionStore} from '../apps/controller/productions.mjs';
import {AssetStore} from '../apps/controller/assets.mjs';
import {DurableWireStore} from '../apps/controller/durable-wire-store.mjs';

async function fixture(t){const root=await mkdtemp(join(tmpdir(),'controller-core-schema-'));t.after(()=>rm(root,{recursive:true,force:true}));return {root,file:join(root,'controller.db')};}

for(const table of ['meta','runs','events'])test(`existing Controller refuses missing ${table} without recreating it`,async t=>{
  const {file}=await fixture(t);let store=new RunStore(file);store.close();
  let db=new DatabaseSync(file);db.exec(`DROP TABLE ${table}`);db.close();
  assert.throws(()=>new RunStore(file),/core table is missing/i);
  db=new DatabaseSync(file,{readOnly:true});assert.equal(db.prepare('SELECT name FROM sqlite_schema WHERE name=?').get(table),undefined);db.close();
});

test('new Controller initializes once and preserves its identity; an existing empty file is not a new ledger',async t=>{
  const {file,root}=await fixture(t);let store=new RunStore(file),id=store.controllerId;store.close();store=new RunStore(file);assert.equal(store.controllerId,id);store.close();
  const empty=join(root,'empty.db');await writeFile(empty,'');assert.throws(()=>new RunStore(empty),/existing Controller database is empty/i);
});

test('a missing Controller database is not silently replaced when its provisioning marker remains',async t=>{
  const {file}=await fixture(t);const store=new RunStore(file);store.close();await rm(file);
  assert.throws(()=>new RunStore(file),/previously provisioned Controller database is missing/i);
  const {stat}=await import('node:fs/promises');await assert.rejects(stat(file),error=>error.code==='ENOENT');
});

test('a missing marker or different database generation stays blocked and is not silently repaired',async t=>{
  const {file,root}=await fixture(t);let store=new RunStore(file);store.close();await rm(file+'.provision');
  assert.throws(()=>new RunStore(file),/provisioning marker is missing/i);
  const {stat}=await import('node:fs/promises');await assert.rejects(stat(file+'.provision'),error=>error.code==='ENOENT');
  const replacement=join(root,'replacement.db');store=new RunStore(replacement);store.close();
  const {copyFile}=await import('node:fs/promises');await copyFile(replacement+'.provision',file+'.provision');
  assert.throws(()=>new RunStore(file),/generation differs/i);
});

test('a complete legacy database is adopted once, preserving data; interrupted adoption stays blocked',async t=>{
  const {file,root}=await fixture(t);let store=new RunStore(file);store.db.exec("INSERT INTO runs VALUES ('legacy','legacy-request','hash','queued','{}'); DELETE FROM meta WHERE key='controllerCoreProvision:v1'");store.close();await rm(file+'.provision');
  store=new RunStore(file);assert.equal(store.db.prepare('SELECT count(*) AS n FROM runs').get().n,1);store.close();
  await rm(file+'.provision');assert.throws(()=>new RunStore(file),/provisioning marker is missing/i);
  const interrupted=join(root,'interrupted.db');await writeFile(interrupted+'.provision','media-studio-controller-v1:11111111-1111-4111-8111-111111111111\n');
  assert.throws(()=>new RunStore(interrupted),/previously provisioned Controller database is missing/i);
});

test('existing Controller refuses missing identity and altered schema',async t=>{
  const {file}=await fixture(t);let store=new RunStore(file);store.db.prepare("DELETE FROM meta WHERE key='controllerId'").run();store.close();assert.throws(()=>new RunStore(file),/identity is missing/i);
  const other=join(await mkdtemp(join(tmpdir(),'controller-core-altered-')),'db');t.after(()=>rm(join(other,'..'),{recursive:true,force:true}));store=new RunStore(other);store.db.exec('DROP TABLE runs; CREATE TABLE runs(id TEXT PRIMARY KEY,request_id TEXT NOT NULL,payload_hash TEXT NOT NULL,phase TEXT NOT NULL,json TEXT NOT NULL)');store.close();assert.throws(()=>new RunStore(other),/definition differs/i);
});

for(const table of ['productions','evaluations'])test(`production initialization refuses missing ${table}`,()=>{
  const store=new RunStore(':memory:');try{new ProductionStore(store);store.db.exec(`DROP TABLE ${table}`);assert.throws(()=>new ProductionStore(store),/core table is missing/i);assert.equal(store.db.prepare('SELECT name FROM sqlite_schema WHERE name=?').get(table),undefined);}finally{store.close();}
});

test('complete pre-marker production tables are adopted while incomplete legacy tables are rejected',()=>{
  let store=new RunStore(':memory:');try{store.db.exec('CREATE TABLE productions(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,request_id TEXT NOT NULL,payload_hash TEXT NOT NULL,json TEXT NOT NULL,UNIQUE(session_id,request_id)); CREATE TABLE evaluations(id TEXT PRIMARY KEY,production_id TEXT NOT NULL,run_id TEXT UNIQUE NOT NULL,json TEXT NOT NULL)');new ProductionStore(store);assert.equal(store.db.prepare("SELECT value FROM meta WHERE key='productionCoreSchema:v1'").get().value,'done');}finally{store.close();}
  store=new RunStore(':memory:');try{store.db.exec('CREATE TABLE productions(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,request_id TEXT NOT NULL,payload_hash TEXT NOT NULL,json TEXT NOT NULL,UNIQUE(session_id,request_id))');assert.throws(()=>new ProductionStore(store),/core table is missing/i);}finally{store.close();}
});

test('asset and wire evidence tables are not recreated after initialization',async t=>{
  const {root}=await fixture(t),store=new RunStore(':memory:');try{
    new AssetStore({store,root,inputRoot:root});store.db.exec('DROP TABLE assets');assert.throws(()=>new AssetStore({store,root,inputRoot:root}),/core table is missing/i);
    new DurableWireStore(store);store.db.exec('DROP TABLE durable_wire_evidence');assert.throws(()=>new DurableWireStore(store),/core table is missing/i);
    assert.equal(store.db.prepare("SELECT name FROM sqlite_schema WHERE name='durable_wire_evidence'").get(),undefined);
  }finally{store.close();}
});

for(const table of ['assets','productions','durable_wire_evidence'])test(`${table} rejects a case-insensitive session owner`,async t=>{
  const {root}=await fixture(t),store=new RunStore(':memory:');try{
    const initialize=()=>table==='assets'?new AssetStore({store,root,inputRoot:root}):table==='productions'?new ProductionStore(store):new DurableWireStore(store);
    initialize();const old=store.db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(table).sql;
    const changed=old.replace('session_id TEXT NOT NULL','session_id TEXT NOT NULL COLLATE NOCASE');assert.notEqual(changed,old);
    store.db.exec(`DROP TABLE ${table}; ${changed}`);
    assert.throws(initialize,/core table definition differs/i);
  }finally{store.close();}
});

test('complete pre-marker asset and wire tables can be adopted without discarding rows',async t=>{
  const {root}=await fixture(t),store=new RunStore(':memory:');try{
    store.db.exec('CREATE TABLE assets(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,json TEXT NOT NULL); CREATE TABLE durable_wire_evidence(session_id TEXT NOT NULL,intent_id TEXT NOT NULL,receipt_hash TEXT NOT NULL,nonce_hash TEXT NOT NULL,prior_call_hash TEXT NOT NULL,next_call_hash TEXT NOT NULL,PRIMARY KEY(session_id,intent_id,receipt_hash,nonce_hash,prior_call_hash,next_call_hash))');
    store.db.prepare('INSERT INTO assets VALUES(?,?,?)').run('legacy','owner','{}');
    new AssetStore({store,root,inputRoot:root});new DurableWireStore(store);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM assets').get().n,1);
  }finally{store.close();}
});
