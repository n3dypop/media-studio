import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {loadSearchConfiguration} from '../apps/controller/search/config.mjs';
import {SearchService} from '../apps/controller/search/service.mjs';
import {RunStore} from '../apps/controller/store.mjs';
import {ProductionStore} from '../apps/controller/productions.mjs';
import {createControllerServer} from '../apps/controller/http.mjs';
import {actionsHandler,ACTIONS_PATH} from '../apps/dsh-plugins/studio-controls/actions.mjs';

const disposers=new Map();
function directory(t){
  const base=resolve(tmpdir()),root=mkdtempSync(join(base,'media-optional-search-'));
  mkdirSync(join(root,'config'));
  t.after(async()=>{await disposers.get(root)?.();disposers.delete(root);const absolute=resolve(root);assert.ok(absolute.startsWith(base+sep)&&absolute!==base);const visit=path=>{const s=lstatSync(path);assert.ok(!s.isSymbolicLink());if(s.isDirectory())for(const name of readdirSync(path))visit(join(path,name));};visit(absolute);rmSync(absolute,{recursive:true,force:true});});
  return root;
}
const json=(root,value)=>writeFileSync(join(root,'config/rustxng.json'),JSON.stringify(value));

test('missing or explicitly disabled search is optional; malformed enabled config is not silently disabled',t=>{
  const root=directory(t);assert.equal(loadSearchConfiguration(root).enabled,false);
  json(root,{enabled:false});assert.equal(loadSearchConfiguration(root).enabled,false);
  json(root,{baseUrl:'http://127.0.0.1:29483'});assert.equal(loadSearchConfiguration(root).enabled,true);
  json(root,{enabled:true,baseUrl:'http://127.0.0.1:29483'});assert.equal(loadSearchConfiguration(root).enabled,true);
  for(const bad of [{enabled:'true'},null,[],{enabled:true},{baseUrl:'https://example.invalid'},{}]){json(root,bad);assert.throws(()=>loadSearchConfiguration(root));}
  writeFileSync(join(root,'config/rustxng.json'),'{bad');assert.throws(()=>loadSearchConfiguration(root));
});

test('disabled search keeps owned history, turn registration and cancellation but cannot submit externally',async t=>{
  const root=directory(t);let requests=0;
  const enabled=new SearchService({root,fetchImpl:async()=>{requests++;return Response.json({results:[]});}});
  enabled.registerUserTurn('session-A',1);
  const pending=enabled.propose({sessionId:'session-A',turn:1,queries:['fixture'],purpose:'test'});
  const approved=enabled.propose({sessionId:'session-A',turn:1,queries:['fixture2'],purpose:'test'});
  enabled.approve(approved.id,{queries:approved.queries,engine:approved.engine,actor:'user',proposalHash:approved.proposalHash});
  const disabled=new SearchService({root,enabled:false,fetchImpl:async()=>{requests++;throw Error('unexpected outbound request');}});
  assert.equal(disabled.list({sessionId:'session-A'}).length,2);
  disabled.registerUserTurn('session-A',2);
  assert.throws(()=>disabled.propose({sessionId:'session-A',turn:2,queries:['never sent'],purpose:'test'}),{code:'SEARCH_DISABLED'});
  assert.throws(()=>disabled.approve(pending.id,{queries:pending.queries,engine:pending.engine,actor:'user'}),{code:'SEARCH_DISABLED'});
  await assert.rejects(disabled.run(approved.id,{sessionId:'session-A'}),{code:'SEARCH_DISABLED'});
  assert.equal(disabled.status(approved.id).phase,'approved');assert.equal(requests,0);
  const cancelled=disabled.cancelSession('session-A',2);assert.equal(cancelled.length,2);assert.ok(cancelled.every(p=>p.phase==='cancelled'));
  const restored=new SearchService({root,enabled:true});assert.equal(restored.list({sessionId:'session-A'}).length,2);assert.equal(requests,0);
});

test('real Controller HTTP keeps inference and production admission working while disabled search cannot be approved or run',async t=>{
  const root=directory(t),store=new RunStore(join(root,'controller.db')),productions=new ProductionStore(store,{defaultModelProfile:'moss-image-sft-int8-v1'});
  const search=new SearchService({root,enabled:false,fetchImpl:async()=>{throw Error('outbound forbidden');}});
  const reservation=createServer();await new Promise(ok=>reservation.listen(0,'127.0.0.1',ok));const port=reservation.address().port;await new Promise(ok=>reservation.close(ok));
  const workflows={catalog:async()=>({modelProfiles:[{id:'moss-image-sft-int8-v1',available:true}],capabilities:[{modelProfile:'moss-image-sft-int8-v1',mode:'t2i'}]})};
  const controller=createControllerServer({store,productions,search,workflows,engine:{work:new Set(),launch(){}},token:'admin',dshToken:'agent',port,profile:'moss-image-sft-int8-v1'});
  await new Promise((ok,fail)=>controller.once('error',fail).listen(port,'127.0.0.1',ok));
  disposers.set(root,async()=>{controller.closeAllConnections();await new Promise(ok=>controller.close(ok));store.close();});
  const origin=`http://127.0.0.1:${port}`,request=async(path,{role='agent',method='GET',value}={})=>{
    const response=await fetch(origin+path,{method,headers:{Authorization:`Bearer ${role}`,'X-DSH-Session':'session-A',...(value?{'Content-Type':'application/json'}:{})},...(value?{body:JSON.stringify(value)}:{})});return {status:response.status,value:await response.json()};
  };
  let result=await request('/api/status');assert.equal(result.status,200);assert.equal(result.value.search.enabled,false);
  result=await request('/api/search-proposals/user-turn',{method:'POST',value:{turn:1}});assert.equal(result.status,200);
  result=await request('/api/core-scope/start',{method:'POST',value:{requestId:'fixture-request-0001'}});assert.equal(result.status,201);const scope=result.value.scope;
  result=await request('/api/core-scope/end',{method:'POST',value:{id:scope.id}});assert.equal(result.status,200);
  result=await request('/api/productions',{method:'POST',value:{requestId:randomUUID(),brief:{request:'Fixture portrait',criteria:[{id:'C1',description:'Subject'}],invariants:[],modelProfile:'moss-image-sft-int8-v1',mode:'t2i'}}});assert.equal(result.status,201);
  result=await request('/api/search-proposals',{method:'POST',value:{queries:['fixture'],purpose:'test',turn:1}});assert.equal(result.status,503);assert.match(result.value.error,/資料検索/);
  result=await request('/api/search-proposals');assert.equal(result.status,200);assert.equal(result.value.enabled,false);
  const disabledView=actionsHandler({sessionQuery:{observeSession:async()=>({events:[],[Symbol.dispose](){}})},dshOrigin:'http://127.0.0.1:3080',controllerRequest:async()=>({proposal:{id:randomUUID(),sessionId:'session-A'},enabled:false})});
  const req=new Request('http://127.0.0.1:3080'+ACTIONS_PATH+'?'+new URLSearchParams({sessionId:'session-A',proposalId:randomUUID()}));
  result=await disabledView(req);assert.equal(result.status,200);assert.equal((await result.json()).searchEnabled,false);
});
