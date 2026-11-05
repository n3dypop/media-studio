// Both workers load the same approved proposal. All network callbacks are fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,lstatSync,readdirSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {RunStore} from '../apps/controller/store.mjs';
import {SearchService} from '../apps/controller/search/service.mjs';

test('two independent processes cannot send one approved search twice',{timeout:15000},async t=>{
  const base=resolve(tmpdir()),root=mkdtempSync(join(base,'search-cross-process-')),path=join(root,'controller.sqlite'),store=new RunStore(path),sessionId='owner';
  const setup=new SearchService({root,store,fetchImpl:()=>{throw Error('parent must never send');}});setup.registerUserTurn(sessionId,1);
  const proposal=setup.propose({sessionId,turn:1,queries:['approved fixture'],purpose:'fixture',requestId:randomUUID(),requestPayloadHash:'a'.repeat(64)});
  setup.approve(proposal.id,{queries:['approved fixture'],engine:'duckduckgo',actor:'user',proposalHash:proposal.proposalHash});store.close();
  t.after(()=>{assert.ok(resolve(root).startsWith(base+sep));const visit=p=>{const s=lstatSync(p);assert.equal(s.isSymbolicLink(),false);if(s.isDirectory())for(const n of readdirSync(p))visit(join(p,n));else assert.equal(s.isFile(),true);};visit(root);rmSync(root,{recursive:true});});
  const script=`import {RunStore} from ${JSON.stringify(pathToFileURL(resolve('apps/controller/store.mjs')).href)};import {SearchService} from ${JSON.stringify(pathToFileURL(resolve('apps/controller/search/service.mjs')).href)};const f=JSON.parse(process.env.SEARCH_CROSS_FIXTURE),s=new RunStore(f.path),search=new SearchService({root:f.root,store:s,fetchImpl:async url=>{process.send({type:'send',query:new URL(url).searchParams.get('q')});return new Response(JSON.stringify({results:[]}),{headers:{'Content-Type':'application/json'}});}});process.send({type:'ready'});process.once('message',async()=>{try{await search.run(f.id,{sessionId:'owner'});process.send({type:'finished'});}catch(error){process.send({type:'refused',code:error.code??'unknown'});}finally{s.close();process.disconnect();}});`;
  const received=[],children=[];
  const start=()=>{const child=spawn(process.execPath,['--input-type=module','-e',script],{windowsHide:true,env:{...process.env,SEARCH_CROSS_FIXTURE:JSON.stringify({path,root,id:proposal.id})},stdio:['ignore','pipe','pipe','ipc']});children.push(child);let stderr='';child.stderr.on('data',b=>stderr+=b);const ready=new Promise((done,fail)=>{child.on('message',m=>{received.push(m);if(m.type==='ready')done();});child.once('error',fail);child.once('exit',code=>{if(code!==0)fail(Error(stderr||`child exit ${code}`));});});const exited=new Promise((done,fail)=>{child.once('error',fail);child.once('exit',code=>code===0?done():fail(Error(stderr||`child exit ${code}`)));});return {child,ready,exited};};
  const a=start(),b=start();try{await Promise.all([a.ready,b.ready]);a.child.send('go');b.child.send('go');await Promise.all([a.exited,b.exited]);}finally{for(const child of children)if(child.exitCode===null)child.kill();}
  const sends=received.filter(x=>x.type==='send');assert.ok(sends.every(x=>x.query==='approved fixture'));assert.equal(sends.length,1,`approved query reached fake callbacks ${sends.length} times`);
});
