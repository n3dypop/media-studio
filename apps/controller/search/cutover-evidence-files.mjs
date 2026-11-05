import {open,lstat,realpath,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname,isAbsolute} from 'node:path';
import {readFileSync,lstatSync,readdirSync,realpathSync} from 'node:fs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const sameStat=(a,b)=>['dev','ino','size','mtimeNs','ctimeNs'].every(k=>a[k]===b[k]);
export async function safeEvidencePath(input,directory){
 if(typeof input!=='string'||!isAbsolute(input)||/^[\\/]{2}/.test(input))throw Error('Evidence paths must be local and absolute');const path=resolve(input);
 for(let current=path;;current=dirname(current)){const s=await lstat(current,{bigint:true});if(s.isSymbolicLink()||(current===path?(directory?!s.isDirectory():!s.isFile()):!s.isDirectory())||!same(resolve(await realpath(current)),current))throw Error('Evidence path is unsafe');if(current===path&&!directory&&s.nlink!==1n)throw Error('Hard-linked evidence is not accepted');const parent=dirname(current);if(parent===current)break;}
 return path;
}
export async function stableEvidenceRead(path,maxBytes){
 const handle=await open(path,'r');try{const before=await handle.stat({bigint:true});if(!before.isFile()||before.nlink!==1n||before.size>BigInt(maxBytes))throw Error('Evidence file is invalid');const bytes=await handle.readFile(),after=await handle.stat({bigint:true}),current=await lstat(path,{bigint:true});if(!sameStat(before,after)||!sameStat(before,current))throw Error('Evidence changed while reading');return bytes;}finally{await handle.close();}
}
export async function historyEvidenceSnapshot(directory){
 const names=(await readdir(directory)).sort(),rows=[];if(names.length>100000)throw Error('History snapshot is too large');
 for(const name of names){if(name!=='session-stops.json'&&!/^[a-f0-9-]{36}\.json$/.test(name))throw Error('Unexpected history entry requires inspection');const path=await safeEvidencePath(resolve(directory,name),false),bytes=await stableEvidenceRead(path,2*1024*1024);rows.push({name,sha256:hash(bytes)});}
 if(JSON.stringify(names)!==JSON.stringify((await readdir(directory)).sort()))throw Error('History directory changed while reading');return {fileCount:rows.length,sha256:hash(Buffer.from(JSON.stringify(rows)))};
}
export function historyEvidenceSnapshotSync(directory){
 const target=resolve(directory),dir=lstatSync(target);if(!dir.isDirectory()||dir.isSymbolicLink()||!same(resolve(realpathSync(target)),target))throw Error('History directory is unsafe');const names=readdirSync(target).sort(),rows=[];if(names.length>100000)throw Error('History snapshot is too large');
 for(const name of names){if(name!=='session-stops.json'&&!/^[a-f0-9-]{36}\.json$/.test(name))throw Error('Unexpected history entry requires inspection');const file=resolve(target,name),before=lstatSync(file,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>2097152n)throw Error('History entry is unsafe');const bytes=readFileSync(file),after=lstatSync(file,{bigint:true});if(!sameStat(before,after))throw Error('History changed while reading');rows.push({name,sha256:hash(bytes)});}
 if(JSON.stringify(names)!==JSON.stringify(readdirSync(target).sort()))throw Error('History directory changed while reading');return {fileCount:rows.length,sha256:hash(Buffer.from(JSON.stringify(rows)))};
}
