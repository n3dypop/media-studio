import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,readdirSync,lstatSync,rmSync} from 'node:fs';
import {resolve,join,sep} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const hash=x=>createHash('sha256').update(x).digest('hex');

test('read-only preflight pins explicit installation and never enables cutover',{skip:process.platform!=='win32'||process.env.DSH_RUN_PROCESS_EVIDENCE_FIXTURE!=='1',timeout:90000},t=>{
 const base=resolve(import.meta.dirname,'../../runtime/cache'),fixture=mkdtempSync(join(base,'cutover-readiness-')),runtimeBase=join(fixture,'.runtime'),namespace=join(runtimeBase,'plugins/n3dypop'),install=join(namespace,'media-studio'),maint=join(install,'scripts/maintenance'),root=join(runtimeBase,'media-studio'),settings=join(root,'runtime/maintenance');mkdirSync(maint,{recursive:true});mkdirSync(settings,{recursive:true});
 t.after(()=>{assert.ok(resolve(fixture).startsWith(base+sep));const walk=p=>{const item=lstatSync(p);assert.equal(item.isSymbolicLink(),false);if(item.isDirectory())for(const name of readdirSync(p))walk(join(p,name));};walk(fixture);rmSync(fixture,{recursive:true,force:true});});
 for(const name of ['Invoke-WebSearchCutover.ps1','ApprovedNode.ps1','Test-WebCutoverReadiness.ps1','Verify-WebHostOwner.ps1'])copyFileSync(resolve(import.meta.dirname,'../scripts/maintenance',name),join(maint,name));
 const wrapper=join(maint,'Invoke-WebSearchCutover.ps1'),helper=join(maint,'Verify-WebHostOwner.ps1'),args=['-NoLogo','-NoProfile','-NonInteractive','-File',wrapper,'-RuntimeRoot',root,'-NodeExecutable',process.execPath,'-Mode','web','-ReadinessOnly'],run=()=>spawnSync('pwsh.exe',args,{encoding:'utf8',windowsHide:true,timeout:30000});
 let result=run();assert.equal(result.status,0,result.stderr);let report=JSON.parse(result.stdout);assert.equal(report.dynamicReadiness,'unconfirmed');assert.equal(report.manifest,'unavailable');assert.deepEqual(readdirSync(settings),[]);
 writeFileSync(join(settings,'approved-node.json'),JSON.stringify({path:process.execPath,sha256:hash(readFileSync(process.execPath))}));writeFileSync(join(settings,'approved-host-helper.json'),JSON.stringify({path:helper,sha256:hash(readFileSync(helper))}));
 writeFileSync(join(maint,'WebCutoverHostFence.ps1'),'fixture content');const pins={wrapper:hash(readFileSync(wrapper)),hostVerifier:hash(readFileSync(helper)),hostFence:'0'.repeat(64),entry:'0'.repeat(64),observer:'0'.repeat(64)},manifest=join(settings,'approved-cutover-components.json');writeFileSync(manifest,JSON.stringify({version:1,runtimeRoot:root,pins}));const before=readdirSync(settings).sort();
 result=run();assert.equal(result.status,0,result.stderr);report=JSON.parse(result.stdout);assert.equal(report.dynamicReadiness,'unconfirmed');assert.equal(report.manifest,'checked');assert.equal(report.components.find(x=>x.name==='wrapper').status,'matched');assert.equal(report.components.find(x=>x.name==='hostVerifier').status,'matched');assert.equal(report.components.find(x=>x.name==='hostFence').status,'hash-differs');assert.equal(report.components.find(x=>x.name==='entry').status,'unavailable');assert.ok(report.checksRequired.includes('live-host-route'));assert.deepEqual(readdirSync(settings).sort(),before);
 writeFileSync(manifest,JSON.stringify({version:1,runtimeRoot:join(fixture,'other'),pins}));result=run();assert.notEqual(result.status,0);assert.match(result.stderr,/manifest identity differs/);assert.deepEqual(readdirSync(settings).sort(),before);
});
