// Independent negative tests: cancellation never schedules a foreign run.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer as reserve} from 'node:net';
import {randomUUID} from 'node:crypto';
import {RunStore} from '../apps/controller/store.mjs';
import {ProductionStore} from '../apps/controller/productions.mjs';
import {createControllerServer} from '../apps/controller/http.mjs';
import {productionRoute} from '../apps/controller/production-http.mjs';

async function fixture(t,{already=false,lateMismatch=false}={}){
  const store=new RunStore(':memory:'),productions=new ProductionStore(store),owner='owner';
  const production=productions.create(owner,{requestId:randomUUID(),modelProfile:'moss-image-sft-int8-v1',brief:{request:'fixture',criteria:[{id:'C1',description:'fixture'}],invariants:[]}}).production;
  const run=store.create({requestId:randomUUID(),spec:{modelProfile:'moss-image-sft-int8-v1'}},{decorate:()=>({sessionId:already?'foreign':owner,productionId:already?randomUUID():production.id})}).run;
  store.transaction(()=>{production.attempts=[run.id];production.latestRunId=run.id;production.phase=already?'cancelled':'generating';if(already){production.cancelRequested=true;production.cancelRequestedAt=new Date().toISOString();production.revision=1;}productions.write(production,'fixture_attempt');});
  const scheduled=[],engine={work:new Set(),launch:(id,recovery)=>scheduled.push({id,recovery})};
  const mossPe={work:new Set(),cancelProduction(){if(lateMismatch){const changed=store.get(run.id);changed.sessionId='foreign';changed.productionId=randomUUID();store.db.prepare('UPDATE runs SET json=? WHERE id=?').run(JSON.stringify(changed),run.id);}}};
  const hold=reserve();await new Promise(ok=>hold.listen(0,'127.0.0.1',ok));const port=hold.address().port;await new Promise(ok=>hold.close(ok));
  const server=createControllerServer({store,productions,workflows:{},engine,token:'fixture-admin',dshToken:'fixture-dsh',port,mossPe});await new Promise(ok=>server.listen(port,'127.0.0.1',ok));
  t.after(async()=>{server.closeAllConnections();await new Promise(ok=>server.close(ok));store.close();});
  async function cancel(operation){const admin=operation==='cancel-owned',input={requestId:randomUUID(),...(admin?{expectedRunId:run.id,expectedRevision:production.revision}:{})};const response=await fetch(`http://127.0.0.1:${port}/api/productions/${production.id}/${operation}`,{method:'POST',headers:{Authorization:'Bearer '+(admin?'fixture-admin':'fixture-dsh'),'X-DSH-Session':owner,'Content-Type':'application/json'},body:JSON.stringify(input)});await new Promise(ok=>setTimeout(ok,30));return response;}
  return {cancel,scheduled,run};
}

for(const operation of ['cancel','cancel-owned']){
  test(`${operation} rejects a foreign listed run even when production was already stopped`,async t=>{
    const f=await fixture(t,{already:true}),response=await f.cancel(operation);
    assert.equal(response.status,409);assert.deepEqual(f.scheduled,[]);
  });
  test(`${operation} does not schedule a run whose owner changed after acceptance`,async t=>{
    const f=await fixture(t,{lateMismatch:true}),response=await f.cancel(operation);
    assert.equal(response.status,503);assert.deepEqual(f.scheduled,[]);
  });
}

test('a run whose owner changes after scheduling is not launched by the deferred callback',async t=>{
  const store=new RunStore(':memory:'),productions=new ProductionStore(store),owner='owner';t.after(()=>store.close());
  const p=productions.create(owner,{requestId:randomUUID(),modelProfile:'moss-image-sft-int8-v1',brief:{request:'fixture',criteria:[{id:'C1',description:'fixture'}],invariants:[]}}).production;
  const run=store.create({requestId:randomUUID(),spec:{modelProfile:'moss-image-sft-int8-v1'}},{decorate:()=>({sessionId:owner,productionId:p.id})}).run;
  store.transaction(()=>{p.attempts=[run.id];p.latestRunId=run.id;p.phase='generating';productions.write(p,'fixture_attempt');});
  const launched=[],engine={work:new Set(),launch:(...args)=>launched.push(args)};let response;
  await productionRoute({req:{method:'POST',headers:{'x-dsh-session':owner}},res:{},path:`/api/productions/${p.id}/cancel-owned`,url:new URL('http://local/'),role:'admin',store,engine,productions,workflows:{},body:async()=>({requestId:randomUUID(),expectedRevision:0,expectedRunId:run.id}),json:(_res,status,value)=>response={status,value}});
  assert.equal(response.status,202);const current=store.get(run.id);current.sessionId='foreign';current.productionId=randomUUID();store.db.prepare('UPDATE runs SET json=? WHERE id=?').run(JSON.stringify(current),run.id);
  const prior=console.error;let logged=0;console.error=()=>logged++;
  try{await new Promise(resolve=>setImmediate(resolve));}finally{console.error=prior;}
  assert.deepEqual(launched,[]);assert.equal(logged,1);assert.equal(store.get(run.id).sessionId,'foreign');
});
