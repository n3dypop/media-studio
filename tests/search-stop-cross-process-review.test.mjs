// A separately received user stop must be observed before the fake outbound call.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,lstatSync,readdirSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {RunStore} from '../apps/controller/store.mjs';
import {SearchService} from '../apps/controller/search/service.mjs';

test('a separately committed same-turn stop before outbound I/O prevents the fake send',{timeout:15000},async t=>{
  const base=resolve(tmpdir()),root=mkdtempSync(join(base,'search-stop-cross-process-')),path=join(root,'controller.sqlite'),store=new RunStore(path),sent=[];
  const search=new SearchService({root,store,fetchImpl:async url=>{sent.push(new URL(url).searchParams.get('q'));return new Response(JSON.stringify({results:[]}),{headers:{'Content-Type':'application/json'}});}});
  t.after(()=>{store.close();assert.ok(resolve(root).startsWith(base+sep));const visit=p=>{const s=lstatSync(p);assert.equal(s.isSymbolicLink(),false);if(s.isDirectory())for(const n of readdirSync(p))visit(join(p,n));else assert.equal(s.isFile(),true);};visit(root);rmSync(root,{recursive:true});});
  search.registerUserTurn('owner',1);
  const p=search.propose({sessionId:'owner',turn:1,queries:['approved fixture'],purpose:'fixture',requestId:randomUUID(),requestPayloadHash:'a'.repeat(64)});
  search.approve(p.id,{queries:['approved fixture'],engine:'duckduckgo',actor:'user',proposalHash:p.proposalHash});
  const original=search.claimItem.bind(search);let stopped=false;
  search.claimItem=(...args)=>{original(...args);const script=`import {RunStore} from ${JSON.stringify(pathToFileURL(resolve('apps/controller/store.mjs')).href)};import {SearchService} from ${JSON.stringify(pathToFileURL(resolve('apps/controller/search/service.mjs')).href)};const x=JSON.parse(process.env.SEARCH_STOP_FIXTURE),s=new RunStore(x.path);try{new SearchService({root:x.root,store:s}).cancelTurn('owner',1);console.log('stop-accepted');}finally{s.close();}`;const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',windowsHide:true,env:{...process.env,SEARCH_STOP_FIXTURE:JSON.stringify({root,path})}});assert.equal(child.status,0,child.stderr);assert.match(child.stdout,/stop-accepted/);stopped=true;};
  try{await search.run(p.id,{sessionId:'owner'});}catch{/* Refusal is safe. */}
  assert.equal(stopped,true);assert.deepEqual(sent,[],'an outbound callback occurred after the other process accepted the stop');
});
