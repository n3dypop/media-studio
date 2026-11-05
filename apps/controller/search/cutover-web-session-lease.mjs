// Offline Windows Web maintenance candidate. Uses the installed DSH JSONL backend
// and its named writer semaphore; it does not open a write handle or migrate
// a user's session. A non-cooperating writer is outside this semaphore.
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {readdir} from 'node:fs/promises';
import {readFileSync,lstatSync,readdirSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {safeEvidencePath,stableEvidenceRead} from './cutover-evidence-files.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
// Equivalent to the 0.2.2-rc.1 durable inbox projection. A completed turn
// can still leave queued input from an earlier splice, so inspecting only
// events after turn/end is insufficient.
export function assertNoPendingInbox(rows){
 const queues={'next-turn':[],'next-step':[]};
 for(const event of rows){if(event?.type!=='agent/inbox/spliced')continue;const s=event.data,queue=queues[s?.target],removed=s?.removedCount??0;if(!queue||!Number.isSafeInteger(s.start)||s.start<0||s.start>queue.length||!Number.isSafeInteger(removed)||removed<0||s.start+removed>queue.length||!Array.isArray(s.inserted)||s.inserted.some(m=>!m||typeof m.id!=='string'||!m.id))throw Error('Invalid persisted inbox splice');queue.splice(s.start,removed,...s.inserted);const ids=[...queues['next-turn'],...queues['next-step']].map(m=>m.id);if(new Set(ids).size!==ids.length)throw Error('Invalid duplicated inbox identity');}
 if(queues['next-turn'].length||queues['next-step'].length)throw Error('DSH session has pending inbox input');
}
function encoded(raw){if(typeof raw!=='string'||!/^[\x21-\x7e]{1,150}$/.test(raw))throw Error('Invalid session identity');if(raw==='.')return '~002E';if(raw==='..')return '~002E~002E';let out='';for(let i=0;i<raw.length;i++){const ch=raw[i];out+=ch!=='~'&&/^[A-Za-z0-9._-]$/.test(ch)?ch:'~'+raw.charCodeAt(i).toString(16).toUpperCase().padStart(4,'0');}return out;}
async function locate(storage,id){const matches=[];for(const project of await readdir(storage,{withFileTypes:true})){if(project.isSymbolicLink())throw Error('Linked session projects are unavailable');if(!project.isDirectory())throw Error('Unexpected session storage entry');const path=join(storage,project.name,encoded(id));try{await safeEvidencePath(path,true);matches.push(path);}catch(error){if(error?.code!=='ENOENT')throw error;}}if(matches.length!==1)throw Error('Stored session identity is missing or ambiguous');return matches[0];}
async function fingerprint(directory){const rows=[];for(const item of await readdir(directory,{withFileTypes:true})){if(item.name==='session.lock'&&item.isFile())continue;if(!item.isFile()||item.isSymbolicLink()||!/^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/.test(item.name))throw Error('Unsupported session artifact');const path=await safeEvidencePath(join(directory,item.name),false),bytes=await stableEvidenceRead(path,256*1024*1024);rows.push({name:item.name,bytes:bytes.length,sha256:hash(bytes)});}if(!rows.length)throw Error('Session history is missing');rows.sort((a,b)=>a.name.localeCompare(b.name));return hash(Buffer.from(JSON.stringify(rows)));}
function acquire(dshDirectory,directory){
 if(process.platform!=='win32')throw Error('This session lease supports Windows only');const require=createRequire(join(dshDirectory,'package.json')),backendRequire=createRequire(require.resolve('@deepseek-ai/dsh-session-persistence-jsonl')),koffi=backendRequire('koffi'),kernel=koffi.load('kernel32.dll');
 // Same semaphore identity as DeepSeek Harness session-persistence-jsonl
 // (MIT; packages/session/session-persistence-jsonl/src/win32.ts).
 const create=kernel.func('__stdcall','CreateSemaphoreW','intptr',['void*','int','int','str16']),wait=kernel.func('__stdcall','WaitForSingleObject','uint',['intptr','uint']),release=kernel.func('__stdcall','ReleaseSemaphore','int',['intptr','int','void*']),close=kernel.func('__stdcall','CloseHandle','int',['intptr']),name='Local\\dsh-session-lock-'+hash(Buffer.from(resolve(directory,'session.lock').toLowerCase())),handle=create(null,1,1,name);if(!handle)throw Error('Session lease is unavailable');if(wait(handle,0)!==0){close(handle);throw Error('The session still has a DSH writer');}let done=false;return()=>{if(done)return;done=true;if(!release(handle,1,null)||!close(handle))throw Error('Session lease release failed');};
}
export async function withWebCutoverSessionLease({mode,dshDirectory,sessionStorageRoot,rawSessionId,turn},operation){
 if(mode!=='web'||typeof operation!=='function'||!Number.isSafeInteger(turn)||turn<1)throw Error('Only the pinned Web JSONL session format is supported');const runtime=await safeEvidencePath(dshDirectory,true),storage=await safeEvidencePath(sessionStorageRoot,true),directory=await locate(storage,rawSessionId),rel=relative(storage,directory);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('Session path escapes storage');const release=acquire(runtime,directory);let ctx,handle,active=true;
 try{const before=await fingerprint(directory),require=createRequire(join(runtime,'package.json'));if(require('@deepseek-ai/dsh-agent-loop/package.json').version!=='0.2.2-rc.1'||hash(readFileSync(require.resolve('@deepseek-ai/dsh-session-persistence-jsonl')))!=='69efef5f84dddf947032bc1425067878fa610416c8885acde2ded9b01230c9b7')throw Error('Unsupported DSH inbox or JSONL backend version');const {Context}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href),backend=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href);ctx=new Context();await ctx.plugin(backend,{root:storage}).await();handle=await ctx.sessionPersistence.open(rawSessionId,'read');if(handle?.id!==rawSessionId||handle.access!=='read'||handle.header?.id!==rawSessionId)throw Error('Session backend identity differs');const rows=(await handle.read(0,100001))?.events;if(!Array.isArray(rows)||rows.length===0||rows.length>100000||rows.some((event,index)=>event?.seq!==index))throw Error('Session event history is incomplete');
  assertNoPendingInbox(rows);
  const starts=rows.filter(event=>event.type==='turn/start'&&event.data?.turn===turn),ends=rows.filter(event=>event.type==='turn/end'&&event.data?.turn===turn),lastStart=rows.findLast(event=>event.type==='turn/start');if(starts.length!==1||ends.length!==1||lastStart!==starts[0]||ends[0].seq<=starts[0].seq||ends[0].data?.reason?.kind!=='completed')throw Error('Selected session does not have the requested latest normal turn');
  // Even an unfamiliar event after the completed turn may represent an input
  // or queue transition. Do not guess that it is harmless. The writer lease
  // cannot observe unpersisted inputs held by a running DSH host.
  if(ends[0].seq!==rows.length-1)throw Error('Session has events after the completed turn; pending input or queue cannot be excluded');
  const range=rows.slice(starts[0].seq,ends[0].seq+1),evidence={rawSessionId,sessionIdHash:hash(Buffer.from(rawSessionId)),fullEventsHash:hash(Buffer.from(JSON.stringify(rows))),fullEventCount:rows.length,turn,startSeq:starts[0].seq,endSeq:ends[0].seq,eventCount:range.length,eventsHash:hash(Buffer.from(JSON.stringify(range))),endEventHash:hash(Buffer.from(JSON.stringify(ends[0]))),filesHash:before};
  const assertStable=async()=>{if(await fingerprint(directory)!==before)throw Error('Session files changed during maintenance');};
  // Called only under the same semaphore as the observations above. No
  // session content is returned in the CLI output.
  const copySource=async()=>{await assertStable();const result=[];let total=0;for(const name of (await readdir(directory)).sort()){if(name==='session.lock')continue;const path=await safeEvidencePath(join(directory,name),false),bytes=await stableEvidenceRead(path,256*1024*1024);total+=bytes.length;if(total>512*1024*1024)throw Error('Session backup exceeds its bound');result.push({name,bytes});}await assertStable();return result;};
  const assertStableSync=()=>{if(!active)throw Error('Session lease is no longer held');const rows=[];for(const item of readdirSync(directory,{withFileTypes:true})){if(item.name==='session.lock'&&item.isFile())continue;if(!item.isFile()||item.isSymbolicLink()||!/^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/.test(item.name))throw Error('Unsupported session artifact');const path=join(directory,item.name),first=lstatSync(path,{bigint:true});if(!first.isFile()||first.nlink!==1n||first.size>268435456n)throw Error('Session artifact is unsafe');const bytes=readFileSync(path),last=lstatSync(path,{bigint:true});if(['dev','ino','size','mtimeNs','ctimeNs'].some(key=>first[key]!==last[key]))throw Error('Session file changed');rows.push({name:item.name,bytes:bytes.length,sha256:hash(bytes)});}rows.sort((a,b)=>a.name.localeCompare(b.name));if(hash(Buffer.from(JSON.stringify(rows)))!==before)throw Error('Session files changed during maintenance');};
  await assertStable();const result=await operation(evidence,assertStable,copySource,assertStableSync);await assertStable();return result;
 }finally{active=false;try{await handle?.close();}finally{try{await ctx?.fiber.dispose();}finally{release();}}}
}
