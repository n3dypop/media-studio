import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,lstatSync,readdirSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {createControllerCutoverFence} from '../apps/controller/search/cutover-controller-fence.mjs';

const hash=x=>createHash('sha256').update(x).digest('hex');
test('Controller fence binds live identity, rejects stale evidence and retains the stopped port',{skip:process.platform!=='win32'||process.env.DSH_RUN_PROCESS_EVIDENCE_FIXTURE!=='1',timeout:60000},async t=>{
 const base=resolve(import.meta.dirname,'../../runtime/cache'),root=mkdtempSync(join(base,'cutover-controller-fence-')),controllerId=randomUUID(),child=spawn(process.execPath,['-e',`require('http').createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({service:'local-image-controller',ready:true,pid:process.pid,controllerId:process.env.FIXTURE_ID,activeRunId:null}))}).listen(0,'127.0.0.1',function(){console.log(this.address().port)});`],{env:{...process.env,FIXTURE_ID:controllerId},windowsHide:true,stdio:['ignore','pipe','pipe']});let fence;const exited=new Promise(ok=>child.once('exit',ok));
 t.after(async()=>{await fence?.close();if(child.exitCode===null&&child.signalCode===null)child.kill();await exited;assert.ok(resolve(root).startsWith(base+sep));const walk=p=>{const s=lstatSync(p);assert.equal(s.isSymbolicLink(),false);if(s.isDirectory())for(const n of readdirSync(p))walk(join(p,n));};walk(root);rmSync(root,{recursive:true,force:true});});
 const port=await new Promise((ok,fail)=>{child.stdout.once('data',x=>ok(Number(x.toString().trim())));child.once('error',fail);}),out=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',`$p=Get-Process -Id ${child.pid} -ErrorAction Stop; $p.StartTime.ToUniversalTime().Ticks.ToString()`],{encoding:'utf8',windowsHide:true});assert.equal(out.status,0,out.stderr);const ticks=out.stdout.trim(),record=Buffer.from(JSON.stringify({service:'Controller',processId:child.pid,startTimeUtcTicks:ticks,executable:process.execPath,url:`http://127.0.0.1:${port}`,controllerId})),current=join(root,'Controller.json'),preserved=join(root,'preserved.json');writeFileSync(current,record);writeFileSync(preserved,record);
 const args={recordPath:current,preservedRecordPath:preserved,recordSha256:hash(record),expectedExecutable:process.execPath,baseUrl:`http://127.0.0.1:${port}`,assertLaunchFence:()=>true};
 await assert.rejects(createControllerCutoverFence({...args,recordSha256:'0'.repeat(64)}),/hash differs/);const wrong=Buffer.from(JSON.stringify({...JSON.parse(record),startTimeUtcTicks:'638000000000000000'}));writeFileSync(current,wrong);writeFileSync(preserved,wrong);await assert.rejects(createControllerCutoverFence({...args,recordSha256:hash(wrong)}),/確認できません/);writeFileSync(current,record);writeFileSync(preserved,record);
 fence=await createControllerCutoverFence(args);await assert.rejects(fence.holdStopped(),/absence is unproven/);child.kill();await exited;await fence.holdStopped();assert.equal(fence.verifySync(),true);writeFileSync(preserved,Buffer.from('changed'));assert.equal(fence.verifySync(),false);
});
