import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGateway} from '../apps/dsh-plugins/local-genai/gateway.mjs';
import {requireSearchOwnerStatus} from '../apps/dsh-plugins/local-genai/search-owner-status.mjs';

test('unavailable owner probe blocks new search without blocking normal local conversation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'search-owner-gateway-')),hooks=new Map(),ctx={on:(name,handler)=>hooks.set(name,handler),sessions:{},sessionPersistence:{}},sent=[];
 const gateway=await createGateway(ctx,{runtimeRoot:root,controllerSessionNamespace:'web'},{loadConfiguration:async()=>({controllerUrl:'http://127.0.0.1:3090',token:'synthetic'}),loadDshLlmBindings:async()=>({LlmError:class extends Error{},IMAGE_OFFLOAD_REQUIRED_CODE:'fixture'}),fetch:async url=>{sent.push(url);throw Error('No HTTP expected');}});
 try{const session={id:'synthetic',snapshotEvents:()=>[{type:'turn/start',data:{turn:1}}]},agent={session,options:{provider:'local-strata',model:'strata-core'}},signal=new AbortController().signal;
  const result=await hooks.get('agent/pre-step')({agent,turn:1,step:1,messages:[{source:{kind:'user'}}],signal},async()=>42);assert.equal(result,42);assert.deepEqual(sent,[]);assert.throws(()=>requireSearchOwnerStatus('synthetic',1),/unresolved/);
 }finally{await gateway.dispose();await rm(root,{recursive:true,force:true});}
});
test('unmatched preset does not register a search turn even for a managed model',async()=>{
 const root=await mkdtemp(join(tmpdir(),'search-owner-late-route-')),hooks=new Map(),ctx={on:(name,handler)=>hooks.set(name,handler)},sent=[];
 const gateway=await createGateway(ctx,{runtimeRoot:root,controllerSessionNamespace:'web'},{loadConfiguration:async()=>({controllerUrl:'http://127.0.0.1:3090',token:'synthetic'}),loadDshLlmBindings:async()=>({LlmError:class extends Error{},IMAGE_OFFLOAD_REQUIRED_CODE:'fixture'}),fetch:async(url,options)=>{sent.push({url,body:JSON.parse(options.body)});return Response.json({sessionId:'synthetic',turn:1});}});
 try{const session={id:'synthetic',snapshotEvents:()=>[{type:'turn/start',data:{turn:1}}]},agent={session,options:{provider:'other',model:'other'}},signal=new AbortController().signal,hook=hooks.get('agent/pre-step');
  assert.equal(await hook({agent,turn:1,step:1,messages:[{source:{kind:'user'}}],signal},async()=>1),1);assert.equal(sent.length,0);agent.options={provider:'local-strata',model:'strata-core'};
  assert.equal(await hook({agent,turn:1,step:2,messages:[],signal},async()=>2),2);assert.equal(await hook({agent,turn:1,step:3,messages:[],signal},async()=>3),3);assert.equal(sent.length,0);
 }finally{await gateway.dispose();await rm(root,{recursive:true,force:true});}
});
test('failure to install the turn-end hook keeps search closed and local work available',async()=>{
 const root=await mkdtemp(join(tmpdir(),'search-owner-hook-failure-'));await mkdir(join(root,'config'));await writeFile(join(root,'config/controller.json'),JSON.stringify({nativeProbe:{}}));const hooks=new Map(),sent=[],ctx={on:(name,fn)=>{if(name==='session/event')throw Error('fixture hook failure');hooks.set(name,fn);},sessions:{},sessionPersistence:{}};
 const gateway=await createGateway(ctx,{runtimeRoot:root},{loadConfiguration:async()=>({controllerUrl:'http://127.0.0.1:3090',token:'x'.repeat(64)}),loadDshLlmBindings:async()=>({LlmError:class extends Error{},IMAGE_OFFLOAD_REQUIRED_CODE:'fixture'}),isManagedAgent:()=>true,observeOwnHostBirth:async()=>({pid:process.pid,start_time_utc_ticks:'638000000000000000',executable:process.execPath}),pinTurnOwnerDatabase:()=>({activate(){},needsLegacyAttestation(){return false;},async begin(){},async complete(){}}),fetch:async url=>{sent.push(url);throw Error('No HTTP expected');}});
 try{const session={id:'synthetic',snapshotEvents:()=>[{type:'turn/start',data:{turn:1}}]},agent={session,options:{provider:'local-strata',model:'strata-core'}},signal=new AbortController().signal;assert.equal(await hooks.get('agent/pre-step')({agent,turn:1,step:1,messages:[{source:{kind:'user'}}],signal},async()=>42),42);assert.deepEqual(sent,[]);assert.throws(()=>requireSearchOwnerStatus('synthetic',1),/unresolved/);}finally{await gateway.dispose();await rm(root,{recursive:true,force:true});}
});
