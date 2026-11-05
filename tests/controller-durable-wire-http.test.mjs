import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {RunStore} from '../apps/controller/store.mjs';
import {DurableWireStore} from '../apps/controller/durable-wire-store.mjs';
import {createControllerServer} from '../apps/controller/http.mjs';
import {wireInputReceipts} from '../apps/controller/durable-wire-evidence.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex'),sessionId='session-1',intentId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',receiptHash='a'.repeat(64),ackNonce='b'.repeat(43),oldCall='old-call',newCall='new-call',token='dsh-test';
const input={model:'strata-core',stream:true,messages:[{role:'user',content:'do not persist this prompt'},{role:'assistant',content:null,tool_calls:[{id:oldCall,type:'function',function:{name:'local_create',arguments:'{}'}}]},{role:'tool',tool_call_id:oldCall,content:JSON.stringify({journalReceipt:{id:intentId,receiptHash,ackNonce}})}]};
const proof={sessionId,intentId,receiptHash,receiptNonceHash:hash(ackNonce),priorCallIdHash:hash(oldCall),nextCallIdHash:hash(newCall)};
const event=x=>'data: '+JSON.stringify(x)+'\n\n',chunk=(delta={},finish_reason=null)=>({choices:[{index:0,delta,finish_reason}]});
const text=event(chunk({content:'thinking'})),tool=event(chunk({tool_calls:[{index:0,id:newCall,type:'function',function:{name:'next',arguments:'{}'}}]})),end=event(chunk({},'tool_calls'))+'data: [DONE]\n\n';

async function fixture(t,{stream}={}){
 const store=new RunStore(':memory:'),wireStore=new DurableWireStore(store),hold=createServer();await new Promise(ok=>hold.listen(0,'127.0.0.1',ok));const port=hold.address().port;await new Promise(ok=>hold.close(ok));let forwarded;
 const gate={acquireCore:async()=>async()=>{},status:()=>({activeCore:0})},strata={forward:async body=>{forwarded=body;return stream();}};
 const wireReader={collect:(id,messages)=>wireInputReceipts({sessionId:id,messages,verify:record=>record.sessionId===sessionId&&record.intentId===intentId&&record.receiptHash===receiptHash&&record.receiptNonceHash===hash(ackNonce)&&record.priorCallIdHash===hash(oldCall)?true:'not-current'})};
 const server=createControllerServer({store,wireStore,wireReader,gate,strata,engine:{work:new Set()},token:'admin',dshToken:token,port});await new Promise((ok,fail)=>server.once('error',fail).listen(port,'127.0.0.1',ok));
 t.after(async()=>{server.closeAllConnections();await new Promise(ok=>server.close(ok));store.close();});
 const origin=`http://127.0.0.1:${port}`,headers={Authorization:`Bearer ${token}`,'X-DSH-Session':sessionId,'Content-Type':'application/json'};
 const scope=await fetch(origin+'/api/core-scope/start',{method:'POST',headers,body:JSON.stringify({requestId:'11111111-1111-4111-8111-111111111111'})});assert.equal(scope.status,201);
 headers['X-DSH-Scope']=(await scope.json()).scope.id;
 return {store,wireStore,origin,headers,forwarded:()=>forwarded,read:(key=proof,override={})=>fetch(origin+'/api/durable-wire-proof?'+new URLSearchParams(key),{headers:{...headers,...override}})};
}

test('actual Controller HTTP forwards text before proof and gates tool-call bytes until durable proof',async t=>{
 let proceed;const gate=new Promise(resolve=>{proceed=resolve;});
 const f=await fixture(t,{stream:()=>new Response(new ReadableStream({async start(c){c.enqueue(Buffer.from(text));await gate;c.enqueue(Buffer.from(tool.slice(0,13)));c.enqueue(Buffer.from(tool.slice(13)+end));c.close();}}),{status:200,headers:{'Content-Type':'text/event-stream'}})});t.after(()=>proceed());
 const response=await fetch(f.origin+'/v1/chat/completions',{method:'POST',headers:f.headers,body:JSON.stringify(input)});assert.equal(response.status,200);const reader=response.body.getReader(),first=await reader.read();assert.equal(Buffer.from(first.value).toString(),text);assert.equal(f.wireStore.has(proof),false);assert.deepEqual(f.forwarded().messages,input.messages);
 proceed();let output=Buffer.from(first.value);for(;;){const {done,value}=await reader.read();if(done)break;output=Buffer.concat([output,Buffer.from(value)]);}assert.equal(output.toString(),text+tool+end);assert.equal(f.wireStore.has(proof),true);assert.deepEqual(await (await f.read()).json(),{present:true});
 assert.equal((await f.read(proof,{'X-DSH-Session':'session-2'})).status,404);assert.equal((await f.read(proof,{Authorization:'Bearer admin'})).status,403);assert.equal((await f.read(proof,{Authorization:'Bearer bad'})).status,401);
 const rows=f.store.db.prepare('SELECT * FROM durable_wire_evidence').all();assert.equal(rows.length,1);assert.ok(!JSON.stringify(rows).includes(ackNonce));assert.ok(!JSON.stringify(rows).includes('do not persist this prompt'));
});
test('truncated provider SSE is relayed without any delivery proof',async t=>{
 const f=await fixture(t,{stream:()=>new Response(tool,{status:200,headers:{'Content-Type':'text/event-stream'}})}),response=await fetch(f.origin+'/v1/chat/completions',{method:'POST',headers:f.headers,body:JSON.stringify(input)});assert.equal(await response.text(),tool);assert.equal(f.wireStore.has(proof),false);assert.deepEqual(await (await f.read()).json(),{present:false});
});
