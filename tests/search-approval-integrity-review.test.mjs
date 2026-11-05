// Isolated negative cases. All outbound operations use injected fake callbacks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,lstatSync,readdirSync,readFileSync,writeFileSync,renameSync,linkSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {RunStore} from '../apps/controller/store.mjs';
import {SearchService} from '../apps/controller/search/service.mjs';

function fixture(t){
  const base=resolve(tmpdir()),root=mkdtempSync(join(base,'search-approval-integrity-')),store=new RunStore(':memory:'),sent=[],approvedUrl='https://example.org/approved',otherUrl='https://example.org/unapproved';
  const callbacks={fetchImpl:async url=>{sent.push({kind:'query',value:new URL(url).searchParams.get('q')});return new Response(JSON.stringify({results:[{url:approvedUrl,title:'fixture',content:'fixture',engine:'duckduckgo',engines:['duckduckgo']}]}),{headers:{'Content-Type':'application/json'}});},pageReader:async url=>{sent.push({kind:'page',value:url});return {url,title:'fixture',content:'fixture'};}};
  const make=()=>new SearchService({root,store,...callbacks});let search=make();search.registerUserTurn('owner',1);
  t.after(()=>{store.close();assert.ok(resolve(root).startsWith(base+sep));const visit=p=>{const s=lstatSync(p);assert.equal(s.isSymbolicLink(),false);if(s.isDirectory())for(const n of readdirSync(p))visit(join(p,n));else assert.equal(s.isFile(),true);};visit(root);rmSync(root,{recursive:true});});
  return {root,store,sent,approvedUrl,otherUrl,make,get search(){return search;},set search(s){search=s;}};
}

for(const kind of ['query','page'])for(const boundary of ['before-approval','after-approval-restart','immediately-before-run'])test(`${kind}: altered send target is rejected at ${boundary}`,async t=>{
  const f=fixture(t),sessionId='owner';let proposal;
  if(kind==='query')proposal=f.search.propose({sessionId,turn:1,queries:['approved-query'],purpose:'fixture',requestId:randomUUID(),requestPayloadHash:'a'.repeat(64)});
  else {
    const source=f.search.propose({sessionId,turn:1,queries:['source-query'],purpose:'fixture',requestId:randomUUID(),requestPayloadHash:'b'.repeat(64)});
    f.search.approve(source.id,{queries:['source-query'],engine:'duckduckgo',actor:'user',proposalHash:source.proposalHash});await f.search.run(source.id,{sessionId});
    proposal=f.search.proposePageReads({sessionId,turn:1,sourceProposalId:source.id,urls:[f.approvedUrl],purpose:'fixture',requestId:randomUUID(),requestPayloadHash:'c'.repeat(64)});
  }
  const changed=kind==='query'?'different-query':f.otherUrl,key=kind==='query'?'query':'url';
  const approve=()=>f.search.approve(proposal.id,{...(kind==='query'?{queries:['approved-query']}:{urls:[f.approvedUrl]}),engine:kind==='query'?'duckduckgo':'website-fetch',actor:'user',proposalHash:proposal.proposalHash});
  const alterFile=()=>{const file=join(f.root,'data','search',proposal.id+'.json'),row=JSON.parse(readFileSync(file,'utf8'));row.items[0][key]=changed;writeFileSync(file,JSON.stringify(row));};
  try{
    if(boundary==='before-approval'){alterFile();f.search=f.make();approve();}
    else if(boundary==='after-approval-restart'){approve();alterFile();f.search=f.make();}
    else {approve();f.search.records.get(proposal.id).items[0][key]=changed;}
    await f.search.run(proposal.id,{sessionId});
  }catch{/* A refusal before any unapproved send is safe. */}
  assert.equal(f.sent.some(x=>x.kind===kind&&x.value===changed),false,'an unapproved target reached the fake outbound callback');
});

test('hard-linked proposal cannot be approved or sent',{timeout:10000},async t=>{
  const f=fixture(t),sessionId='owner',proposal=f.search.propose({sessionId,turn:1,queries:['approved-query'],purpose:'fixture',requestId:randomUUID(),requestPayloadHash:'a'.repeat(64)}),file=join(f.root,'data','search',proposal.id+'.json'),alias=join(f.root,'independent-hardlink-source');
  renameSync(file,alias);
  try{linkSync(alias,file);}catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip(`Hard links unavailable: ${error.code}`);return;}throw error;}
  assert.equal(lstatSync(file).nlink,2);
  try{const reopened=f.make();reopened.approve(proposal.id,{queries:['approved-query'],engine:'duckduckgo',actor:'user',proposalHash:proposal.proposalHash});await reopened.run(proposal.id,{sessionId});}catch{/* Refusing the unsafe link is the desired outcome. */}
  assert.equal(f.sent.length,0,'hard-linked proposal reached the fake outbound callback');
});
