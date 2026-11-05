import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,readFileSync,readdirSync,rmSync,writeFileSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve,sep} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('launcher skips absent/disabled search, validates configured search before other services, and never treats broken config as disabled',{skip:process.platform!=='win32'},t=>{
  const base=resolve(tmpdir()),root=mkdtempSync(join(base,'media-search-launch-'));
  t.after(()=>{const path=resolve(root);assert.ok(path.startsWith(base+sep)&&path!==base);const visit=p=>{const s=lstatSync(p);assert.ok(!s.isSymbolicLink());if(s.isDirectory())for(const n of readdirSync(p))visit(join(p,n));};visit(path);rmSync(path,{recursive:true,force:true});});
  for(const name of ['config','scripts'])mkdirSync(join(root,name));
  const source=fileURLToPath(new URL('../scripts/Start-Studio.ps1',import.meta.url));
  copyFileSync(source,join(root,'scripts/Start-Studio.ps1'));
  const fake=`param([string]$Service,[switch]$ValidateOnly)\nAdd-Content -LiteralPath $env:MEDIA_SEARCH_TRACE -Value ((Split-Path -Leaf $PSCommandPath)+':'+$Service+':'+[string]$ValidateOnly)\nif($env:MEDIA_SEARCH_FAIL -eq '1' -and (Split-Path -Leaf $PSCommandPath) -eq 'Start-RustXNG.ps1'){throw 'fixture preflight failure'}\n`;
  for(const file of ['Start-Environment.ps1','Start-Strata.ps1','Start-RustXNG.ps1','Start-Controller.ps1'])writeFileSync(join(root,'scripts',file),fake);
  writeFileSync(join(root,'config/strata.json'),JSON.stringify({enabled:true}));
  const trace=join(root,'trace.txt'),env={...process.env,MEDIA_STUDIO_HOME:root,MEDIA_SEARCH_TRACE:trace};
  const execute=(config,fail=false)=>{writeFileSync(trace,'');const path=join(root,'config/rustxng.json');if(config===undefined){try{rmSync(path);}catch(e){if(e.code!=='ENOENT')throw e;}}else writeFileSync(path,typeof config==='string'?config:JSON.stringify(config));const child=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-File',join(root,'scripts/Start-Studio.ps1'),'-ValidateOnly'],{env:{...env,MEDIA_SEARCH_FAIL:fail?'1':'0'},encoding:'utf8',windowsHide:true,timeout:20000});return {status:child.status,lines:readFileSync(trace,'utf8').trim().split(/\r?\n/).filter(Boolean)};};
  for(const config of [undefined,{enabled:false}]){const result=execute(config);assert.equal(result.status,0);assert.equal(result.lines.length,4);assert.ok(result.lines.every(x=>!x.includes('RustXNG')));}
  for(const config of ['{broken',{enabled:'true'},null]){const result=execute(config);assert.notEqual(result.status,0);assert.equal(result.lines.length,0);}
  let result=execute({enabled:true},true);assert.notEqual(result.status,0);assert.equal(result.lines.length,1);assert.match(result.lines[0],/Start-RustXNG/);
  result=execute({enabled:true});assert.equal(result.status,0);assert.equal(result.lines.length,6);assert.match(result.lines[0],/Start-RustXNG/);
});
