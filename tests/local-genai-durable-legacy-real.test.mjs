import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {RunStore,digest} from '../apps/controller/store.mjs';
import {ProductionStore} from '../apps/controller/productions.mjs';
import {verifyLegacyRenderReceipt} from '../apps/dsh-plugins/local-genai/durable-receipts.mjs';
import {createControllerServer} from '../apps/controller/http.mjs';
import {createServer as reservePort} from 'node:net';

for(const enhancer of [false,true])test(`DSH verifies real Controller legacy receipt with enhancer=${enhancer}`,t=>{
 const store=new RunStore(':memory:'),productions=new ProductionStore(store);t.after(()=>store.close());
 const session='owner',p=productions.create(session,{requestId:randomUUID(),brief:{request:'adult portrait',modelProfile:'moss-image-sft-int8-v1',mode:'t2i',criteria:[{id:'C1',description:'portrait'}],invariants:['adult']}}).production;
 const graph={'1':{class_type:'Fixture',inputs:{}}},workflow={schemaVersion:2,id:randomUUID(),productionId:p.id,modelProfile:p.brief.modelProfile,graph,sha256:digest(graph),rationale:'fixture'},bound=productions.bindWorkflow(p.id,session,0,workflow);
 const input={requestId:randomUUID(),expectedRevision:bound.revision,workflowId:workflow.id,prompt:'adult portrait',negativePrompt:'text',seed:'42',width:512,height:768,steps:25,enhancer},created=productions.render(p.id,session,input,workflow),intent={operation:'render',sessionId:session,requestId:input.requestId,targetId:p.id,inputHash:digest(input)};
 let found=productions.findRenderByRequest(p.id,session,input.requestId);assert.equal(found.receipt.originalSpecHash,digest(created.run.spec));assert.equal(found.receipt.effectiveSpecPresent,false);assert.equal(found.receipt.effectiveSpecHash,null);assert.equal(verifyLegacyRenderReceipt(intent,session,found).outcome,'applied');
 if(enhancer){const original=created.run.spec,effective={...original,prompt:'enhanced portrait',negativePrompt:'different'},specHash=digest(effective),marker={id:randomUUID()},result={childExited:true,cleanupConfirmed:true};store.update(created.run.id,{enhancerStartIntent:marker,enhancerCleanup:{intentId:marker.id,confirmed:true,childExited:true},enhancement:result},'enhancer_cleanup_confirmed');store.update(created.run.id,{enhancement:result,effectiveSpec:effective,specHash},'prompt_enhanced');found=productions.findRenderByRequest(p.id,session,input.requestId);assert.equal(found.receipt.originalSpecHash,digest(original));assert.equal(found.receipt.effectiveSpecPresent,true);assert.equal(found.receipt.effectiveSpecHash,specHash);assert.equal(verifyLegacyRenderReceipt(intent,session,found).outcome,'applied');
  const altered=structuredClone(found);altered.run.effectiveSpec.seed='99';altered.run.specHash=digest(altered.run.effectiveSpec);assert.throws(()=>verifyLegacyRenderReceipt(intent,session,altered),/unresolved/);
  const incomplete=structuredClone(found);incomplete.run.enhancerCleanup.confirmed=false;assert.throws(()=>verifyLegacyRenderReceipt(intent,session,incomplete),/unresolved/);
  const omitted=structuredClone(found);delete omitted.run.effectiveSpec;omitted.run.specHash=digest(omitted.run.spec);assert.throws(()=>verifyLegacyRenderReceipt(intent,session,omitted),/unresolved/);
  const dbRow=store.db.prepare('SELECT json FROM runs WHERE id=?').get(created.run.id),dbRun=JSON.parse(dbRow.json);delete dbRun.effectiveSpec;dbRun.specHash=digest(dbRun.spec);store.db.prepare('UPDATE runs SET json=? WHERE id=?').run(JSON.stringify(dbRun),created.run.id);assert.throws(()=>productions.findRenderByRequest(p.id,session,input.requestId),/保存済み旧形式生成/);store.db.prepare('UPDATE runs SET json=? WHERE id=?').run(dbRow.json,created.run.id);
 }
 assert.throws(()=>verifyLegacyRenderReceipt({...intent,inputHash:'0'.repeat(64)},session,found),/unresolved/);
});

test('legacy GET receipt cannot substitute a different render spec under the original request hash',t=>{
 const store=new RunStore(':memory:'),productions=new ProductionStore(store);t.after(()=>store.close());
 const session='owner',p=productions.create(session,{requestId:randomUUID(),brief:{request:'adult portrait',modelProfile:'moss-image-sft-int8-v1',mode:'t2i',criteria:[{id:'C1',description:'portrait'}],invariants:['adult']}}).production;
 const graph={'1':{class_type:'Fixture',inputs:{}}},workflow={schemaVersion:2,id:randomUUID(),productionId:p.id,modelProfile:p.brief.modelProfile,graph,sha256:digest(graph),rationale:'fixture'},bound=productions.bindWorkflow(p.id,session,0,workflow);
 const input={requestId:randomUUID(),expectedRevision:bound.revision,workflowId:workflow.id,prompt:'adult portrait',negativePrompt:'text',seed:'42',width:512,height:768,steps:25,enhancer:false};productions.render(p.id,session,input,workflow);
 const received=productions.findRenderByRequest(p.id,session,input.requestId),intent={operation:'render',sessionId:session,requestId:input.requestId,targetId:p.id,inputHash:digest(input)};assert.equal(verifyLegacyRenderReceipt(intent,session,received).outcome,'applied');
 for(const field of ['seed','prompt','width']){const changed=structuredClone(received);changed.run.spec[field]=field==='width'?640:field==='seed'?'99':'different portrait';changed.run.specHash=digest(changed.run.spec);assert.throws(()=>verifyLegacyRenderReceipt(intent,session,changed),/unresolved/,`Changed ${field} must not be accepted under the original request hash`);}
 const badReceipt=structuredClone(received);badReceipt.receipt.originalSpecHash='0'.repeat(64);assert.throws(()=>verifyLegacyRenderReceipt(intent,session,badReceipt),/unresolved/);
});

test('failed enhancement without an effective prompt remains an admission receipt only',t=>{
 const store=new RunStore(':memory:'),productions=new ProductionStore(store);t.after(()=>store.close());
 const session='owner',p=productions.create(session,{requestId:randomUUID(),brief:{request:'adult portrait',modelProfile:'moss-image-sft-int8-v1',mode:'t2i',criteria:[{id:'C1',description:'portrait'}],invariants:['adult']}}).production;
 const graph={'1':{class_type:'Fixture',inputs:{}}},workflow={schemaVersion:2,id:randomUUID(),productionId:p.id,modelProfile:p.brief.modelProfile,graph,sha256:digest(graph),rationale:'fixture'},bound=productions.bindWorkflow(p.id,session,0,workflow);
 const input={requestId:randomUUID(),expectedRevision:bound.revision,workflowId:workflow.id,prompt:'adult portrait',negativePrompt:'text',seed:'42',width:512,height:768,steps:25,enhancer:true},created=productions.render(p.id,session,input,workflow);store.update(created.run.id,{phase:'failed'},'failed');
 const value=productions.findRenderByRequest(p.id,session,input.requestId),intent={operation:'render',sessionId:session,requestId:input.requestId,targetId:p.id,inputHash:digest(input)};assert.equal(value.run.phase,'failed');assert.equal(value.receipt.effectiveSpecPresent,false);assert.equal(value.receipt.effectiveSpecHash,null);assert.equal(verifyLegacyRenderReceipt(intent,session,value).outcome,'applied');
});

test('enhanced submissions cannot lose their effective prompt even when the run later fails or is cancelled',t=>{
 const store=new RunStore(':memory:'),productions=new ProductionStore(store);t.after(()=>store.close());
 const session='owner',p=productions.create(session,{requestId:randomUUID(),brief:{request:'adult portrait',modelProfile:'moss-image-sft-int8-v1',mode:'t2i',criteria:[{id:'C1',description:'portrait'}],invariants:['adult']}}).production;
 const graph={'1':{class_type:'Fixture',inputs:{}}},workflow={schemaVersion:2,id:randomUUID(),productionId:p.id,modelProfile:p.brief.modelProfile,graph,sha256:digest(graph),rationale:'fixture'},bound=productions.bindWorkflow(p.id,session,0,workflow);
 const input={requestId:randomUUID(),expectedRevision:bound.revision,workflowId:workflow.id,prompt:'adult portrait',negativePrompt:'text',seed:'42',width:512,height:768,steps:25,enhancer:true},created=productions.render(p.id,session,input,workflow),intent={operation:'render',sessionId:session,requestId:input.requestId,targetId:p.id,inputHash:digest(input)},before=productions.findRenderByRequest(p.id,session,input.requestId);
 for(const phase of ['failed','cancelled','recovery_required']){const forged=structuredClone(before);forged.run.phase=phase;forged.run.promptId=randomUUID();assert.throws(()=>verifyLegacyRenderReceipt(intent,session,forged),/unresolved/);store.update(created.run.id,{phase,promptId:forged.run.promptId});assert.throws(()=>productions.findRenderByRequest(p.id,session,input.requestId),/保存済み旧形式生成/);}
});

test('completed enhanced render with both effective spec and success event missing cannot become an original-only receipt',{timeout:10000},async t=>{
 const store=new RunStore(':memory:'),productions=new ProductionStore(store),session='owner',p=productions.create(session,{requestId:randomUUID(),brief:{request:'adult portrait',modelProfile:'moss-image-sft-int8-v1',mode:'t2i',criteria:[{id:'C1',description:'portrait'}],invariants:['adult']}}).production;
 const graph={'1':{class_type:'Fixture',inputs:{}}},workflow={schemaVersion:2,id:randomUUID(),productionId:p.id,modelProfile:p.brief.modelProfile,graph,sha256:digest(graph),rationale:'fixture'},bound=productions.bindWorkflow(p.id,session,0,workflow);
 const input={requestId:randomUUID(),expectedRevision:bound.revision,workflowId:workflow.id,prompt:'adult portrait',negativePrompt:'text',seed:'42',width:512,height:768,steps:25,enhancer:true},created=productions.render(p.id,session,input,workflow),runId=created.run.id,marker={id:randomUUID()},enhancement={childExited:true,cleanupConfirmed:true},effectiveSpec={...created.run.spec,prompt:'enhanced portrait'};
 store.update(runId,{enhancerStartIntent:marker,enhancerCleanup:{intentId:marker.id,confirmed:true,childExited:true},enhancement},'enhancer_cleanup_confirmed');store.update(runId,{enhancement,effectiveSpec,specHash:digest(effectiveSpec),phase:'completed'},'prompt_enhanced');
 const original=productions.findRenderByRequest(p.id,session,input.requestId),intent={operation:'render',sessionId:session,requestId:input.requestId,targetId:p.id,inputHash:digest(input)};assert.equal(verifyLegacyRenderReceipt(intent,session,original).outcome,'applied');
 const corrupt=structuredClone(original);delete corrupt.run.effectiveSpec;corrupt.run.specHash=digest(corrupt.run.spec);corrupt.receipt.effectiveSpecPresent=false;corrupt.receipt.effectiveSpecHash=null;
 const saved=JSON.parse(store.db.prepare('SELECT json FROM runs WHERE id=?').get(runId).json);delete saved.effectiveSpec;saved.specHash=digest(saved.spec);store.db.prepare('UPDATE runs SET json=? WHERE id=?').run(JSON.stringify(saved),runId);store.db.prepare("DELETE FROM events WHERE run_id=? AND type='prompt_enhanced'").run(runId);
 const reserve=reservePort();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
 const server=createControllerServer({store,productions,workflows:{get:async id=>{assert.equal(id,workflow.id);return workflow;}},engine:{work:new Set()},token:'fixture-admin',dshToken:'fixture-dsh',port});await new Promise((resolve,reject)=>server.once('error',reject).listen(port,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();});
 const response=await fetch(`http://127.0.0.1:${port}/api/productions/${p.id}/run-by-request?requestId=${input.requestId}`,{headers:{Authorization:'Bearer fixture-dsh','X-DSH-Session':session}});
 assert.equal(response.status,409,'Controller must not convert completed enhanced work into an original-only receipt');assert.throws(()=>verifyLegacyRenderReceipt(intent,session,corrupt),/unresolved/);
});
