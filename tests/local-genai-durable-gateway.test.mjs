import test from 'node:test';
import assert from 'node:assert/strict';
import {createGateway} from '../apps/dsh-plugins/local-genai/gateway.mjs';
import {controllerSessionId} from '../apps/dsh-plugins/shared/controller-session.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

for(const mode of ['web','desktop'])test(`${mode} gateway retains only the admitted scope and never leaks it to another provider`,async()=>{
 const hooks=new Map(),ctx={on:(name,handler)=>hooks.set(name,handler)},started=[],ended=[];let nextId=0;
 const gateway=await createGateway(ctx,{runtimeRoot:process.cwd(),controllerSessionNamespace:mode},{loadConfiguration:async()=>({controllerUrl:'http://127.0.0.1:3090',token:'synthetic'}),loadDshLlmBindings:async()=>({LlmError:class extends Error{},IMAGE_OFFLOAD_REQUIRED_CODE:'fixture'}),randomUUID:()=>String(++nextId),fetch:async(url,options)=>{
  const data=JSON.parse(options.body);if(url.endsWith('/start')){const scope={id:'scope-'+data.requestId,sessionId:options.headers['X-DSH-Session']};started.push(scope);return Response.json({scope});}
  ended.push(data.id);return new Response(null,{status:204});
 }});
 const header=hooks.get('llm-pi-ai/request-headers'),request=sessionId=>({provider:'local-strata',model:'strata-core',baseURL:'http://127.0.0.1:3090/v1',sessionId}),call=r=>header(r,new Headers(),()=>new Headers());
 assert.throws(()=>call(request('first')),/scope could not be verified/);
 const release=deferred(),entered=deferred();
 const a=gateway.stream({provider:'local-strata',model:'strata-core',sessionId:'first'},()=> (async function*(){const h=call(request('first'));assert.equal(h.get('x-dsh-session'),controllerSessionId('first',mode));assert.equal(h.get('x-dsh-scope'),'scope-1');assert.throws(()=>call(request('second')),/scope could not be verified/);assert.throws(()=>call({...request('first'),baseURL:'https://example.invalid/v1'}),/scope could not be verified/);const foreign=call({provider:'other',baseURL:'https://example.invalid/v1'});assert.equal(foreign.has('x-dsh-session'),false);assert.equal(foreign.has('x-dsh-scope'),false);entered.resolve();await release.promise;yield 'a';})());
 const b=gateway.stream({provider:'local-strata',model:'strata-core',sessionId:'second'},()=> (async function*(){const h=call(request('second'));assert.equal(h.get('x-dsh-session'),controllerSessionId('second',mode));assert.equal(h.get('x-dsh-scope'),'scope-2');yield 'b';})());
 try{const first=a.next();await entered.promise;const second=b.next();assert.equal(started.length,1);release.resolve();assert.equal((await first).value,'a');await a.return();assert.equal((await second).value,'b');await b.return();assert.deepEqual(ended,['scope-1','scope-2']);assert.throws(()=>call(request('second')),/scope could not be verified/);}finally{release.resolve();await a.return();await b.return();await gateway.dispose();}
});

test('a refused Controller connection allows a later explicit request after startup', async t => {
  let calls = 0;
  const gateway = await createGateway({on(){}}, {runtimeRoot:process.cwd()}, {
    loadConfiguration:async()=>({controllerUrl:'http://127.0.0.1:3090',token:'synthetic'}),
    loadDshLlmBindings:async()=>({LlmError:class extends Error{},IMAGE_OFFLOAD_REQUIRED_CODE:'fixture'}),
    fetch:async(url,options)=>{
      if (++calls === 1) throw new TypeError('fetch failed',{cause:{code:'ECONNREFUSED'}});
      if (url.endsWith('/start')) return Response.json({scope:{id:'fixture-scope',sessionId:options.headers['X-DSH-Session']}});
      return new Response(null,{status:204});
    },
  });
  t.after(()=>gateway.dispose());
  const request=()=>gateway.stream({provider:'local-strata',model:'strata-core',sessionId:'fixture'},async function*(){yield 'ready';});
  await assert.rejects(request().next(),error=>error.uncertain===false&&/Controller is stopped/.test(error.message));
  assert.equal(calls,1);
  const retry=request();
  assert.equal((await retry.next()).value,'ready');
  await retry.return();
  assert.equal(calls,3);
});
