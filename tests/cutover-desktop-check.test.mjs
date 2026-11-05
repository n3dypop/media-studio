import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,readdirSync,lstatSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
test('Desktop observation rejects the managed executable while running',{skip:process.platform!=='win32'||process.env.DSH_RUN_PROCESS_EVIDENCE_FIXTURE!=='1',timeout:45000},async t=>{
 const base=resolve(import.meta.dirname,'../../runtime/cache'),root=mkdtempSync(join(base,'desktop-observation-')),dir=join(root,'Programs/DeepSeek Harness'),exe=join(dir,'DeepSeek Harness.exe'),script=resolve(import.meta.dirname,'../scripts/maintenance/Confirm-DesktopStopped.ps1');mkdirSync(dir,{recursive:true});copyFileSync(process.execPath,exe);let child,done;t.after(async()=>{if(child&&child.exitCode===null&&child.signalCode===null){child.kill();await done;}assert.ok(resolve(root).startsWith(base+sep));const walk=p=>{const s=lstatSync(p);assert.equal(s.isSymbolicLink(),false);if(s.isDirectory())for(const n of readdirSync(p))walk(join(p,n));};walk(root);rmSync(root,{recursive:true,force:true});});
 child=spawn(exe,['-e',"console.log('fixture-ready');setInterval(()=>{},1000)"],{windowsHide:true,stdio:['ignore','pipe','ignore']});done=new Promise(ok=>child.once('exit',ok));await new Promise((ok,fail)=>{child.stdout.once('data',ok);child.once('error',fail)});const run=()=>spawnSync('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',script],{env:{...process.env,LOCALAPPDATA:root},encoding:'utf8',windowsHide:true,timeout:15000}),running=run();assert.notEqual(running.status,0);assert.match(running.stderr,/Desktop is running/);child.kill();await done;const stopped=run();assert.equal(stopped.status,0,stopped.stderr);
});
