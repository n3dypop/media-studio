import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { StrataClient } from '../apps/controller/strata.mjs';

const good=patch=>({service:'strata',model:'Qwen3.6-35B-A3B',started:1793384581,loaded:true,vision:{enabled:true,available:true,error:null},activity:{in_flight:0},...patch});
async function fixture(t){
  const f={calls:[],current:good(),code:200,result:null};
  f.server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const text=Buffer.concat(chunks).toString('utf8');f.calls.push({path:req.url,headers:req.headers,body:text?JSON.parse(text):null});
    if(f.handler)return f.handler(req,res);
    let value=f.result??f.current;
    if(!f.result&&req.url==='/v1/load'){f.current=good();value={status:'loaded',...f.current};}
    if(!f.result&&req.url==='/v1/unload'){f.current=good({loaded:false});value={status:'unloaded',...f.current};}
    res.writeHead(f.code,{'Content-Type':'application/json'});res.end(JSON.stringify(value));
  });
  await new Promise(resolve=>f.server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{f.server.close(resolve);f.server.closeAllConnections();}));
  f.client=new StrataClient({baseUrl:`http://127.0.0.1:${f.server.address().port}/v1`,model:'Qwen3.6-35B-A3B',token:'private-fixture-key',timeoutMs:1000});
  return f;
}
test('Strata status, unload, and load preserve exact model identity and authenticated lifecycle contract',async t=>{
  const f=await fixture(t);
  assert.equal((await f.client.status()).loaded,true);
  assert.equal((await f.client.unload()).loaded,false);
  assert.equal((await f.client.load()).loaded,true);
  assert.deepEqual(f.calls.map(x=>x.path),['/v1/status','/v1/unload','/v1/load']);
  for(const call of f.calls)assert.equal(call.headers.authorization,'Bearer private-fixture-key');
  assert.deepEqual(f.calls[1].body,{model:'Qwen3.6-35B-A3B'});
  assert.equal(f.calls[1].headers.origin,undefined,'CPU management must not forward an unrelated browser origin');
});
test('Strata 409 is a busy failure, and 200 unsupported is not successful unloading',async t=>{
  const f=await fixture(t);f.code=409;f.result={error:{type:'model_busy'}};
  await assert.rejects(f.client.unload(),{status:409,code:'STRATA_BUSY'});
  f.code=200;f.result={...good({loaded:false}),status:'unsupported'};
  await assert.rejects(f.client.unload(),{code:'STRATA_UNLOAD_UNKNOWN'});
  assert.equal(f.calls.length,2,'management calls must not automatically retry');
});
test('Strata rejects a changed epoch, wrong model, malformed status, or unavailable vision',async t=>{
  const f=await fixture(t);await f.client.status();
  f.result=good({started:1793384582});await assert.rejects(f.client.status(),{code:'STRATA_EPOCH_CHANGED'});
  f.result=good({model:'OtherModel'});await assert.rejects(f.client.status(),{code:'STRATA_MODEL_CHANGED'});
  f.result=good({activity:{in_flight:'0'}});await assert.rejects(f.client.status(),{code:'STRATA_INVALID_RESPONSE'});
  f.result={...good({vision:{enabled:false,available:false,error:null}}),status:'loaded'};
  await assert.rejects(f.client.load(),{code:'STRATA_VISION_UNAVAILABLE'});
});
test('Strata checks a persisted expected epoch on its first observation',async t=>{
  const f=await fixture(t);
  f.client.started=1793384580;
  await assert.rejects(f.client.status(),{code:'STRATA_EPOCH_CHANGED'});
});
test('OpenAI proxy preserves images, tool calls, reasoning deltas, and SSE bytes',async t=>{
  const f=await fixture(t);
  const stream=': keep-alive\n\ndata: {"choices":[{"delta":{"reasoning_content":"considering","tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n';
  f.handler=(_req,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(stream.slice(0,35));res.end(stream.slice(35));};
  const body={model:'strata-core',stream:true,messages:[{role:'user',content:[{type:'text',text:'Inspect'},{type:'image_url',image_url:{url:'data:image/png;base64,aW1hZ2U='}}]},{role:'assistant',tool_calls:[{id:'call_1',type:'function',function:{name:'render_media',arguments:'{}'}}]},{role:'tool',tool_call_id:'call_1',content:'saved'}],tools:[{type:'function',function:{name:'render_media',parameters:{type:'object'}}}],tool_choice:'auto'};
  const response=await f.client.forward(body);
  assert.equal(await response.text(),stream);
  assert.deepEqual(f.calls[0].body,{...body,model:'Qwen3.6-35B-A3B'});
});
test('proxy rejection statuses pass through without retry and aborted calls send nothing',async t=>{
  const f=await fixture(t);f.code=503;f.result={error:{code:'server_draining'}};
  const response=await f.client.forward({messages:[{role:'user',content:'hello'}]});
  assert.equal(response.status,503);await response.arrayBuffer();
  const cancel=new AbortController();cancel.abort(new Error('user stopped'));
  await assert.rejects(f.client.forward({messages:[]},{signal:cancel.signal}),/user stopped/);
  await assert.rejects(f.client.forward({strata_mcp:true,messages:[]}),{code:'STRATA_TOOLS_DISABLED'});
  assert.equal(f.calls.length,1);
});
test('Strata client refuses non-loopback or path-changing upstreams',()=>{
  for(const baseUrl of ['https://127.0.0.1:8190','http://example.org:8190','http://user:key@127.0.0.1:8190','http://127.0.0.1:8190/config','http://127.0.0.1:8190?x=1'])assert.throws(()=>new StrataClient({baseUrl}));
});

test('management verifies process identity before and after HTTP and publishes immutable identity snapshots',async t=>{
  const f=await fixture(t);let checks=0;
  const identity={started:good().started,pid:100,instanceId:'one'};
  f.client.verifyIdentity=async()=>{checks++;return identity;};
  await f.client.status();assert.equal(checks,2);assert.equal(f.calls.length,1);
  const copy=f.client.identity;copy.instanceId='caller-change';
  assert.equal(f.client.currentIdentity.instanceId,'one');
});

test('lost process identity after a management reply cannot authorize unloading and never retries',async t=>{
  const f=await fixture(t);let checks=0;
  f.client.verifyIdentity=async()=>{if(++checks===2)throw new Error('replacement process');return {started:good().started};};
  await assert.rejects(f.client.unload(),{code:'STRATA_IDENTITY_UNKNOWN'});
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].path,'/v1/unload');
});

test('inference rechecks process ownership immediately before forwarding and sends nothing on failure',async t=>{
  const f=await fixture(t);let checks=0;
  f.client.verifyIdentity=async()=>{checks++;throw new Error('listener changed');};
  await assert.rejects(f.client.forward({messages:[{role:'user',content:'hello'}]}),{code:'STRATA_IDENTITY_UNKNOWN'});
  assert.equal(checks,1);assert.equal(f.calls.length,0);
});

test('cancellation arriving during process verification prevents the inference HTTP request',async t=>{
  const f=await fixture(t),cancel=new AbortController();
  f.client.verifyIdentity=async()=>{cancel.abort(new Error('cancelled during verification'));return {started:good().started};};
  await assert.rejects(f.client.forward({messages:[]},{signal:cancel.signal}),/cancelled during verification/);
  assert.equal(f.calls.length,0);
});

test('a new client exposes its persisted verifier identity even before gate recovery performs observations',()=>{
  const prior={started:1793384581,pid:100,instanceId:'previous'};
  const verify=async()=>prior;verify.identity=()=>structuredClone(prior);
  const client=new StrataClient({baseUrl:'http://127.0.0.1:8190',verifyIdentity:verify});
  assert.deepEqual(client.identity,prior);client.identity.pid=999;assert.equal(client.currentIdentity.pid,100);
});
