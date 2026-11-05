import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,lstat,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {checkPackage,pluginSets} from '../scripts/check-package.mjs';

const root=resolve(import.meta.dirname,'..');
const json=async path=>JSON.parse(await readFile(join(root,path),'utf8'));
const text=path=>readFile(join(root,path),'utf8');
const metadata=await json('package.json'),ids=pluginSets[metadata.name];

test('public package contains only local source, operational docs and permitted assets',async()=>{
  const result=await checkPackage({root,syntax:false});assert.equal(result.name,metadata.name);assert.equal(result.plugins,metadata.name.endsWith('/dsh-plugins')?4:6);assert.ok(result.modules>0);
});
test('root metadata uses the documented dependency-free checks and publication boundary',()=>{
  assert.equal(metadata.private,true);assert.equal(metadata.license,'MIT');assert.equal(metadata.type,'module');assert.equal(metadata.engines?.dsh,'0.2.2-rc.1');assert.equal(metadata.scripts.check,'node scripts/check-package.mjs');assert.equal(metadata.scripts.test,'node --test --test-concurrency=1 tests/*.test.mjs');assert.ok(ids);
});
test('plugin manifests expose their local host and web client entries consistently',async()=>{
  const actual=[];for(const entry of await readdir(join(root,'apps/dsh-plugins'),{withFileTypes:true})){if(!entry.isDirectory()||entry.name==='shared')continue;try{await lstat(join(root,'apps/dsh-plugins',entry.name,'package.json'));actual.push(entry.name);}catch(error){if(error.code!=='ENOENT')throw error;}}
  assert.deepEqual(actual.sort(),[...ids].sort());
  for(const id of ids){
    const prefix='apps/dsh-plugins/'+id+'/',manifest=await json(prefix+'package.json');
    assert.equal(manifest.private,true,id);assert.equal(manifest.type,'module',id);assert.equal(manifest.engines?.dsh,id==='local-genai'?'0.2.2-rc.1':'0.2.1-rc.5 || 0.2.2-rc.1',id);
    const host=typeof manifest.exports==='string'?manifest.exports:manifest.exports?.['.']??manifest.main;
    assert.ok(['./index.mjs','index.mjs'].includes(host),id);assert.match(await text(prefix+'index.mjs'),/\bexport\s+(?:const\s+name|(?:async\s+)?function\s+apply)\b/,id);
    if(id==='local-genai')continue;
    assert.equal(manifest.exports?.['./client'],'./client.js',id);assert.equal(manifest.dsh?.client?.platform,'web',id);assert.match(await text(prefix+'client.js'),/__ModuleLoader__\.load\s*\(/,id);
  }
});
test('bundle lists each public plugin once and leaves configuration-dependent entries disabled',async()=>{
  const bundle=await text('dsh.bundle.patch.yml');
  for(const id of ids){const expression=new RegExp('^\\s*(?:-\\s*)?id:\\s*["\\\']?'+id+'["\\\']?\\s*$','gm');assert.equal([...bundle.matchAll(expression)].length,1,id);}
  const blocks=bundle.split(/(?=^\s*-?\s*id:\s*)/m);
  for(const id of metadata.name.endsWith('/dsh-plugins')?['studio-host','studio-sessions']:ids){const block=blocks.find(value=>new RegExp('^\\s*(?:-\\s*)?id:\\s*["\\\']?'+id+'["\\\']?\\s*$','m').test(value));assert.ok(block,id);assert.match(block,/^\s*disabled:\s*true\s*$/m,id);}
  if(metadata.name.endsWith('/media-studio')){const block=blocks.find(value=>/^\s*(?:-\s*)?id:\s*["']?local-genai-gateway["']?\s*$/m.test(value));assert.ok(block,'gateway entry');assert.match(block,/^\s*disabled:\s*true\s*$/m);assert.match(block,/gateway\.mjs/);}
});
test('runtime configuration helper validates an explicit private root without opening it',async()=>{
  const helper=join(root,'apps/dsh-plugins/shared/plugin-config.mjs');
  try{await lstat(helper);}catch(error){if(error.code==='ENOENT')return;throw error;}
  const {runtimeRootOf,createRuntimeConfig}=await import(pathToFileURL(helper).href),home=resolve(tmpdir(),'public-plugin-contract-runtime');
  assert.equal(runtimeRootOf({runtimeRoot:home}),home);
  for(const value of [undefined,{},null,{runtimeRoot:'relative'},{runtimeRoot:'https://invalid.example/runtime'},{runtimeRoot:' '+home}])assert.throws(()=>runtimeRootOf(value));
  const schema=createRuntimeConfig(),valid=schema['~standard'].validate({runtimeRoot:home}),invalid=schema['~standard'].validate({runtimeRoot:'relative'});
  assert.equal(valid.value.runtimeRoot,home);assert.ok(Array.isArray(invalid.issues)&&invalid.issues.length>0);
});
test('media tools and Skills are Agent-preset children while provider examples retain the managed route',async()=>{
  const bundle=await text('dsh.bundle.patch.yml'),lines=bundle.split(/\r?\n/),entries=[];
  for(let index=0;index<lines.length;index++){
    const match=/^( *)- id: ([-a-z0-9]+)\s*$/.exec(lines[index]);if(match)entries.push({id:match[2],indent:match[1].length,line:index});
  }
  for(const entry of entries){const end=entries.find(next=>next.line>entry.line&&next.indent<=entry.indent)?.line??lines.length;entry.body=lines.slice(entry.line,end).join('\n');}
  const one=id=>{const selected=entries.filter(entry=>entry.id===id);assert.equal(selected.length,1,id);return selected[0];};
  const preset=one('preset-local-image'),managed=one('local-genai');
  assert.match(preset.body,/name: ['"]?@deepseek-ai\/dsh-agent-preset['"]?\s*$/m);
  assert.match(preset.body,new RegExp('^ {'+(preset.indent+4)+'}id: local-image\\s*$','m'));
  assert.match(preset.body,new RegExp('^ {'+(preset.indent+4)+'}name: media-studio\\s*$','m'));
  assert.match(preset.body,new RegExp('^ {'+(preset.indent+2)+'}disabled: true\\s*$','m'));
  assert.ok(managed.indent>preset.indent);assert.ok(preset.body.includes(managed.body));
  assert.match(managed.body,/^\s*role: studio\s*$/m);assert.match(managed.body,/^\s*controllerUrl: http:\/\/127\.0\.0\.1:\d+\s*$/m);assert.match(managed.body,/^\s*tokenFile: data\/controller\/dsh-token\s*$/m);
  assert.equal(one('local-genai-gateway').indent,preset.indent);
  assert.match(one('local-ask-user').body,/@deepseek-ai\/dsh-tool-ask-user/);
  const compaction=one('media-studio-compaction'),skills=one('media-studio-skills');
  assert.ok(preset.body.includes(compaction.body));assert.match(compaction.body,/^\s*compaction: true\s*$/m);assert.match(compaction.body,/@deepseek-ai\/dsh-compaction-basic/);
  assert.ok(preset.body.includes(skills.body));assert.match(skills.body,/^\s*skills: true\s*$/m);assert.match(skills.body,/@deepseek-ai\/dsh-skill['"]?\s*$/m);assert.match(skills.body,/apps\/dsh-plugins\/local-genai\/skills\.mjs/);assert.match(skills.body,/@deepseek-ai\/dsh-tool-skill/);
  for(const match of bundle.matchAll(/^\s*name: (\.\/[^\s]+)\s*$/gm))assert.equal((await lstat(resolve(root,match[1]))).isFile(),true,match[1]);
  const provider=await text('examples/model-provider.patch.example.yml');
  assert.match(provider,/^\s*local-strata:\s*$/m);assert.match(provider,/^\s*- id: strata-core\s*$/m);assert.match(provider,/^\s*displayName: Strata\s*$/m);assert.match(provider,/^\s*apiKeyEnv: MEDIA_STUDIO_DSH_TOKEN\s*$/m);assert.match(provider,/http:\/\/127\.0\.0\.1:\d+\/v1/);assert.doesNotMatch(provider,/^\s*apiKey:\s*\S+/m);
});
