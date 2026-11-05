import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,lstatSync,readdirSync,readFileSync,writeFileSync,linkSync,unlinkSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {RunStore} from '../apps/controller/store.mjs';
import {SearchService} from '../apps/controller/search/service.mjs';
import {searchRoute} from '../apps/controller/search-http.mjs';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function fixture(t,{disk=false}={}){
  const base=resolve(tmpdir()),root=mkdtempSync(join(base,'search-receipt-'));mkdirSync(join(root,'data'),{recursive:true});
  const path=disk?join(root,'controller.sqlite'):':memory:',store=new RunStore(path),search=new SearchService({root,store});search.registerUserTurn('owner',1);
  t.after(()=>{store.close();assert.ok(resolve(root).startsWith(base+sep));const visit=p=>{const s=lstatSync(p);assert.ok(!s.isSymbolicLink());if(s.isDirectory())for(const n of readdirSync(p))visit(join(p,n));};visit(root);rmSync(root,{recursive:true,force:true});});
  const input={kind:'queries',queries:['fixture query'],purpose:'fixture',turn:1,requestId:randomUUID()};return {root,path,store,search,input};
}
function propose(search,input,sessionId='owner'){return search.propose({sessionId,queries:input.queries,purpose:input.purpose,turn:input.turn,requestId:input.requestId,requestPayloadHash:digest(input)});}

test('search receipt binds owned exact input and identical replay makes no duplicate proposal',t=>{
  const {search,input}=fixture(t),first=propose(search,input),found=search.findProposalByRequest('owner',input.requestId);
  assert.equal(found.receipt.state,'committed');assert.equal(found.receipt.payloadHash,digest(input));assert.equal(found.proposal.id,first.id);
  assert.equal(propose(search,input).id,first.id);assert.equal(search.list({sessionId:'owner'}).length,1);
  assert.throws(()=>propose(search,{...input,purpose:'different'}),e=>e.status===503);
  assert.throws(()=>search.findProposalByRequest('foreign',input.requestId),e=>e.status===404);
  assert.throws(()=>search.findProposalByRequest('owner',randomUUID()),e=>e.status===404&&/absence/i.test(e.message));
});

test('a stale instance loads an independently committed proposal before status and approval',t=>{
  const {root,store,search,input}=fixture(t),stale=new SearchService({root,store}),first=propose(search,input);
  assert.throws(()=>stale.status(first.id),e=>e.status===404);
  const found=stale.findProposalByRequest('owner',input.requestId);assert.equal(found.proposal.id,first.id);assert.equal(stale.status(first.id).id,first.id);
  assert.equal(stale.approve(first.id,{queries:first.queries,engine:first.engine,actor:'user',proposalHash:first.proposalHash}).phase,'approved');
});

test('completed schema-1 query and page histories without request IDs remain readable without network',t=>{
  const {root,store}=fixture(t),directory=join(root,'data','search');let outbound=0;
  const query={kind:'queries',productionId:null,sessionId:'owner',queries:['historical query'],engine:'duckduckgo',purpose:'historical query'},queryId=randomUUID(),queryHash=digest(query),url='https://example.com/historical';
  const search={schema:1,id:queryId,...query,proposalHash:queryHash,phase:'completed',createdAt:'2026-11-02T00:00:00.000Z',updatedAt:'2026-11-02T00:00:01.000Z',approval:{actor:'user',proposalHash:queryHash,queries:query.queries,engine:query.engine,pageReadsAllowed:false},items:[{query:query.queries[0],state:'completed',results:[{url}]}]};
  const page={kind:'pages',productionId:null,sessionId:'owner',sourceProposalId:queryId,urls:[url],engine:'website-fetch',purpose:'historical page'},pageId=randomUUID(),pageHash=digest(page);
  const read={schema:1,id:pageId,...page,proposalHash:pageHash,phase:'completed',createdAt:'2026-11-02T00:00:00.000Z',updatedAt:'2026-11-02T00:00:01.000Z',approval:{actor:'user',proposalHash:pageHash,urls:page.urls,engine:page.engine,pageReadsAllowed:true},items:[{url,state:'completed',results:[]}]};
  writeFileSync(join(directory,queryId+'.json'),JSON.stringify(search));writeFileSync(join(directory,pageId+'.json'),JSON.stringify(read));
  const reopened=new SearchService({root,store,fetchImpl:()=>{outbound++;throw Error('unexpected network');},pageReader:()=>{outbound++;throw Error('unexpected network');}});
  assert.equal(reopened.status(queryId).phase,'completed');assert.equal(reopened.status(pageId).phase,'completed');assert.equal(reopened.list({sessionId:'owner'}).length,2);assert.equal(outbound,0);
});

test('after file-save error admission remains pending across restart and blocks both old and new calls',t=>{
  const {root,store,search,input}=fixture(t),original=search.save.bind(search);search.save=()=>{throw Error('injected filesystem failure');};
  assert.throws(()=>propose(search,input),e=>e.status===503&&e.code==='SEARCH_PROPOSAL_UNKNOWN');search.save=original;
  assert.equal(search.findProposalByRequest('owner',input.requestId).receipt.state,'started');
  assert.throws(()=>propose(search,input),e=>e.status===503&&e.code==='REQUEST_UNKNOWN');
  assert.throws(()=>propose(search,{...input,purpose:'different'}),e=>e.status===503&&e.code==='REQUEST_UNKNOWN');
  assert.throws(()=>propose(search,{...input,requestId:randomUUID()}),e=>e.status===409);
  assert.throws(()=>search.propose({sessionId:'owner',queries:['legacy'],purpose:'fixture',turn:1}),e=>e.status===409);
  const reopened=new SearchService({root,store});assert.equal(reopened.findProposalByRequest('owner',input.requestId).receipt.state,'started');
});

test('an uncommitted saved file remains hidden and cannot be approved or transmitted',t=>{
  const {root,store,search,input}=fixture(t),transaction=store.transaction.bind(store);let count=0;
  store.transaction=fn=>{if(++count===3)throw Error('injected commit failure');return transaction(fn);};
  assert.throws(()=>propose(search,input),e=>e.status===503);store.transaction=transaction;
  const receipt=search.findProposalByRequest('owner',input.requestId).receipt;assert.equal(receipt.state,'started');
  assert.equal(search.list({sessionId:'owner'}).length,0);assert.throws(()=>search.status(receipt.proposalId),e=>e.status===409);
  const reopened=new SearchService({root,store});assert.equal(reopened.list({sessionId:'owner'}).length,0);assert.throws(()=>reopened.approve(receipt.proposalId,{actor:'user'}),e=>e.status===409);
});

test('admin recovery abandons only the exact pending proposal and prevents late file from becoming actionable',t=>{
  const {store,search,input}=fixture(t),save=search.save.bind(search);let evidence;
  search.save=record=>{
    const {receipt}=search.findProposalByRequest('owner',input.requestId);evidence={sessionId:'owner',requestId:input.requestId,payloadHash:receipt.payloadHash,proposalId:receipt.proposalId,proposalHash:receipt.proposalHash};
    assert.throws(()=>search.abandonProposal({...evidence,payloadHash:'f'.repeat(64)}),e=>e.status===409);
    assert.equal(search.abandonProposal(evidence).created,true);
    save(record);
  };
  assert.throws(()=>propose(search,input),e=>e.status===503);search.save=save;
  const abandoned=search.findProposalByRequest('owner',input.requestId).receipt;assert.equal(abandoned.state,'abandoned');assert.equal(new Date(abandoned.createdAt).toISOString(),abandoned.createdAt);
  assert.equal(search.abandonProposal(evidence).created,false);assert.equal(search.list({sessionId:'owner'}).length,0);
  store.db.prepare('UPDATE search_proposal_abandons SET created_at=? WHERE session_id=? AND request_id=?').run('not-a-date','owner',input.requestId);
  assert.throws(()=>search.findProposalByRequest('owner',input.requestId),e=>e.code==='LEDGER_CORRUPT');
  assert.throws(()=>search.status(evidence.proposalId),e=>e.status===409);
  assert.equal(propose(search,{...input,requestId:randomUUID()}).phase,'awaiting_approval');
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM events WHERE type='search_proposal_abandoned'").get().n,1);
});

test('old turn proposals cannot be approved, claimed, or revived by changing the file',async t=>{
  const {root,store,search,input}=fixture(t),first=propose(search,input),second=propose(search,{...input,requestId:randomUUID()}),sent=[];
  search.fetchImpl=async url=>{sent.push(url);return Response.json({results:[]});};
  search.approve(first.id,{queries:first.queries,engine:first.engine,actor:'user',proposalHash:first.proposalHash});
  const runId=search.claimRun(search.records.get(first.id));
  store.db.prepare('UPDATE search_session_turns SET stopped_at=1 WHERE session_id=?').run('owner');search.registerUserTurn('owner',2);
  assert.throws(()=>search.approve(second.id,{queries:second.queries,engine:second.engine,actor:'user',proposalHash:second.proposalHash}),e=>e.code==='STALE_TURN');
  assert.throws(()=>search.claimItem(search.records.get(first.id),0,runId),e=>e.code==='STALE_TURN');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM search_item_claims').get().n,0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM search_approval_claims WHERE proposal_id=?').get(second.id).n,0);
  const path=join(root,'data','search',first.id+'.json'),record=JSON.parse(readFileSync(path,'utf8'));
  record.turn=2;record.turnHash=digest({proposalId:record.id,sessionId:record.sessionId,proposalHash:record.proposalHash,turn:record.turn});writeFileSync(path,JSON.stringify(record));
  const reopened=new SearchService({root,store,fetchImpl:search.fetchImpl});
  await assert.rejects(reopened.run(first.id,{sessionId:'owner'}),e=>e.code==='TURN_BINDING_UNKNOWN');assert.deepEqual(sent,[]);
});

test('legacy records without durable turn evidence remain readable but cannot be approved or dispatched',async t=>{
  const {root,store,search,input}=fixture(t),first=propose(search,input),second=propose(search,{...input,requestId:randomUUID()});let sent=0;
  search.approve(first.id,{queries:first.queries,engine:first.engine,actor:'user',proposalHash:first.proposalHash});
  for(const id of [first.id,second.id]){const path=join(root,'data','search',id+'.json'),record=JSON.parse(readFileSync(path,'utf8'));delete record.turn;delete record.turnHash;writeFileSync(path,JSON.stringify(record));}
  const reopened=new SearchService({root,store,fetchImpl:async()=>{sent++;return Response.json({results:[]});}});
  assert.equal(reopened.status(first.id,{sessionId:'owner'}).phase,'approved');assert.equal(reopened.status(second.id,{sessionId:'owner'}).phase,'awaiting_approval');
  await assert.rejects(reopened.run(first.id,{sessionId:'owner'}),e=>e.code==='STALE_TURN');
  assert.throws(()=>reopened.approve(second.id,{queries:second.queries,engine:second.engine,actor:'user',proposalHash:second.proposalHash}),e=>e.code==='STALE_TURN');assert.equal(sent,0);
});

test('a turn number without its independent SQLite binding is read-only',async t=>{
  const {store,search,input}=fixture(t),proposal=propose(search,input);let sent=0;
  search.fetchImpl=async()=>{sent++;return Response.json({results:[]});};
  store.db.prepare('DELETE FROM search_proposal_turn_bindings WHERE proposal_id=?').run(proposal.id);
  assert.equal(search.status(proposal.id,{sessionId:'owner'}).id,proposal.id);
  assert.throws(()=>search.approve(proposal.id,{queries:proposal.queries,engine:proposal.engine,actor:'user',proposalHash:proposal.proposalHash}),e=>e.code==='TURN_BINDING_UNKNOWN');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM search_approval_claims').get().n,0);assert.equal(sent,0);
});

test('turn change after committed approval claim is reported as unknown, not pre-admission rejection',t=>{
  const {store,search,input}=fixture(t),proposal=propose(search,input),transaction=store.transaction.bind(store);let injected=false;
  store.transaction=fn=>{const result=transaction(fn);if(!injected){injected=true;store.db.prepare('UPDATE search_session_turns SET latest=2, stopped_at=NULL WHERE session_id=?').run('owner');}return result;};
  assert.throws(()=>search.approve(proposal.id,{queries:proposal.queries,engine:proposal.engine,actor:'user',proposalHash:proposal.proposalHash}),e=>e.code==='APPROVAL_UNKNOWN'&&e.status===503);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM search_approval_claims WHERE proposal_id=?').get(proposal.id).n,1);
});

test('failed admin audit leaves search admission unresolved and committed receipts cannot be abandoned',t=>{
  const {store,search,input}=fixture(t),save=search.save.bind(search);search.save=()=>{throw Error('injected write failure');};assert.throws(()=>propose(search,input),e=>e.status===503);search.save=save;
  const {receipt}=search.findProposalByRequest('owner',input.requestId),evidence={sessionId:'owner',requestId:input.requestId,payloadHash:receipt.payloadHash,proposalId:receipt.proposalId,proposalHash:receipt.proposalHash};
  store.db.exec("CREATE TRIGGER reject_search_abandon BEFORE INSERT ON search_proposal_abandons BEGIN SELECT RAISE(ABORT,'injected audit failure'); END");
  assert.throws(()=>search.abandonProposal(evidence),/injected audit failure/);assert.equal(search.findProposalByRequest('owner',input.requestId).receipt.state,'started');
  store.db.exec('DROP TRIGGER reject_search_abandon');search.abandonProposal(evidence);
  const committed={...input,requestId:randomUUID()};propose(search,committed);const next=search.findProposalByRequest('owner',committed.requestId).receipt;
  assert.throws(()=>search.abandonProposal({sessionId:'owner',requestId:committed.requestId,payloadHash:next.payloadHash,proposalId:next.proposalId,proposalHash:next.proposalHash}),e=>e.status===409);
});

test('saved proposal tampering or missing files do not produce a receipt',t=>{
  const {root,search,input}=fixture(t),proposal=propose(search,input),path=join(root,'data','search',proposal.id+'.json'),bytes=readFileSync(path,'utf8'),row=JSON.parse(bytes);row.queries=['changed'];writeFileSync(path,JSON.stringify(row));
  assert.throws(()=>search.findProposalByRequest('owner',input.requestId),e=>e.status===503);writeFileSync(path,bytes);
});

test('hard-linked proposal ledger is never read, approved or sent',async t=>{
  const {root,store,search,input}=fixture(t),proposal=propose(search,input),path=join(root,'data','search',proposal.id+'.json'),alias=join(root,'linked-ledger.json');let requests=0;search.fetchImpl=async()=>{requests++;return Response.json({results:[]});};
  try{linkSync(path,alias);}catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip('This host cannot create a test hard link');return;}throw error;}
  assert.throws(()=>search.status(proposal.id),e=>e.status===503);assert.throws(()=>search.approve(proposal.id,{queries:proposal.queries,engine:proposal.engine,actor:'user'}),e=>e.status===503);
  assert.throws(()=>new SearchService({root,store}),e=>e.status===503);assert.throws(()=>search.findProposalByRequest('owner',input.requestId),e=>e.status===503);
  unlinkSync(alias);search.approve(proposal.id,{queries:proposal.queries,engine:proposal.engine,actor:'user'});linkSync(path,alias);
  await assert.rejects(search.run(proposal.id,{sessionId:'owner'}),e=>e.status===503);assert.equal(requests,0);unlinkSync(alias);
});

test('stale second instance cannot overwrite a prior approval or send a duplicate',async t=>{
  const {root,store,search,input}=fixture(t),proposal=propose(search,input),stale=new SearchService({root,store});let sends=0;
  search.fetchImpl=async()=>{sends++;return Response.json({results:[]});};stale.fetchImpl=search.fetchImpl;
  search.approve(proposal.id,{queries:proposal.queries,engine:proposal.engine,actor:'user',proposalHash:proposal.proposalHash});
  assert.throws(()=>stale.approve(proposal.id,{queries:proposal.queries,engine:proposal.engine,actor:'user',proposalHash:proposal.proposalHash}),e=>e.status===503&&e.code==='APPROVAL_UNKNOWN');
  const result=await search.run(proposal.id,{sessionId:'owner'});assert.equal(result.phase,'completed');assert.equal(sends,1);
  await assert.rejects(stale.run(proposal.id,{sessionId:'owner'}),e=>e.status===503||e.status===409);
});

test('item-claim persistence failure prevents outbound I/O and leaves the search unresolved',async t=>{
  const {store,search,input}=fixture(t),proposal=propose(search,input);let sends=0;search.fetchImpl=async()=>{sends++;return Response.json({results:[]});};
  search.approve(proposal.id,{queries:proposal.queries,engine:proposal.engine,actor:'user',proposalHash:proposal.proposalHash});
  store.db.exec("CREATE TRIGGER reject_search_item BEFORE INSERT ON search_item_claims BEGIN SELECT RAISE(ABORT,'injected item claim failure'); END");
  const result=await search.run(proposal.id,{sessionId:'owner'});assert.equal(result.phase,'needs_attention');assert.equal(sends,0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM search_run_claims').get().n,1);assert.equal(store.db.prepare('SELECT count(*) AS n FROM search_item_claims').get().n,0);
  await assert.rejects(search.run(proposal.id,{sessionId:'owner'}),e=>e.status===409||e.status===503);
});

test('stopping a session aborts active work even if its ledger was corrupted',async t=>{
  const {search,input}=fixture(t),proposal=propose(search,input);let entered,aborted=false;const ready=new Promise(resolve=>{entered=resolve;});
  search.fetchImpl=(_url,{signal})=>new Promise((_resolve,reject)=>{entered();signal.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'));},{once:true});});
  search.approve(proposal.id,{queries:proposal.queries,engine:proposal.engine,actor:'user',proposalHash:proposal.proposalHash});
  const work=search.run(proposal.id,{sessionId:'owner'});await ready;search.records.get(proposal.id).items[0].query='tampered';
  assert.throws(()=>search.cancelSession('owner',1),e=>e.status===503);await assert.rejects(work);assert.equal(aborted,true);
});

test('a stop arriving before its user-turn registration prevents late reopening',t=>{
  const {root,store,search}=fixture(t);search.cancelTurn('late-session',7);
  assert.throws(()=>search.registerUserTurn('late-session',7),e=>e.status===409&&e.code==='SESSION_STOPPED');
  const reopened=new SearchService({root,store});assert.throws(()=>reopened.registerUserTurn('late-session',7),e=>e.status===409&&e.code==='SESSION_STOPPED');
  reopened.registerUserTurn('late-session',8);assert.doesNotThrow(()=>reopened.propose({sessionId:'late-session',turn:8,queries:['after stop'],purpose:'fixture'}));
  assert.throws(()=>reopened.cancelTurn('late-session',7),e=>e.status===409&&e.code==='STALE_TURN');
});

test('separate Controller instances observe durable stops and reject delayed registration',t=>{
  const {root,path,store,search}=fixture(t,{disk:true}),otherStore=new RunStore(path);
  try{const other=new SearchService({root,store:otherStore});
    other.cancelTurn('owner',1);assert.throws(()=>search.registerUserTurn('owner',1),e=>e.status===409&&e.code==='SESSION_STOPPED');
    assert.throws(()=>propose(search,{kind:'queries',queries:['late'],purpose:'late',turn:1,requestId:randomUUID()}),e=>e.status===409);
    search.registerUserTurn('owner',2);assert.equal(other.currentTurn('owner').latest,2);assert.equal(other.currentTurn('owner').stoppedAt,null);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM search_session_turns WHERE session_id='owner'").get().n,1);
  }finally{otherStore.close();}
});

test('legacy JSON turn migration rolls back atomically, reopens and refuses a missing durable table',t=>{
  const parent=resolve(tmpdir()),root=mkdtempSync(join(parent,'search-turn-migrate-')),directory=join(root,'data','search');mkdirSync(directory,{recursive:true});
  const legacy={schema:2,sessions:[{sessionId:'A',latest:4,stoppedAt:4},{sessionId:'B',latest:8,stoppedAt:null}]},path=join(directory,'session-stops.json');writeFileSync(path,JSON.stringify(legacy));
  const store=new RunStore(join(root,'controller.sqlite'));t.after(()=>{store.close();assert.ok(resolve(root).startsWith(parent+sep));rmSync(root,{recursive:true,force:true});});
  store.db.exec("CREATE TABLE search_session_turns(session_id TEXT PRIMARY KEY,latest INTEGER NOT NULL,stopped_at INTEGER); CREATE TRIGGER reject_turn_migration BEFORE INSERT ON search_session_turns WHEN NEW.session_id='B' BEGIN SELECT RAISE(ABORT,'injected turn migration failure'); END");
  assert.throws(()=>new SearchService({root,store}),/injected turn migration failure/);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM search_session_turns').get().n,0);assert.equal(store.db.prepare("SELECT value FROM meta WHERE key='searchSessionTurns:v1'").get(),undefined);
  store.db.exec('DROP TRIGGER reject_turn_migration');const migrated=new SearchService({root,store});
  assert.equal(migrated.currentTurn('A').stoppedAt,4);assert.throws(()=>migrated.registerUserTurn('A',4),e=>e.status===409);assert.equal(migrated.currentTurn('B').latest,8);
  writeFileSync(path,'stale old JSON is not authoritative');const reopened=new SearchService({root,store});assert.equal(reopened.currentTurn('A').stoppedAt,4);assert.equal(reopened.currentTurn('B').latest,8);
  store.db.exec('DROP TABLE search_session_turns');assert.throws(()=>new SearchService({root,store}),e=>e.status===503&&e.code==='LEDGER_CORRUPT');
});

test('HTTP owner and body hash are required, legacy standalone service remains supported',async t=>{
  const {search,input,store}=fixture(t);const productions={ownerOf:()=>null};
  async function call(method,path,sessionId,body={},query=''){let out;await searchRoute({req:{method,headers:{'x-dsh-session':sessionId}},res:{},path,url:new URL('http://local'+path+query),role:'dsh',productions,search,body:async()=>body,json:(_r,status,value)=>out={status,value}});return out;}
  const made=await call('POST','/api/search-proposals','owner',input);assert.equal(made.status,201);assert.equal(made.value.receipt.payloadHash,digest(input));
  assert.equal((await call('GET','/api/search-proposals/by-request','owner',{},`?requestId=${input.requestId}`)).value.proposal.id,made.value.proposal.id);
  await assert.rejects(call('GET','/api/search-proposals/by-request','foreign',{},`?requestId=${input.requestId}`),e=>e.status===404);
  const standalone=new SearchService({root:fixture(t).root});standalone.registerUserTurn('legacy',1);assert.ok(standalone.propose({sessionId:'legacy',turn:1,queries:['legacy'],purpose:'fixture'}).id);
  assert.ok(store.db.prepare("SELECT name FROM sqlite_master WHERE name='search_proposal_receipts'").get());
});

test('only admin may invoke search receipt recovery through the HTTP route',async t=>{
  const {search,input}=fixture(t),save=search.save.bind(search);search.save=()=>{throw Error('injected');};assert.throws(()=>propose(search,input),e=>e.status===503);search.save=save;
  const {receipt}=search.findProposalByRequest('owner',input.requestId),evidence={sessionId:'owner',requestId:input.requestId,payloadHash:receipt.payloadHash,proposalId:receipt.proposalId,proposalHash:receipt.proposalHash};
  async function call(role){let out;await searchRoute({req:{method:'POST',headers:{'x-dsh-session':'owner'}},res:{},path:'/api/search-proposals/recovery',url:new URL('http://local/api/search-proposals/recovery'),role,productions:{},search,body:async()=>evidence,json:(_r,status,value)=>out={status,value}});return out;}
  await assert.rejects(call('dsh'),e=>e.status===403);assert.equal((await call('admin')).value.receipt.state,'abandoned');
});

test('search post-commit receipt read failure remains unknown, not a definite HTTP rejection',async t=>{
  const {search,input}=fixture(t),find=search.findProposalByRequest.bind(search);
  search.findProposalByRequest=()=>{const error=new Error('injected lookup error');error.status=404;throw error;};
  await assert.rejects(searchRoute({req:{method:'POST',headers:{'x-dsh-session':'owner'}},res:{},path:'/api/search-proposals',url:new URL('http://local/api/search-proposals'),role:'dsh',productions:{},search,body:async()=>input,json:()=>{}}),e=>e.status===503);
  search.findProposalByRequest=find;assert.equal(search.findProposalByRequest('owner',input.requestId).receipt.state,'committed');assert.equal(search.list({sessionId:'owner'}).length,1);
});

test('pre-admission HTTP rejection is durable and fences a late same-ID proposal',async t=>{
  const {search,input,store}=fixture(t),bad={...input,queries:[]};let result;
  const request={req:{method:'POST',headers:{'x-dsh-session':'owner'}},res:{},path:'/api/search-proposals',url:new URL('http://local/api/search-proposals'),role:'dsh',productions:{},search,body:async()=>bad,json:(_r,status,value)=>result={status,value}};
  await searchRoute(request);assert.equal(result.status,400);assert.equal(result.value.receipt.state,'rejected');assert.equal(result.value.receipt.payloadHash,digest(bad));
  assert.deepEqual(search.findProposalByRequest('owner',bad.requestId).receipt,result.value.receipt);
  assert.throws(()=>propose(search,input),e=>e.status===409);assert.equal(store.db.prepare('SELECT count(*) AS n FROM search_proposal_receipts').get().n,0);
  assert.throws(()=>search.findProposalByRequest('foreign',bad.requestId),e=>e.status===404);
});

test('search rejection audit and manifest survive reopen and do not accept a deleted audit',t=>{
  const {root,store,search,input}=fixture(t),receipt=search.rejectUnadmittedProposal('owner',input.requestId,digest(input),400),reopened=new SearchService({root,store});
  assert.deepEqual(reopened.findProposalByRequest('owner',input.requestId).receipt,receipt);
  store.db.prepare("DELETE FROM events WHERE run_id=? AND type='search_proposal_rejected'").run(input.requestId);
  assert.throws(()=>new SearchService({root,store}),/rejection receipt audit differs/);assert.throws(()=>reopened.findProposalByRequest('owner',input.requestId),e=>e.status===503);
});

test('search session turn table with changed key collation is not accepted after reopen',t=>{
  const {root,store}=fixture(t);store.db.exec('DROP TABLE search_session_turns; CREATE TABLE search_session_turns(session_id TEXT COLLATE NOCASE PRIMARY KEY,latest INTEGER NOT NULL,stopped_at INTEGER)');
  assert.throws(()=>new SearchService({root,store}),/turn schema is invalid/);
});

test('an already admitted or corrupt request is never turned into a rejected receipt',async t=>{
  const {search,input,store}=fixture(t);propose(search,input);
  assert.throws(()=>search.rejectUnadmittedProposal('owner',input.requestId,digest(input),400),e=>e.status===503);
  assert.equal(search.findProposalByRequest('owner',input.requestId).receipt.state,'committed');
  store.db.prepare('INSERT INTO search_proposal_rejections VALUES(?,?,?,?,?)').run('owner',input.requestId,digest(input),400,new Date().toISOString());
  assert.throws(()=>search.findProposalByRequest('owner',input.requestId),e=>e.code==='LEDGER_CORRUPT');
});

test('a failed rejection write never returns definite rejection',async t=>{
  const {search,input,store}=fixture(t);store.db.exec("CREATE TRIGGER reject_fence BEFORE INSERT ON search_proposal_rejections BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  await assert.rejects(searchRoute({req:{method:'POST',headers:{'x-dsh-session':'owner'}},res:{},path:'/api/search-proposals',url:new URL('http://local/api/search-proposals'),role:'dsh',productions:{},search,body:async()=>({...input,queries:[]}),json:()=>{throw Error('must not respond');}}),e=>e.status===503);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM search_proposal_rejections').get().n,0);
});

test('two processes racing proposal admission against its rejection cannot commit both',async t=>{
  const {root,path,store,input}=fixture(t,{disk:true});
  const script=`import {RunStore} from ${JSON.stringify(pathToFileURL(resolve('apps/controller/store.mjs')).href)};import {SearchService} from ${JSON.stringify(pathToFileURL(resolve('apps/controller/search/service.mjs')).href)};const v=JSON.parse(process.env.SEARCH_FENCE_FIXTURE),s=new RunStore(v.path),q=new SearchService({root:v.root,store:s});process.send('ready');process.once('message',()=>{try{if(v.mode==='reject')q.rejectUnadmittedProposal('owner',v.input.requestId,v.hash,400);else q.propose({sessionId:'owner',turn:1,queries:v.input.queries,purpose:v.input.purpose,requestId:v.input.requestId,requestPayloadHash:v.hash});process.send('ok');}catch(e){process.send(e.code??'error');}finally{s.close();process.disconnect();}});`;
  const children=[];const start=mode=>{const child=spawn(process.execPath,['--input-type=module','-e',script],{windowsHide:true,env:{...process.env,SEARCH_FENCE_FIXTURE:JSON.stringify({root,path,input,hash:digest(input),mode})},stdio:['ignore','pipe','pipe','ipc']});children.push(child);let stderr='';child.stderr.on('data',b=>stderr+=b);const ready=new Promise((done,fail)=>{child.on('message',m=>{if(m==='ready')done();});child.once('error',fail);child.once('exit',c=>{if(c!==0)fail(Error(stderr));});});const exited=new Promise((done,fail)=>{child.once('error',fail);child.once('exit',c=>c===0?done():fail(Error(stderr)));});return {child,ready,exited};};
  const a=start('reject'),b=start('admit');try{await Promise.all([a.ready,b.ready]);a.child.send('go');b.child.send('go');await Promise.all([a.exited,b.exited]);}finally{for(const child of children)if(child.exitCode===null)child.kill();}
  const accepted=store.db.prepare('SELECT count(*) AS n FROM search_proposal_receipts WHERE session_id=? AND request_id=?').get('owner',input.requestId).n,rejected=store.db.prepare('SELECT count(*) AS n FROM search_proposal_rejections WHERE session_id=? AND request_id=?').get('owner',input.requestId).n;
  assert.equal(accepted+rejected,1);
});

test('two independent Controller processes race one request without creating two proposals',async t=>{
  const {root,path,input}=fixture(t,{disk:true});
  const script=`import {RunStore} from ${JSON.stringify(pathToFileURL(resolve('apps/controller/store.mjs')).href)};import {SearchService} from ${JSON.stringify(pathToFileURL(resolve('apps/controller/search/service.mjs')).href)};import {createHash} from 'node:crypto';const v=JSON.parse(process.env.SEARCH_RECEIPT_FIXTURE),s=new RunStore(v.path),q=new SearchService({root:v.root,store:s});try{const h=createHash('sha256').update(JSON.stringify(v.input)).digest('hex');console.log(JSON.stringify({id:q.propose({sessionId:'owner',queries:v.input.queries,purpose:v.input.purpose,turn:1,requestId:v.input.requestId,requestPayloadHash:h}).id}));}catch(e){console.log(JSON.stringify({error:e.code}));}finally{s.close();}`;
  const run=()=>new Promise((done,fail)=>{const child=spawn(process.execPath,['--input-type=module','-e',script],{env:{...process.env,SEARCH_RECEIPT_FIXTURE:JSON.stringify({root,path,input})},windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',fail);child.on('exit',code=>code===0?done(JSON.parse(out)):fail(Error(err)));});
  const results=await Promise.all([run(),run()]);assert.ok(results.some(x=>x.id));assert.ok(results.every(x=>x.id===results.find(y=>y.id).id||x.error==='REQUEST_UNKNOWN'));
  const files=readdirSync(join(root,'data','search')).filter(x=>/^[a-f0-9-]{36}\.json$/.test(x));assert.equal(files.length,1);
});

test('cross-process same-ID retry stays unknown while a different request is rejected before admission',async t=>{
  const {root,path,search,input}=fixture(t,{disk:true});
  const script=`import {RunStore} from ${JSON.stringify(pathToFileURL(resolve('apps/controller/store.mjs')).href)};import {SearchService} from ${JSON.stringify(pathToFileURL(resolve('apps/controller/search/service.mjs')).href)};import {createHash} from 'node:crypto';const v=JSON.parse(process.env.SEARCH_RECEIPT_FIXTURE),s=new RunStore(v.path),q=new SearchService({root:v.root,store:s}),save=q.save.bind(q);q.save=r=>{process.stdout.write('RESERVED\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,3000);return save(r);};try{const h=createHash('sha256').update(JSON.stringify(v.input)).digest('hex');q.propose({sessionId:'owner',queries:v.input.queries,purpose:v.input.purpose,turn:1,requestId:v.input.requestId,requestPayloadHash:h});}finally{s.close();}`;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{env:{...process.env,SEARCH_RECEIPT_FIXTURE:JSON.stringify({root,path,input})},windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';child.stderr.on('data',b=>err+=b);
  const ended=new Promise((done,fail)=>{child.on('error',fail);child.on('exit',code=>code===0?done():fail(Error(err)));});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await ended.catch(()=>{});});
  await new Promise((done,fail)=>{child.stdout.on('data',bytes=>{out+=bytes;if(out.includes('RESERVED\n'))done();});child.on('error',fail);child.on('exit',code=>{if(!out.includes('RESERVED\n'))fail(Error(`child stopped before reservation: ${code} ${err}`));});});
  assert.throws(()=>propose(search,input),e=>e.status===503&&e.code==='REQUEST_UNKNOWN');
  assert.throws(()=>propose(search,{...input,purpose:'different'}),e=>e.status===503&&e.code==='REQUEST_UNKNOWN');
  assert.throws(()=>propose(search,{...input,requestId:randomUUID()}),e=>e.status===409&&e.code==='REQUEST_UNKNOWN');
  await ended;assert.equal(search.findProposalByRequest('owner',input.requestId).receipt.state,'committed');
});
