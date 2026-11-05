import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,lstatSync,readdirSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {RunStore} from '../apps/controller/store.mjs';
import {SearchService} from '../apps/controller/search/service.mjs';
import {recordCutover} from '../apps/controller/search/cutover-ledger.mjs';
import {fixtureRow} from './support/cutover-fixture.mjs';

for(const crashAt of ['after-pending','after-schema-before-cutover'])test(`process exit ${crashAt} preserves pending and cannot auto-resume`,t=>{
 const base=resolve(import.meta.dirname,'../../runtime/cache'),root=mkdtempSync(join(base,'cutover-crash-')),dbPath=join(root,'controller.db'),row=fixtureRow('crash-session'),moduleUrl=name=>pathToFileURL(resolve(import.meta.dirname,`../apps/controller/${name}`)).href;
 const source=`import {RunStore} from ${JSON.stringify(moduleUrl('store.mjs'))};import {SearchService} from ${JSON.stringify(moduleUrl('search/service.mjs'))};import {beginCutover,withCutoverCommitScope} from ${JSON.stringify(moduleUrl('search/cutover-ledger.mjs'))};import {initializeSearchLedger} from ${JSON.stringify(moduleUrl('search/ledger-schema.mjs'))};const root=process.env.FIXTURE_ROOT,row=JSON.parse(process.env.FIXTURE_ROW),store=new RunStore(process.env.FIXTURE_DB);new SearchService({root,store});beginCutover(store,row,()=>true);if(process.env.FIXTURE_CASE==='after-schema-before-cutover'){store.db.exec('BEGIN IMMEDIATE');withCutoverCommitScope(store.db,()=>{initializeSearchLedger({db:store.db,transaction:fn=>fn()},{enableGenerationSchema:true,verifyMigrationFence:()=>true});process.exit(0);});}process.exit(0);`;
 t.after(()=>{assert.ok(resolve(root).startsWith(base+sep));const walk=p=>{const s=lstatSync(p);assert.equal(s.isSymbolicLink(),false);if(s.isDirectory())for(const n of readdirSync(p))walk(join(p,n));};walk(root);rmSync(root,{recursive:true,force:true});});
 const child=spawnSync(process.execPath,['--input-type=module','-e',source],{env:{...process.env,FIXTURE_ROOT:root,FIXTURE_DB:dbPath,FIXTURE_ROW:JSON.stringify(row),FIXTURE_CASE:crashAt},encoding:'utf8',windowsHide:true,timeout:20000});assert.equal(child.status,0,child.stderr);
 const store=new RunStore(dbPath);try{assert.equal(store.db.prepare('SELECT count(*) AS n FROM search_cutover_pending').get().n,1);assert.equal(store.db.prepare("SELECT count(*) AS n FROM meta WHERE key='searchReceiptGenerations:v1'").get().n,0);assert.equal(store.db.prepare('PRAGMA table_info(search_proposal_receipts)').all().length,6);assert.throws(()=>new SearchService({root,store}),/pending.*explicit recovery/);assert.throws(()=>recordCutover(store.db,row,()=>true),/evidence unavailable/);}finally{store.close();}
});
