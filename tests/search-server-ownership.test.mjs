import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createServer as reservePort} from 'node:net';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,lstatSync,readdirSync,copyFileSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {RunStore} from '../apps/controller/store.mjs';
import {ProductionStore} from '../apps/controller/productions.mjs';
import {SearchService} from '../apps/controller/search/service.mjs';
import {updateOwnerManifest} from '../apps/controller/search/owner-manifest.mjs';

async function port(){const s=reservePort();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function fixture(t,strict,{native=false,badBirth=false,disabled=false}={}){
 const base=resolve(tmpdir()),root=mkdtempSync(join(base,'server-owner-')),p=await port();mkdirSync(join(root,'config'),{recursive:true});mkdirSync(join(root,'input'),{recursive:true});mkdirSync(join(root,'output'),{recursive:true});
 writeFileSync(join(root,'config/environment.json'),JSON.stringify({comfyPort:38927,inputDirectory:join(root,'input'),outputDirectory:join(root,'output'),comfyPythonExecutable:process.execPath}));
 let nativeConfig,nativeIdentity;if(native){const source=process.env.MEDIA_STUDIO_TEST_NATIVE_PROBE,dir=join(root,'apps/media-studio-probe');mkdirSync(dir,{recursive:true});const exe=join(dir,'controller-native-probe.exe');copyFileSync(source,exe);const sha256=createHash('sha256').update(readFileSync(exe)).digest('hex');nativeConfig={enabled:true,executable:exe,sha256};const sampled=spawnSync(exe,['processes',String(process.pid)],{encoding:'utf8',windowsHide:true,shell:false});assert.equal(sampled.status,0,sampled.stderr);nativeIdentity=JSON.parse(sampled.stdout).data[0];}
 writeFileSync(join(root,'config/controller.json'),JSON.stringify({port:p,profile:'qwen-photo-v1',...(disabled?{searchTurnOwnership:false}:strict?{searchTurnOwnership:true}:{}),...(native?{nativeProbe:nativeConfig}:{})}));
 writeFileSync(join(root,'config/strata.json'),JSON.stringify({enabled:false}));writeFileSync(join(root,'config/rustxng.json'),JSON.stringify({enabled:true,baseUrl:'http://127.0.0.1:29483'}));
 const productionInput={requestId:randomUUID(),brief:{request:'portrait',modelProfile:'qwen-photo-v1',mode:'t2i',criteria:[{id:'C1',description:'portrait'}],invariants:[]}};
 const hostId=randomUUID(),prior=new RunStore(join(root,'data/controller/controller.db'));try{new ProductionStore(prior).create('owner',productionInput);if(strict){new SearchService({root,store:prior});const ticks=nativeIdentity?(BigInt(nativeIdentity.startTimeUtcTicks)+(badBirth?1n:0n)).toString():'638000000000000000',exe=nativeIdentity?.executable??'C:\\fixture\\host.exe';prior.transaction(()=>{prior.db.prepare("INSERT INTO search_session_host_generations(session_id,host_id,pid,state,start_time_utc_ticks,executable) VALUES(?,?,?,'active',?,?)").run('owner',hostId,process.pid,ticks,exe);prior.db.prepare("INSERT INTO search_turn_owners VALUES(?,?,?,'active',1,NULL,NULL)").run('owner',1,hostId);updateOwnerManifest(prior.db);});}}finally{prior.close();}
 const child=spawn(process.execPath,[resolve('apps/controller/server.mjs')],{env:{...process.env,MEDIA_STUDIO_HOME:root},stdio:['ignore','pipe','pipe'],windowsHide:true});let error='';child.stderr.on('data',b=>error+=b);
 let ready=false;for(let i=0;i<120;i++){if(child.exitCode!==null)throw Error(`server exited ${child.exitCode}: ${error}`);try{const r=await fetch(`http://127.0.0.1:${p}/health`);if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert.equal(ready,true,error);
 const admin=readFileSync(join(root,'data/controller/auth-token'),'utf8').trim(),dsh=readFileSync(join(root,'data/controller/dsh-token'),'utf8').trim();
 const call=(path,input,token=dsh)=>fetch(`http://127.0.0.1:${p}${path}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'X-DSH-Session':'owner','Content-Type':'application/json'},body:JSON.stringify(input)});
 t.after(async()=>{if(child.exitCode===null){try{await call('/api/shutdown',{},admin);}catch{}await new Promise(r=>child.once('exit',r));}assert.ok(resolve(root).startsWith(base+sep));const walk=x=>{const s=lstatSync(x);assert.equal(s.isSymbolicLink(),false);if(s.isDirectory())for(const n of readdirSync(x))walk(join(x,n));};walk(root);rmSync(root,{recursive:true});});
 return {root,p,child,call,admin,productionInput,hostId,get errors(){return error;}};
}
for(const strict of [false,true])test(`server startup with ${strict?'explicit':'default'} protected search preserves old image production replay`,{timeout:20000},async t=>{
 const f=await fixture(t,strict);const turn=await f.call('/api/search-proposals/user-turn',{turn:1,hostId:f.hostId});assert.equal(turn.status,503);
 const dsh=readFileSync(join(f.root,'data/controller/dsh-token'),'utf8').trim(),status=await fetch(`http://127.0.0.1:${f.p}/api/status`,{headers:{Authorization:`Bearer ${dsh}`,'X-DSH-Session':'owner'}});assert.equal((await status.json()).search.availability,'unavailable');
 const production=await f.call('/api/productions',f.productionInput);assert.equal(production.status,200,(await production.text())+' '+f.errors);
 const healthy=await fetch(`http://127.0.0.1:${f.p}/health`);assert.equal(healthy.status,200);assert.equal(existsSync(join(f.root,'data/controller/controller.db')),true);
 const closed=new Promise(r=>f.child.once('exit',r));assert.equal((await f.call('/api/shutdown',{},f.admin)).status,200);await closed;
 const db=new DatabaseSync(join(f.root,'data/controller/controller.db'),{readOnly:true});try{assert.equal(db.prepare("SELECT value FROM meta WHERE key='searchTurnOwners:v1'").get().value,'done');}finally{db.close();}
});
test('legacy explicit false disables search rather than selecting an unprotected mode',{timeout:20000},async t=>{
 const f=await fixture(t,false,{disabled:true}),listing=await fetch(`http://127.0.0.1:${f.p}/api/search-proposals`,{headers:{Authorization:`Bearer ${readFileSync(join(f.root,'data/controller/dsh-token'),'utf8').trim()}`,'X-DSH-Session':'owner'}});assert.equal(listing.status,200);assert.equal((await listing.json()).enabled,false);assert.equal((await f.call('/api/productions',f.productionInput)).status,200);
});
for(const badBirth of [false,true])test(`strict server verifies real Windows Host ${badBirth?'birth mismatch':'birth identity'}`,{timeout:20000},async t=>{
 if(process.platform!=='win32'||!process.env.MEDIA_STUDIO_TEST_NATIVE_PROBE){t.skip('Set MEDIA_STUDIO_TEST_NATIVE_PROBE to a trusted Windows fixture build');return;}
 const f=await fixture(t,true,{native:true,badBirth}),response=await f.call('/api/search-proposals/user-turn',{turn:1,hostId:f.hostId});assert.equal(response.status,badBirth?503:200,await response.text());const dsh=readFileSync(join(f.root,'data/controller/dsh-token'),'utf8').trim(),status=await fetch(`http://127.0.0.1:${f.p}/api/status`,{headers:{Authorization:`Bearer ${dsh}`,'X-DSH-Session':'owner'}});assert.equal((await status.json()).search.availability,'requires-current-host-confirmation');
 assert.equal((await f.call('/api/productions',f.productionInput)).status,200);
});
