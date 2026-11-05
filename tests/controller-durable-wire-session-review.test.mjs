// Independent negative cases for Controller inference scope and wire evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {RunStore} from '../apps/controller/store.mjs';
import {DurableWireStore} from '../apps/controller/durable-wire-store.mjs';
import {createControllerServer} from '../apps/controller/http.mjs';
import {wireInputReceipts} from '../apps/controller/durable-wire-evidence.mjs';

const hash=x=>createHash('sha256').update(x).digest('hex'),event=x=>'data: '+JSON.stringify(x)+'\n\n';
async function fixture(t){
  const store=new RunStore(':memory:'),wireStore=new DurableWireStore(store),hold=createServer();await new Promise(ok=>hold.listen(0,'127.0.0.1',ok));const port=hold.address().port;await new Promise(ok=>hold.close(ok));
  const receipt={id:randomUUID(),receiptHash:'a'.repeat(64),ackNonce:'b'.repeat(43)},messages=[{role:'assistant',tool_calls:[{id:'old-call',type:'function',function:{name:'fixture',arguments:'{}'}}]},{role:'tool',tool_call_id:'old-call',content:JSON.stringify({journalReceipt:receipt})}];
  const sse=event({choices:[{index:0,delta:{tool_calls:[{index:0,id:'next-call'}]},finish_reason:null}]})+event({choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})+'data: [DONE]\n\n';
  const wireReader={collect:(sessionId,messages)=>wireInputReceipts({sessionId,messages,verify:record=>sessionId==='owner'&&record.intentId===receipt.id&&record.receiptHash===receipt.receiptHash&&record.receiptNonceHash===hash(receipt.ackNonce)&&record.priorCallIdHash===hash('old-call')?true:'not-current'})};
  const gate={acquireCore:async()=>async()=>{}},strata={forward:async()=>new Response(sse,{headers:{'Content-Type':'text/event-stream'}})},server=createControllerServer({store,wireStore,wireReader,gate,strata,engine:{work:new Set()},token:'fixture-admin',dshToken:'fixture-dsh',port});await new Promise(ok=>server.listen(port,'127.0.0.1',ok));
  t.after(async()=>{server.closeAllConnections();await new Promise(ok=>server.close(ok));store.close();});
  const base=`http://127.0.0.1:${port}`,headers={Authorization:'Bearer fixture-dsh','Content-Type':'application/json'};
  let scopeId=null;
  const scope=async session=>{const response=await fetch(base+'/api/core-scope/start',{method:'POST',headers:{...headers,'X-DSH-Session':session},body:JSON.stringify({requestId:randomUUID()})});if(response.ok)scopeId=(await response.clone().json()).scope.id;return response;};
  const inference=(session,scopeValue=scopeId)=>fetch(base+'/v1/chat/completions',{method:'POST',headers:{...headers,...(session===null?{}:{'X-DSH-Session':session}),...(scopeValue===null?{}:{'X-DSH-Scope':scopeValue})},body:JSON.stringify({model:'strata-core',stream:true,messages})});
  const proof={sessionId:'owner',intentId:receipt.id,receiptHash:receipt.receiptHash,receiptNonceHash:hash(receipt.ackNonce),priorCallIdHash:hash('old-call'),nextCallIdHash:hash('next-call')};
  return {scope,inference,has:()=>wireStore.has(proof)};
}

test('unscoped DSH inference cannot record wire evidence',async t=>{
  const f=await fixture(t),response=await f.inference('owner');assert.equal(response.status,409);await response.arrayBuffer();assert.equal(f.has(),false);
});
test('inference explicitly associated with the same session can record wire evidence',async t=>{
  const f=await fixture(t);assert.equal((await f.scope('owner')).status,201);const response=await f.inference('owner');assert.equal(response.status,200);await response.arrayBuffer();assert.equal(f.has(),true);
});
test('another session sharing the token cannot record evidence for the scope owner',async t=>{
  const f=await fixture(t);assert.equal((await f.scope('owner')).status,201);assert.equal((await f.scope('other')).status,409);
  const response=await f.inference('other');await response.arrayBuffer();assert.equal(f.has(),false,'a differently owned request must not attest the owner session');
});
test('an unbound inference request cannot by itself attest the scope owner',async t=>{
  const f=await fixture(t);assert.equal((await f.scope('owner')).status,201);
  const response=await f.inference(null);await response.arrayBuffer();assert.equal(f.has(),false,'an absent session binding must not attest the owner session');
});
test('missing scope ID cannot attest; an explicitly different ID is rejected',async t=>{
  const f=await fixture(t);assert.equal((await f.scope('owner')).status,201);
  const missing=await f.inference('owner',null);assert.equal(missing.status,200);await missing.arrayBuffer();assert.equal(f.has(),false);
  const wrong=await f.inference('owner',randomUUID());assert.equal(wrong.status,403);await wrong.arrayBuffer();assert.equal(f.has(),false);
});
