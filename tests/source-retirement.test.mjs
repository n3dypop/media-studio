import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,access,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
const script=fileURLToPath(new URL('../scripts/Finalize-PluginMigration.mjs',import.meta.url));
async function fixture(t,pid){const root=await mkdtemp(join(tmpdir(),'plugin-retirement-'));t.after(()=>rm(root,{recursive:true,force:true}));const relative='apps/dsh-plugins/studio-host',target=join(root,relative),bytes='export const fixture=true;\n';await mkdir(target,{recursive:true});await writeFile(join(target,'index.mjs'),bytes);const ledger={schemaVersion:1,root,createdAt:'2026-01-01T00:00:00.000Z',epochs:{DSH:{pid}},retained:[{path:relative,files:[['index.mjs',createHash('sha256').update(bytes).digest('hex')]]}]},path=join(root,'data/plugin-migration/retirement.json');await mkdir(dirname(path),{recursive:true});await writeFile(path,JSON.stringify(ledger));return{root,target,path,ledger};}
const run=async root=>JSON.parse((await promisify(execFile)(process.execPath,[script,'--root',root,'--apply'],{windowsHide:true})).stdout);
test('source still owned by a live process is retained without touching history',async t=>{const f=await fixture(t,process.pid),before=await readFile(f.path,'utf8'),result=await run(f.root);assert.equal(result.retained,1);assert.equal(result.changed,false);await access(f.target);assert.equal(await readFile(f.path,'utf8'),before);});
test('an interrupted verified archive move completes its ledger and replays idempotently',async t=>{const child=spawn(process.execPath,['-e',''],{windowsHide:true,stdio:'ignore'});await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});const f=await fixture(t,child.pid),archive=join(f.root,'docs/archives/plugin-source-2026-01-01T00-00-00-000Z',f.ledger.retained[0].path);await mkdir(dirname(archive),{recursive:true});await rename(f.target,archive);const result=await run(f.root);assert.equal(result.changed,true);assert.equal(result.archived,1);const saved=JSON.parse(await readFile(f.path,'utf8'));assert.ok(saved.retained[0].retiredAt);await access(join(archive,'index.mjs'));const again=await run(f.root);assert.equal(again.changed,false);assert.equal(again.archived,1);});
