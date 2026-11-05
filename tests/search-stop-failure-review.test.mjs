import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,lstatSync,readdirSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {RunStore} from '../apps/controller/store.mjs';
import {SearchService} from '../apps/controller/search/service.mjs';
import {pinSearchStopDatabase} from '../apps/dsh-plugins/local-genai/search-stop-db.mjs';
import {createGateway} from '../apps/dsh-plugins/local-genai/gateway.mjs';

function fixture(t){
 const base=resolve(tmpdir()),root=mkdtempSync(join(base,'search-stop-failure-'));
 mkdirSync(join(root,'data/controller'),{recursive:true});
 const store=new RunStore(join(root,'data/controller/controller.db'));
 t.after(()=>{store.close();assert.ok(resolve(root).startsWith(base+sep));const visit=p=>{const s=lstatSync(p);assert.equal(s.isSymbolicLink(),false);if(s.isDirectory())for(const n of readdirSync(p))visit(join(p,n));else assert.equal(s.isFile(),true);};visit(root);rmSync(root,{recursive:true});});
 return {root,store};
}

test('an unavailable stop database and HTTP cancellation cannot be reported as normal completion',async t=>{
 const {root,store}=fixture(t),search=new SearchService({root,store}),hooks=new Map();let entered,release;
 const gateway=await createGateway({on:(name,fn)=>hooks.set(name,fn)},{runtimeRoot:root},{
  loadConfiguration:async()=>({controllerUrl:'http://127.0.0.1:3090',token:'x'.repeat(64)}),
  loadDshLlmBindings:async()=>({LlmError:class extends Error{},IMAGE_OFFLOAD_REQUIRED_CODE:'fixture'}),
  isManagedAgent:()=>true,createOwnerContext:async()=>({birth:{},owner:{activate(){},needsLegacyAttestation(){return false;},async begin(){},async complete(){}}}),
  pinSearchStopDatabase:()=>({stop(){throw Error('synthetic stop database failure');}}),
  fetch:async(url,options)=>{if(url.endsWith('/gateway-register'))return Response.json({sessionId:'owned',hostId:JSON.parse(options.body).hostId,registered:true});if(url.endsWith('/user-turn')){search.registerUserTurn('owned',1);return Response.json({sessionId:'owned',turn:1});}if(url.endsWith('/cancel-turn'))throw Error('synthetic HTTP failure');throw Error('unexpected network call');},
 });
 t.after(()=>gateway.dispose());
 const abort=new AbortController(),agent={options:{provider:'local-strata',model:'strata-core'},session:{id:'owned',snapshotEvents:()=>[{type:'turn/start',data:{turn:1}}]}};
 const enteredNext=new Promise(resolve=>{entered=resolve;}),next=new Promise(resolve=>{release=resolve;});
 const run=hooks.get('agent/pre-step')({agent,turn:1,step:1,messages:[{source:{kind:'user'}}],signal:abort.signal},()=>{entered();return next;});
 await enteredNext;abort.abort(Error('synthetic user stop'));release('normal completion');
 await assert.rejects(run,/stop|cancel|abort|durab/i,'an unconfirmed stop must not return normal completion');
});

test('a new user turn cannot resurrect an approved search from a previously stopped turn',async t=>{
 const {root,store}=fixture(t),sent=[];
 const search=new SearchService({root,store,fetchImpl:async url=>{sent.push(new URL(url).searchParams.get('q'));return Response.json({results:[]});}});
 search.registerUserTurn('owned',1);
 const p=search.propose({sessionId:'owned',turn:1,queries:['old approved target'],purpose:'fixture',requestId:randomUUID(),requestPayloadHash:'a'.repeat(64)});
 search.approve(p.id,{queries:['old approved target'],engine:'duckduckgo',actor:'user',proposalHash:p.proposalHash});
 assert.equal(pinSearchStopDatabase(root).stop('owned',1),'stopped');
 search.registerUserTurn('owned',2);
 try{await search.run(p.id,{sessionId:'owned'});}catch{/* Rejection is safe. */}
 assert.deepEqual(sent,[],'an old stopped turn must not be sent after a newer turn begins');
});
