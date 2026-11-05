import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createGateway} from '../apps/dsh-plugins/local-genai/gateway.mjs';
import {installRoleRestriction} from '../apps/dsh-plugins/local-genai/role-scope.mjs';
import {searchOpenKey,searchOpenRequestMac} from '../apps/controller/search/open-handshake-codec.mjs';
import {requireSearchOwnerStatus} from '../apps/dsh-plugins/local-genai/search-owner-status.mjs';

test('candidate gateway denies the open challenge immediately on stop',async()=>{
 const root=await mkdtemp(join(tmpdir(),'search-open-integration-'));await mkdir(join(root,'config'));await writeFile(join(root,'config/controller.json'),JSON.stringify({nativeProbe:{}}));
 const hooks=new Map(),ownerScope={},token='x'.repeat(64),ctx={sessions:{},sessionPersistence:{},agents:{get:()=>null},on:(name,fn)=>{hooks.set(name,fn);return()=>hooks.delete(name);},effect:fn=>fn()};
 const agent={id:'synthetic',ctx:{scope:ownerScope,tools:{restrict:()=>()=>{}}},session:{id:'synthetic',snapshotEvents:()=>[{type:'turn/start',data:{turn:1}}]},options:{provider:'other',model:'other'}};
 const release=installRoleRestriction(ctx,{scopeOf:value=>value===ctx?ownerScope:value.scope,scopeChainOf:scope=>[scope],allowedTools:['fixture']});hooks.get('agent/created')({agent});let registered,stopWritten=0;
 const gateway=await createGateway(ctx,{runtimeRoot:root,controllerSessionNamespace:'web'},{loadConfiguration:async()=>({controllerUrl:'http://127.0.0.1:3090',token}),loadDshLlmBindings:async()=>({LlmError:class extends Error{},IMAGE_OFFLOAD_REQUIRED_CODE:'fixture'}),observeOwnHostBirth:async()=>({pid:process.pid,start_time_utc_ticks:'638000000000000000',executable:process.execPath}),pinTurnOwnerDatabase:()=>({activate(){},needsLegacyAttestation(){return false;},async begin(){},async complete(){}}),pinSearchStopDatabase:()=>({stop(){stopWritten++;}}),fetch:async(url,options)=>{const body=JSON.parse(options.body),sessionId=options.headers['X-DSH-Session'];if(url.endsWith('/gateway-register')){registered=body;return Response.json({sessionId,hostId:body.hostId,registered:true});}if(url.endsWith('/user-turn'))return Response.json({sessionId,turn:body.turn});if(url.endsWith('/cancel-turn'))return new Response(null,{status:204});throw Error('Unexpected request');}});
 try{const abort=new AbortController(),step=hooks.get('agent/pre-step');await step({agent,turn:1,step:1,messages:[{source:{kind:'user'}}],signal:abort.signal},async()=>{});assert.ok(registered?.port);agent.options={provider:'local-strata',model:'strata-core'};await step({agent,turn:1,step:2,messages:[],signal:abort.signal},async()=>{});
  async function check(){const payload={v:1,sessionId:'synthetic',turn:1,hostId:registered.hostId,operation:'fetch',proposalId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',challenge:randomBytes(32).toString('hex')},requestMac=searchOpenRequestMac(searchOpenKey(token,registered.hostId),payload);return fetch('http://127.0.0.1:'+registered.port+'/open-check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,requestMac})});}
  assert.equal((await check()).status,200);hooks.get('session/event')(agent.session,{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}});for(let n=0;n<20;n++){await new Promise(resolve=>setImmediate(resolve));if((await check()).status===200)break;}assert.throws(()=>requireSearchOwnerStatus('synthetic',1),/unresolved/);assert.equal((await check()).status,200,'Normal durable completion keeps the exact approval open');abort.abort();assert.equal((await check()).status,403);assert.equal(stopWritten,1);
 }finally{await gateway.dispose();release();await rm(root,{recursive:true,force:true});}
});
