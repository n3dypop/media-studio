import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {RunStore} from '../apps/controller/store.mjs';
import {SearchService} from '../apps/controller/search/service.mjs';
import {withObservedOwnerTransaction} from '../apps/controller/search/owner-observation.mjs';

function setup(t){
 const root=mkdtempSync(join(tmpdir(),'owner-async-')),store=new RunStore(join(root,'db.sqlite'));new SearchService({root,store});const host=randomUUID();
 store.db.prepare("INSERT INTO search_session_host_generations(session_id,host_id,pid,state,start_time_utc_ticks,executable) VALUES(?,?,?,'active',?,?)").run('owner',host,process.pid,'638000000000000000','C:\\fixture\\host.exe');
 store.db.prepare("INSERT INTO search_turn_owners VALUES(?,?,?,'active',?,NULL,NULL)").run('owner',1,host,1);store.db.prepare('INSERT INTO search_session_turns VALUES(?,?,NULL)').run('owner',1);
 t.after(()=>{store.close();rmSync(root,{recursive:true});});return {root,store,host};
}
const observe=()=>({processes:async pids=>[{pid:pids[0],startTimeUtcTicks:'638000000000000000',executable:'C:\\fixture\\host.exe'}]});
test('async observation permits only same Host and rollback on promise callback',async t=>{
 const {store}=setup(t),args={store,sessionId:'owner',turn:1,probe:observe()};
 assert.equal(await withObservedOwnerTransaction({...args,operation:()=>42}),42);
 await assert.rejects(withObservedOwnerTransaction({...args,operation:()=>Promise.resolve(42)}),/synchronous/);
 await assert.rejects(withObservedOwnerTransaction({...args,probe:{processes:async()=>{throw Error('denied')}},operation:()=>42}),/observation failed/);
 await assert.rejects(withObservedOwnerTransaction({...args,probe:{processes:async pids=>[{pid:pids[0]+1,startTimeUtcTicks:'638000000000000000',executable:'C:\\fixture\\host.exe'}]},operation:()=>42}),/identity differs/);
 await assert.rejects(withObservedOwnerTransaction({...args,probe:{processes:async pids=>[{pid:pids[0],startTimeUtcTicks:'638000000000000001',executable:'C:\\fixture\\host.exe'}]},operation:()=>42}),/identity differs/);
});
test('a stop received while observing prevents the later mutation',async t=>{
 const {store}=setup(t);let release;const pending=new Promise(resolve=>release=resolve);let mutated=false;
 const run=withObservedOwnerTransaction({store,sessionId:'owner',turn:1,probe:{processes:async pids=>{await pending;return [{pid:pids[0],startTimeUtcTicks:'638000000000000000',executable:'C:\\fixture\\host.exe'}];}},operation:()=>{mutated=true;}});
 store.db.prepare('UPDATE search_session_turns SET stopped_at=1 WHERE session_id=?').run('owner');release();await assert.rejects(run,/stopped|changed/);assert.equal(mutated,false);
});
test('a pending async probe leaves health and owned stop HTTP requests responsive',async t=>{
 const {store}=setup(t);let release,entered;const pending=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);let mutated=false;
 const server=createServer(async(req,res)=>{
  if(req.url==='/health'){res.end('ok');return;}
  if(req.url==='/stop'){store.db.prepare('UPDATE search_session_turns SET stopped_at=1 WHERE session_id=?').run('owner');res.end('stopped');return;}
  try{await withObservedOwnerTransaction({store,sessionId:'owner',turn:1,probe:{processes:async pids=>{entered();await pending;return [{pid:pids[0],startTimeUtcTicks:'638000000000000000',executable:'C:\\fixture\\host.exe'}];}},operation:()=>{mutated=true;}});res.writeHead(200).end();}catch{res.writeHead(503).end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`,request=fetch(base+'/mutation');await started;
 assert.equal(await (await fetch(base+'/health')).text(),'ok');assert.equal(await (await fetch(base+'/stop')).text(),'stopped');release();assert.equal((await request).status,503);assert.equal(mutated,false);
});
