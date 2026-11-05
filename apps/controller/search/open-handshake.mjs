// Unconnected opt-in candidate. All network and OS observations are async and
// outside SQLite write transactions. A proof is valid only for one operation;
// it does not prove that a later external request was not already dispatched.
import {randomBytes} from 'node:crypto';
import {win32} from 'node:path';
import {assertOwnerManifest} from './owner-manifest.mjs';
import {currentCutoverTurn,requireCutoverTurn} from './cutover-ledger.mjs';
import {searchOpenKey,searchOpenRequestMac,searchOpenResponseMac,searchOpenMacEqual} from './open-handshake-codec.mjs';

const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const validSession=x=>typeof x==='string'&&/^[\x21-\x7e]{1,150}$/.test(x);
const safeExe=x=>typeof x==='string'&&x.length<=32767&&win32.isAbsolute(x)&&!/[\u0000-\u001f]/.test(x);
const sameExe=(a,b)=>safeExe(a)&&safeExe(b)&&win32.normalize(a).toLowerCase()===win32.normalize(b).toLowerCase();
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
const unavailable=()=>{throw Error('Search gateway open confirmation is unavailable; keep search on hold');};
async function limitedJson(response){if(!response?.ok||!response.body){await response?.body?.cancel().catch(()=>{});unavailable();}const declared=response.headers.get('content-length');if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??'')||declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>2048)){await response.body.cancel().catch(()=>{});unavailable();}const reader=response.body.getReader(),chunks=[];let size=0;try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2048)unavailable();chunks.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{unavailable();}}
export function createSearchOpenHandshake({store,ownerProbe,token,fetchImpl=fetch,timeoutMs=2000}){
 if(!store?.db||typeof store.transaction!=='function'||typeof ownerProbe?.epoch!=='function'||typeof fetchImpl!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<50||timeoutMs>10000)throw Error('Search gateway verification is unavailable');
 // Validate the credential once without persisting it or using it as a URL.
 searchOpenKey(token,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
 const registrations=new Map(),key=(sessionId,hostId)=>sessionId+'\0'+hostId;
 function snapshot(sessionId,hostId){return store.transaction(()=>{assertOwnerManifest(store.db);const hosts=store.db.prepare("SELECT * FROM search_session_host_generations WHERE session_id=? AND state='active'").all(sessionId),host=hosts[0];if(hosts.length!==1||host.host_id!==hostId||!Number.isSafeInteger(host.pid)||host.pid<1||!safeExe(host.executable)||typeof host.start_time_utc_ticks!=='string'||!/^[1-9][0-9]{16,18}$/.test(host.start_time_utc_ticks))unavailable();return {...host};});}
 function targetSnapshot(sessionId,turn){return store.transaction(()=>{assertOwnerManifest(store.db);const owner=store.db.prepare('SELECT * FROM search_turn_owners WHERE session_id=? AND turn=?').get(sessionId,turn),hosts=store.db.prepare("SELECT * FROM search_session_host_generations WHERE session_id=? AND state='active'").all(sessionId),scoped=currentCutoverTurn(store.db,sessionId),turnRow=scoped?scoped.row:store.db.prepare('SELECT * FROM search_session_turns WHERE session_id=?').get(sessionId),host=hosts[0];if(scoped)requireCutoverTurn(store.db,sessionId,turn,owner?.start_seq);if(!owner||!uuid(owner.host_id)||!['active','completed'].includes(owner.state)||hosts.length!==1||host.host_id!==owner.host_id||!Number.isSafeInteger(host.pid)||host.pid<1||!safeExe(host.executable)||typeof host.start_time_utc_ticks!=='string'||!/^[1-9][0-9]{16,18}$/.test(host.start_time_utc_ticks)||!turnRow||turnRow.latest!==turn||turnRow.stopped_at!==null)unavailable();return {host:{...host},owner:{...owner},turnRow:{...turnRow},cutover:scoped?.generation??null};});}
 function verifyEpoch(epoch,host){const m=epoch?.managed,l=epoch?.listener;if(!m||!l||m.pid!==host.pid||l.pid!==host.pid||m.startTimeUtcTicks!==host.start_time_utc_ticks||l.startTimeUtcTicks!==host.start_time_utc_ticks||!sameExe(m.executable,host.executable)||!sameExe(l.executable,host.executable))unavailable();}
 async function observe(host,port,signal){let epoch;try{epoch=await ownerProbe.epoch({pid:host.pid,port},{signal});}catch{unavailable();}verifyEpoch(epoch,host);}
 function unchanged(sessionId,hostId,expected){if(JSON.stringify(snapshot(sessionId,hostId))!==JSON.stringify(expected))unavailable();}
 return Object.freeze({
  async register({sessionId,hostId,port}){
   if(!validSession(sessionId)||!uuid(hostId)||!Number.isSafeInteger(port)||port<1024||port>65535)unavailable();registrations.delete(key(sessionId,hostId));const before=snapshot(sessionId,hostId),signal=AbortSignal.timeout(timeoutMs);await observe(before,port,signal);unchanged(sessionId,hostId,before);await observe(before,port,signal);unchanged(sessionId,hostId,before);registrations.set(key(sessionId,hostId),{port,host:before});return {sessionId,hostId,registered:true};
  },
  async requireOpen({sessionId,turn,operation,proposalId,signal}){
   if(!validSession(sessionId)||!Number.isSafeInteger(turn)||turn<1||!['approve','claim','fetch'].includes(operation)||!(proposalId===null||uuid(proposalId)))unavailable();
   let target;try{target=targetSnapshot(sessionId,turn);}catch{unavailable();}const host=target.host,unchangedTarget=()=>{if(JSON.stringify(targetSnapshot(sessionId,turn))!==JSON.stringify(target))unavailable();};
   const registered=registrations.get(key(sessionId,host.host_id));if(!registered||JSON.stringify(registered.host)!==JSON.stringify(host))unavailable();
   const timeout=AbortSignal.timeout(timeoutMs),combined=signal?AbortSignal.any([signal,timeout]):timeout,payload={v:1,sessionId,turn,hostId:host.host_id,operation,proposalId,challenge:randomBytes(32).toString('hex')},secret=searchOpenKey(token,host.host_id),requestMac=searchOpenRequestMac(secret,payload);
   await observe(host,registered.port,combined);unchangedTarget();let response;try{response=await fetchImpl(`http://127.0.0.1:${registered.port}/open-check`,{method:'POST',redirect:'error',cache:'no-store',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({...payload,requestMac}),signal:combined});}catch{unavailable();}
   const body=await limitedJson(response);if(!exact(body,['v','challenge','open','responseMac'])||body.v!==1||body.challenge!==payload.challenge||body.open!==true||!searchOpenMacEqual(body.responseMac,searchOpenResponseMac(secret,payload)))unavailable();await observe(host,registered.port,combined);unchangedTarget();if(combined.aborted)unavailable();return true;
  }
 });
}
