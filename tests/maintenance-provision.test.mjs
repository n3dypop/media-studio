import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,copyFile,readFile,rm} from 'node:fs/promises';
import {spawn,spawnSync} from 'node:child_process';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
const source=resolve(import.meta.dirname,'../scripts');
test('approval provisioning holds while recorded DSH PID lives and refuses an existing approval',{skip:process.platform!=='win32',timeout:30000},async t=>{
 const base=resolve(tmpdir()),root=await mkdtemp(join(base,'maintenance-provision-')),dir=join(root,'installation/scripts/maintenance');await mkdir(dir,{recursive:true});await mkdir(join(root,'runtime'),{recursive:true});
 for(const name of ['Initialize-HostMaintenance.ps1','Verify-WebHostOwner.ps1','Invoke-WebSearchCutover.ps1'])await copyFile(join(source,'maintenance',name),join(dir,name));await copyFile(join(source,'DshLaunchLock.ps1'),join(root,'installation/scripts/DshLaunchLock.ps1'));
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'}),done=new Promise(ok=>child.once('exit',ok));t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await done;assert.ok(root.startsWith(base+sep));await rm(root,{recursive:true,force:true});});
 await writeFile(join(root,'runtime/DSH.json'),JSON.stringify({service:'DSH',processId:child.pid}));const run=()=>spawnSync('pwsh',['-NoLogo','-NoProfile','-NonInteractive','-File',join(dir,'Initialize-HostMaintenance.ps1'),'-RuntimeRoot',root],{env:{...process.env,LOCALAPPDATA:join(root,'local-app-data')},encoding:'utf8',windowsHide:true,timeout:20000});let result=run();assert.notEqual(result.status,0);await assert.rejects(readFile(join(root,'runtime/maintenance/approved-host-helper.json')));
 child.kill();await done;result=run();assert.equal(result.status,0,result.stderr||result.stdout);const approved=JSON.parse(await readFile(join(root,'runtime/maintenance/approved-host-helper.json'),'utf8')),policy=JSON.parse(await readFile(join(root,'runtime/maintenance/route-policy.json'),'utf8'));assert.match(approved.sha256,/^[a-f0-9]{64}$/);assert.match(policy.wrapperSha256,/^[a-f0-9]{64}$/);result=run();assert.notEqual(result.status,0);
});
