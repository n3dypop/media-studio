// SQLite-only fixtures for immutable production and workflow evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,lstat,readdir,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {spawnSync} from 'node:child_process';
import {RunStore,digest} from '../apps/controller/store.mjs';
import {ProductionStore} from '../apps/controller/productions.mjs';

async function noLinks(root){for(const e of await readdir(root,{withFileTypes:true})){const p=join(root,e.name),s=await lstat(p);assert.equal(s.isSymbolicLink(),false);if(s.isDirectory())await noLinks(p);else assert.equal(s.isFile(),true);}}
async function fixture(t,{disk=false}={}){
  const base=await realpath(tmpdir()),root=await mkdtemp(join(base,'workflow-brief-snapshot-')),path=disk?join(root,'state.sqlite'):':memory:';
  let store=new RunStore(path),productions=new ProductionStore(store);
  const owner='owner',p=productions.create(owner,{requestId:randomUUID(),brief:{request:'original',modelProfile:'qwen-photo-v1',criteria:[{id:'C1',description:'original'}],invariants:[]}}).production;
  const requestId=randomUUID(),prep=productions.beginWorkflowPreparation(p.id,owner,{requestId,expectedRevision:0}),graph={'1':{class_type:'Fixture',inputs:{}}},w={id:randomUUID(),productionId:p.id,modelProfile:'qwen-photo-v1',graph,sha256:digest(graph),rationale:'fixture'};
  productions.bindWorkflow(p.id,owner,0,w,null,prep);
  t.after(async()=>{store.close();assert.equal(await realpath(root),root);assert.ok(resolve(root).startsWith(resolve(base)+sep));await noLinks(root);await rm(root,{recursive:true});});
  return {root,path,owner,p,w,requestId,get store(){return store;},get productions(){return productions;},reopen(){store.close();store=new RunStore(path);productions=new ProductionStore(store);}};
}

for(const kind of ['payload-hash','request-id','created-hash','created-missing','created-duplicate','selected-hash','selected-duplicate'])test(`workflow lookup rejects changed ${kind}`,async t=>{
  const f=await fixture(t),db=f.store.db;
  if(kind==='payload-hash')db.prepare('UPDATE productions SET payload_hash=? WHERE id=?').run('0'.repeat(64),f.p.id);
  if(kind==='request-id'){const p=f.productions.get(f.p.id,f.owner);p.requestId=randomUUID();db.prepare('UPDATE productions SET json=? WHERE id=?').run(JSON.stringify(p),p.id);}
  if(kind==='created-hash')db.prepare("UPDATE events SET json='{}' WHERE run_id=? AND type='production_created'").run(f.p.id);
  if(kind==='created-missing')db.prepare("DELETE FROM events WHERE run_id=? AND type='production_created'").run(f.p.id);
  if(kind==='created-duplicate')f.store.event(f.p.id,'production_created',{briefHash:f.p.briefHash});
  if(kind==='selected-hash')db.prepare("UPDATE events SET json='{}' WHERE run_id=? AND type='workflow_selected'").run(f.p.id);
  if(kind==='selected-duplicate')f.store.event(f.p.id,'workflow_selected',{revision:1,workflowId:f.w.id,sha256:f.w.sha256});
  assert.throws(()=>f.productions.findWorkflowPreparation(f.p.id,f.owner,f.requestId),e=>e.status===409);
});

test('an existing pre-receipt database preserves workflow reads after the additive migration',async t=>{
  const f=await fixture(t,{disk:true});
  f.store.db.exec("DROP TABLE production_cancel_receipts; DROP TABLE production_action_receipts; DROP TABLE workflow_preparation_abandons; DELETE FROM meta WHERE key IN ('productionReceiptSchema:v1','productionReceiptManifest:v1','productionMutationRejections:v1','productionMutationManifest:v1');");
  f.reopen();const initial=f.productions.findWorkflowPreparation(f.p.id,f.owner,f.requestId);assert.equal(initial.receipt.workflowId,f.w.id);assert.equal(initial.cancellationReceipt,undefined);
  const cancelled=f.productions.cancelWithReceipt(f.p.id,f.owner,{requestId:randomUUID()},'cancel');
  assert.deepEqual(f.productions.findWorkflowPreparation(f.p.id,f.owner,f.requestId).cancellationReceipt,cancelled.receipt);
});

test('workflow production identity and original event are read from one snapshot across processes',async t=>{
  const f=await fixture(t,{disk:true}),original=f.productions.get.bind(f.productions);let changed=false;
  f.productions.get=(...args)=>{const p=original(...args);if(!changed){changed=true;const code=`import {DatabaseSync} from 'node:sqlite';const v=JSON.parse(process.env.WORKFLOW_SNAPSHOT_FIXTURE),db=new DatabaseSync(v.path);const row=db.prepare('SELECT json FROM productions WHERE id=?').get(v.id),p=JSON.parse(row.json);p.brief.request='different';db.prepare('UPDATE productions SET json=? WHERE id=?').run(JSON.stringify(p),v.id);db.close();`;const child=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',env:{...process.env,WORKFLOW_SNAPSHOT_FIXTURE:JSON.stringify({path:f.path,id:f.p.id})},windowsHide:true});assert.equal(child.status,0,child.stderr);}return p;};
  try{assert.equal(f.productions.findWorkflowPreparation(f.p.id,f.owner,f.requestId).receipt.workflowId,f.w.id);}finally{f.productions.get=original;}
  assert.equal(changed,true);assert.throws(()=>f.productions.findWorkflowPreparation(f.p.id,f.owner,f.requestId),e=>e.status===409);
});
