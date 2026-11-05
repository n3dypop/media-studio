// Retire old source only after its owning process generation has gone away.
// This never terminates a process, deletes data or follows filesystem links.
import {readFile,writeFile,readdir,lstat,mkdir,rename} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute,dirname} from 'node:path';
import {createHash} from 'node:crypto';
const at=process.argv.indexOf('--root');if(at<0||!process.argv[at+1]||!isAbsolute(process.argv[at+1]))throw Error('--root requires an absolute private runtime directory');
const root=resolve(process.argv[at+1]),path=join(root,'data/plugin-migration/retirement.json');
async function safe(target){const rel=relative(root,target);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('Retirement path escaped the private runtime');let current=root;for(const part of['',...rel.split(/[\\/]/).filter(Boolean)]){if(part)current=join(current,part);try{if((await lstat(current)).isSymbolicLink())throw Error('Linked retirement path refused');}catch(error){if(error.code==='ENOENT')return;throw error;}}}
await safe(path);const ledger=JSON.parse(await readFile(path,'utf8'));
if(ledger.schemaVersion!==1||resolve(ledger.root)!==root||!Array.isArray(ledger.retained)||!ledger.epochs)throw Error('Invalid source retirement ledger');
// The old Japanese shim is retained only as an allowed historical retirement
// path. It is not a current plugin and cannot be installed by this script.
const allowed=new Set(['local-genai','media-results','studio-controls','studio-preset','studio-monitor','studio-services','studio-appearance','studio-image-viewer','studio-japanese','studio-sessions','studio-host'].map(id=>'apps/dsh-plugins/'+id).concat(['apps/media-studio-controller','apps/search-bridge']));
function present(epoch){if(!Number.isSafeInteger(epoch?.pid)||epoch.pid<1)throw Error('Missing original process identity');try{process.kill(epoch.pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}}
const blocked={};for(const [name,epoch]of Object.entries(ledger.epochs))blocked[name]=present(epoch);
async function fingerprint(base){const files=[];async function walk(directory){for(const name of await readdir(directory)){const full=join(directory,name),stat=await lstat(full);if(stat.isSymbolicLink())throw Error('Linked retained source refused');if(stat.isDirectory())await walk(full);else files.push([relative(base,full).replaceAll('\\','/'),createHash('sha256').update(await readFile(full)).digest('hex')]);}}await walk(base);return JSON.stringify(files.sort((a,b)=>a[0].localeCompare(b[0])));}
let mutations=0;
async function complete(entry,archive){entry.retiredAt=new Date().toISOString();entry.archive=relative(root,archive).replaceAll('\\','/');await writeFile(path+'.partial',JSON.stringify(ledger,null,2)+'\n');await rename(path+'.partial',path);mutations++;}
const results=[];
for(const entry of ledger.retained){if(!allowed.has(entry.path)||!Array.isArray(entry.files))throw Error('Unrecognized retained source path');if(entry.retiredAt){results.push({path:entry.path,state:'archived'});continue;}
  const owner=entry.path.startsWith('apps/dsh-plugins/')?'DSH':'Controller';if(!Object.hasOwn(blocked,owner)||blocked[owner]){results.push({path:entry.path,state:'waiting-for-original-process-exit'});continue;}
  const target=join(root,entry.path),archive=join(root,'docs/archives/plugin-source-'+ledger.createdAt.replaceAll(/[:.]/g,'-'),entry.path);await safe(target);await safe(archive);const expected=JSON.stringify([...entry.files].sort((a,b)=>a[0].localeCompare(b[0])));
  let moved=false;try{await lstat(target);}catch(error){if(error.code!=='ENOENT')throw error;moved=true;}
  // Recover a rename that completed before the ledger commit. Verify every
  // archived byte before treating the missing original as a successful move.
  if(moved){if(await fingerprint(archive)!==expected)throw Error('Interrupted retirement archive differs');if(process.argv.includes('--apply')){if(present(ledger.epochs[owner]))throw Error('Original process identity is present again');await complete(entry,archive);}results.push({path:entry.path,state:process.argv.includes('--apply')?'archived':'ready-to-finish-ledger'});continue;}
  if(await fingerprint(target)!==expected)throw Error('Retained source changed; manual review is required');
  if(!process.argv.includes('--apply')){results.push({path:entry.path,state:'ready-to-archive'});continue;}
  // Recheck immediately before the atomic move. PID reuse blocks conservatively.
  if(present(ledger.epochs[owner]))throw Error('Original process identity is present again');
  await mkdir(dirname(archive),{recursive:true});await rename(target,archive);await complete(entry,archive);results.push({path:entry.path,state:'archived'});
}
console.log(JSON.stringify({changed:mutations>0,retained:results.filter(row=>row.state==='waiting-for-original-process-exit').length,ready:results.filter(row=>['ready-to-archive','ready-to-finish-ledger'].includes(row.state)).length,archived:results.filter(row=>row.state==='archived').length}));
