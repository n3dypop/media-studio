// Offline, pre-RunStore Controller snapshot. Never opens the original SQLite
// database: a stopped/fenced source is copied, verified twice, then SQLite's
// read-only backup API materializes the DB+WAL into a standalone private copy.
// The candidate fixed entry calls this module; deployment and live-runtime
// execution have not been verified.
import {DatabaseSync,backup as sqliteBackup} from 'node:sqlite';
import {mkdir,open} from 'node:fs/promises';
import {existsSync,readFileSync,lstatSync,realpathSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {safeEvidencePath,stableEvidenceRead} from './cutover-evidence-files.mjs';
import {verifyPrivateCutoverAcl} from './cutover-backup.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex');
const within=(root,path)=>{const r=relative(root,path);return r===''||(!r.startsWith('..')&&!isAbsolute(r));};
async function sourceFiles(dbPath){
 if(existsSync(dbPath+'-journal'))throw Error('Controller rollback journal requires inspection');
 const suffixes=['','-wal','-shm','.provision'],files=[];for(const suffix of suffixes){const path=dbPath+suffix;if(suffix&&!existsSync(path))continue;const safe=await safeEvidencePath(path,false),bytes=await stableEvidenceRead(safe,256*1024*1024);files.push({name:'controller.db'+suffix,bytes,sha256:sha(bytes)});}
 if(!files.some(x=>x.name==='controller.db')||files.reduce((sum,x)=>sum+x.bytes.length,0)>512*1024*1024)throw Error('Controller source snapshot is incomplete or too large');return files;
}
const sourceSummary=files=>files.map(x=>({name:x.name,bytes:x.bytes.length,sha256:x.sha256}));
function inspect(db){
 const quick=db.prepare('PRAGMA quick_check').all();if(quick.length!==1||Object.values(quick[0])[0]!=='ok')throw Error('Controller SQLite quick_check failed');
 const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name").all(),counts={};
 const tables=schema.filter(x=>x.type==='table'&&/^(meta|runs|events|search_[a-z0-9_]+)$/.test(x.name));if(tables.length>256)throw Error('Controller schema has too many tables');for(const row of tables)counts[row.name]=db.prepare(`SELECT count(*) AS n FROM "${row.name}"`).get().n;
 return {schemaSha256:sha(Buffer.from(JSON.stringify(schema))),counts};
}
export async function snapshotControllerBeforeRunStore({databasePath,backupParent,controllerFence}){
 if(typeof databasePath!=='string'||!isAbsolute(databasePath)||typeof backupParent!=='string'||!isAbsolute(backupParent)||typeof controllerFence?.verifySync!=='function'||!/^[a-f0-9]{64}$/.test(controllerFence.recordSha256??'')||controllerFence.verifySync()!==true)throw Error('Stopped Controller fence unavailable');
 const source=await safeEvidencePath(databasePath,false),parent=await safeEvidencePath(backupParent,true),sourceDir=resolve(source,'..');if(within(sourceDir,parent)||within(parent,sourceDir))throw Error('Pre-open backup must be independent of the source');
 const before=await sourceFiles(source);if(controllerFence.verifySync()!==true)throw Error('Controller fence changed before snapshot');
 const directory=join(parent,'controller-preopen-'+randomUUID());await mkdir(directory,{mode:0o700});await safeEvidencePath(directory,true);if(!verifyPrivateCutoverAcl(directory,true))throw Error('Pre-open backup privacy unavailable');await mkdir(join(directory,'raw'),{mode:0o700});await mkdir(join(directory,'work'),{mode:0o700});
 async function write(path,bytes){const file=await open(path,'wx',0o600);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}if(!readFileSync(path).equals(bytes))throw Error('Pre-open copy differs');}
 for(const item of before){await write(join(directory,'raw',item.name),item.bytes);if(item.name==='controller.db'||item.name==='controller.db-wal')await write(join(directory,'work',item.name),item.bytes);}
 const working=join(directory,'work/controller.db'),snapshot=join(directory,'snapshot.sqlite'),db=new DatabaseSync(working,{readOnly:true});let original;
 try{db.exec('PRAGMA query_only=ON; BEGIN');original=inspect(db);await sqliteBackup(db,snapshot);db.exec('COMMIT');}catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}finally{db.close();}
 const copy=new DatabaseSync(snapshot,{readOnly:true});let checked;try{checked=inspect(copy);}finally{copy.close();}if(JSON.stringify(original)!==JSON.stringify(checked))throw Error('Controller standalone snapshot differs');
 const after=await sourceFiles(source);if(JSON.stringify(sourceSummary(before))!==JSON.stringify(sourceSummary(after))||controllerFence.verifySync()!==true)throw Error('Controller source or fence changed');
 const snapshotBytes=await stableEvidenceRead(await safeEvidencePath(snapshot,false),256*1024*1024),manifest=Buffer.from(JSON.stringify({version:1,controllerRecordSha256:controllerFence.recordSha256,source:sourceSummary(before),snapshotSha256:sha(snapshotBytes),schemaSha256:checked.schemaSha256,counts:checked.counts})+'\n');await write(join(directory,'manifest.json'),manifest);
 if(controllerFence.verifySync()!==true||!verifyPrivateCutoverAcl(directory,false))throw Error('Pre-open fence or privacy changed');return Object.freeze({directory,snapshot,manifestSha256:sha(manifest),snapshotSha256:sha(snapshotBytes),controllerRecordSha256:controllerFence.recordSha256,counts:checked.counts,schemaSha256:checked.schemaSha256});
}

// Re-open a previously completed private pre-open snapshot for inclusion in
// the final backup. It does not touch the original Controller database.
export function openControllerPreopenEvidence({directory,manifestSha256,controllerRecordSha256}){
 const root=resolve(directory??''),allowed=new Set(['controller.db','controller.db-wal','controller.db-shm','controller.db.provision']);
 if(!isAbsolute(directory??'')||!/^[a-f0-9]{64}$/.test(manifestSha256??'')||!/^[a-f0-9]{64}$/.test(controllerRecordSha256??''))throw Error('Pre-open evidence identity differs');
 function read(path,limit){const item=lstatSync(path,{bigint:true});if(!item.isFile()||item.isSymbolicLink()||item.nlink!==1n||item.size>BigInt(limit))throw Error('Pre-open file is unsafe');const bytes=readFileSync(path),after=lstatSync(path,{bigint:true});if(['dev','ino','size','mtimeNs','ctimeNs'].some(k=>item[k]!==after[k]))throw Error('Pre-open file changed');return bytes;}
 function collect(){if(resolve(realpathSync(root)).toLowerCase()!==root.toLowerCase()||!verifyPrivateCutoverAcl(root,false))throw Error('Pre-open evidence is not private');const manifest=read(join(root,'manifest.json'),2*1024*1024);if(sha(manifest)!==manifestSha256)throw Error('Pre-open manifest differs');const data=JSON.parse(manifest);if(data.version!==1||data.controllerRecordSha256!==controllerRecordSha256||!Array.isArray(data.source)||!data.source.some(x=>x.name==='controller.db')||new Set(data.source.map(x=>x.name)).size!==data.source.length||data.source.some(x=>!allowed.has(x.name)||!Number.isSafeInteger(x.bytes)||x.bytes<0||!/^[a-f0-9]{64}$/.test(x.sha256??'')))throw Error('Pre-open manifest is invalid');const files=[{name:'manifest.json',bytes:manifest}],snapshot=read(join(root,'snapshot.sqlite'),256*1024*1024);if(sha(snapshot)!==data.snapshotSha256)throw Error('Pre-open snapshot differs');files.push({name:'snapshot.sqlite',bytes:snapshot});for(const item of data.source){const bytes=read(join(root,'raw',item.name),256*1024*1024);if(bytes.length!==item.bytes||sha(bytes)!==item.sha256)throw Error('Pre-open raw copy differs');files.push({name:'raw/'+item.name,bytes});}return files;}
 collect();return Object.freeze({manifestSha256,controllerRecordSha256,assertStableSync(){try{collect();return true;}catch{return false;}},async copySource(){return collect();}});
}
