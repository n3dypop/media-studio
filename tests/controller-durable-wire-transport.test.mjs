import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {RunStore} from '../apps/controller/store.mjs';
import {DurableWireStore} from '../apps/controller/durable-wire-store.mjs';
import {bufferAttestedResponse,relayAttestedSse} from '../apps/controller/durable-wire-transport.mjs';
import {wireInputReceipts} from '../apps/controller/durable-wire-evidence.mjs';
const readReceipts=({sessionId,messages})=>wireInputReceipts({sessionId,messages,verify:()=>true});
const hash=x=>createHash('sha256').update(x).digest('hex'),sessionId='session-1',intentId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',receiptHash='a'.repeat(64),ackNonce='b'.repeat(43),oldCall='old-call',newCall='new-call';
const input={messages:[{role:'assistant',tool_calls:[{id:oldCall,type:'function',function:{name:'local_create',arguments:'{}'}}]},{role:'tool',tool_call_id:oldCall,content:JSON.stringify({journalReceipt:{id:intentId,receiptHash,ackNonce}})}]};
const event=x=>'data: '+JSON.stringify(x)+'\n\n',chunk=(delta={},finish_reason=null)=>({choices:[{index:0,delta,finish_reason}]});
const sse=event(chunk({tool_calls:[{index:0,id:newCall,type:'function',function:{name:'next',arguments:'{}'}}]}))+event(chunk({},'tool_calls'))+'data: [DONE]\n\n';
const response=raw=>new Response(new ReadableStream({start(c){for(let i=0;i<raw.length;i+=7)c.enqueue(Buffer.from(raw.slice(i,i+7)));c.close();}}),{status:200,headers:{'Content-Type':'text/event-stream'}});
const key={sessionId,intentId,receiptHash,receiptNonceHash:hash(ackNonce),priorCallIdHash:hash(oldCall),nextCallIdHash:hash(newCall)};
test('complete provider response persists only receipt/call hashes before buffered delivery',async()=>{
 const store=new RunStore(':memory:'),wireStore=new DurableWireStore(store);try{const out=await bufferAttestedResponse({sessionId,input,upstream:response(sse),wireStore,readReceipts});assert.equal(out.proofRecorded,true);assert.equal(out.bytes.toString(),sse);assert.equal(wireStore.has(key),true);assert.equal(wireStore.has({...key,sessionId:'other'}),false);}finally{store.close();}
});
test('partial stream, model error and mismatched tool message cannot produce a proof',async()=>{
 const store=new RunStore(':memory:'),wireStore=new DurableWireStore(store);try{
  for(const raw of [sse.slice(0,-5),event(chunk({},'stop'))+'data: [DONE]\n\n','data: {bad}\n\n']){const out=await bufferAttestedResponse({sessionId,input,upstream:response(raw),wireStore,readReceipts});assert.equal(out.proofRecorded,false);assert.equal(wireStore.has(key),false);}
  const wrong={messages:[{role:'tool',tool_call_id:oldCall,content:input.messages[1].content}]};const out=await bufferAttestedResponse({sessionId,input:wrong,upstream:response(sse),wireStore,readReceipts});assert.equal(out.proofRecorded,false);assert.equal(wireStore.has(key),false);
 }finally{store.close();}
});
test('interrupted upstream cannot record a proof',async()=>{
 const store=new RunStore(':memory:'),wireStore=new DurableWireStore(store),abort=new AbortController();try{
  const upstream=new Response(new ReadableStream({start(c){c.enqueue(Buffer.from(sse.slice(0,20)));setTimeout(()=>abort.abort(Error('cancelled')),10);}}),{status:200,headers:{'Content-Type':'text/event-stream'}});
  await assert.rejects(bufferAttestedResponse({sessionId,input,upstream,wireStore,readReceipts,signal:abort.signal}),/cancelled/);assert.equal(wireStore.has(key),false);
 }finally{store.close();}
});
test('streaming forwards text early, commits proof before exposing the tool call and respects backpressure',async()=>{
 const store=new RunStore(':memory:'),wireStore=new DurableWireStore(store),reason=event(chunk({content:'thinking'})),calls=event(chunk({tool_calls:[{index:0,id:newCall,type:'function',function:{name:'next',arguments:'{}'}}]})),last=event(chunk({},'tool_calls'))+'data: [DONE]\n\n';let proceed,reasonSeen;const gate=new Promise(resolve=>{proceed=resolve;}),seen=new Promise(resolve=>{reasonSeen=resolve;}),output=[];
 const upstream=new Response(new ReadableStream({async start(c){c.enqueue(Buffer.from(reason));await gate;c.enqueue(Buffer.from(calls.slice(0,17)));c.enqueue(Buffer.from(calls.slice(17)+last));c.close();}}),{status:200,headers:{'Content-Type':'text/event-stream'}});
 try{
  const pending=relayAttestedSse({sessionId,input,upstream,wireStore,readReceipts,write:async bytes=>{const text=bytes.toString();if(text.includes('thinking')){assert.equal(wireStore.has(key),false);output.push(text);reasonSeen();await new Promise(resolve=>setTimeout(resolve,10));}else {if(text.includes(newCall))assert.equal(wireStore.has(key),true);output.push(text);}}});
  await seen;assert.equal(output.join(''),reason);assert.equal(wireStore.has(key),false);proceed();const result=await pending;assert.equal(result.proofRecorded,true);assert.equal(output.join(''),reason+calls+last);assert.equal(wireStore.has(key),true);
 }finally{proceed();store.close();}
});
test('truncated, oversized or disconnected streams never record proof or alter relayed bytes',async()=>{
 const store=new RunStore(':memory:'),wireStore=new DurableWireStore(store);try{
  const partial=event(chunk({tool_calls:[{index:0,id:newCall}]})),parts=[];const out=await relayAttestedSse({sessionId,input,upstream:response(partial),wireStore,readReceipts,write:async b=>parts.push(b)});assert.equal(out.proofRecorded,false);assert.equal(Buffer.concat(parts).toString(),partial);assert.equal(wireStore.has(key),false);
  const huge=Buffer.from('data: '+('x'.repeat(8*1024*1024+1))+'\n\n'),relayed=[];const oversized=await relayAttestedSse({sessionId,input,upstream:new Response(huge,{status:200,headers:{'Content-Type':'text/event-stream'}}),wireStore,readReceipts,write:async b=>relayed.push(b)});assert.equal(oversized.proofRecorded,false);assert.deepEqual(Buffer.concat(relayed),huge);assert.equal(wireStore.has(key),false);
  const broken=response(sse);await assert.rejects(relayAttestedSse({sessionId,input,upstream:broken,wireStore,readReceipts,write:async()=>{throw Error('downstream disconnected');}}),/disconnected/);
 }finally{store.close();}
});
