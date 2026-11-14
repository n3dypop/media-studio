import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {readEngineSettings,saveEngineSettings,validateEngineSettings} from '../apps/dsh-plugins/studio-services/engine-settings.mjs';
import {engineSettingsHandler} from '../apps/dsh-plugins/studio-services/index.mjs';
import {applyEngineUpdate,checkEngineUpdate} from '../apps/dsh-plugins/studio-services/engine-updates.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'media-engine-settings-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const product=join(root,'product'),config=join(product,'.runtime/local-serve/serve-config.json');
  const receipt=join(root,'data/strata/installation.json'),env=join(root,'config/environment.json');
  for(const folder of ['config','data/strata','product/.runtime/local-serve','runtime'])await mkdir(join(root,folder),{recursive:true});
  const source={model_name:'fixture',args:['--native','weights.gguf','--max-context','32768','--prefill','512','--resident-budget-gib','20','--vram-reserve-mib','3072','--vision'],vision:{threads:8}};
  const bytes=JSON.stringify(source);
  await writeFile(config,bytes);
  await writeFile(receipt,JSON.stringify({prepared:true,schemaVersion:1,workspace:root,productRoot:product,model:'fixture',config,configSha256:sha(bytes)}));
  await writeFile(env,JSON.stringify({comfyPort:8189,unrelated:true}));
  return {root,config,receipt,env,source};
}

test('Strata settings update the product config and its receipt and preserve unrelated flags',async t=>{
  const f=await fixture(t),current=await readEngineSettings(f.root,'Strata');
  await saveEngineSettings(f.root,'Strata',{expectedRevision:current.revision,values:{...current.values,prefill:'1024'}});
  const next=await readEngineSettings(f.root,'Strata');
  assert.deepEqual(next.values,{...current.values,prefill:'1024'});
  assert.deepEqual(next.config.value,{...f.source,args:f.source.args.map(value=>value==='512'?'1024':value)});
  assert.equal(next.receipt.value.configSha256,sha(await readFile(f.config)));
  await assert.rejects(saveEngineSettings(f.root,'Strata',{expectedRevision:current.revision,values:current.values}),{status:409});
  assert.equal((await readdir(join(f.root,'data/maintenance/engine-settings'))).length,1);
  await writeFile(f.config,JSON.stringify(f.source));
  await assert.rejects(readEngineSettings(f.root,'Strata'),{status:409});
});

test('ComfyUI persists only normalised tuning values and rejects injected arguments',async t=>{
  const f=await fixture(t),current=await readEngineSettings(f.root,'ComfyUI');
  const values={...current.values,memoryMode:'low',reserveGiB:1.25};
  await assert.rejects(saveEngineSettings(f.root,'ComfyUI',{expectedRevision:current.revision,values:{...values,previewMethod:'--listen'}}),{status:400});
  assert.throws(()=>validateEngineSettings('ComfyUI',{...values,reserveGiB:'1.25'}),{status:400});
  await saveEngineSettings(f.root,'ComfyUI',{expectedRevision:current.revision,values});
  assert.deepEqual(JSON.parse(await readFile(f.env)),{comfyPort:8189,unrelated:true,comfyTuning:values});
});

test('Strata optional tuning adds and removes only supported settings',async t=>{
  const f=await fixture(t),initial=await readEngineSettings(f.root,'Strata');
  assert.equal(initial.values.kv,null);
  assert.equal(initial.values.espEnabled,null);
  const changed={...initial.values,kv:'k8v4',poolWorkers:6,conversationCacheMiB:1024,conversationCacheSlots:2,visionThreads:4,visionTokens:512};
  await assert.rejects(saveEngineSettings(f.root,'Strata',{expectedRevision:initial.revision,values:{...changed,kv:'--listen'}}),{status:400});
  await assert.rejects(saveEngineSettings(f.root,'Strata',{expectedRevision:initial.revision,values:{...changed,espEnabled:true}}),{status:400});
  await saveEngineSettings(f.root,'Strata',{expectedRevision:initial.revision,values:changed});
  const saved=await readEngineSettings(f.root,'Strata');
  assert.deepEqual(saved.values,changed);
  assert.deepEqual(saved.config.value.args,[...f.source.args,'--kv','k8v4','--pool-workers','6','--conversation-cache-mib','1024','--conversation-cache-slots','2']);
  const {context,prefill,residentGiB,reserveMiB}=saved.values;
  await saveEngineSettings(f.root,'Strata',{expectedRevision:saved.revision,values:{context,prefill:'768',residentGiB,reserveMiB}});
  const legacy=await readEngineSettings(f.root,'Strata');
  assert.deepEqual(legacy.values,{...changed,prefill:'768'});
  await saveEngineSettings(f.root,'Strata',{expectedRevision:legacy.revision,values:initial.values});
  assert.deepEqual((await readEngineSettings(f.root,'Strata')).config.value,f.source);
});

test('settings route permits authenticated same-origin writes and projects pending settings without changing the running record',async t=>{
  const f=await fixture(t),current=await readEngineSettings(f.root,'Strata');
  const record=join(f.root,'runtime/Strata.json');
  await writeFile(record,JSON.stringify({configSha256:current.launchRevision}));
  const adapter={snapshot:async()=>({services:[{id:'Strata',state:'running'}]})};
  const handler=engineSettingsHandler({root:f.root,adapter,manager:adapter,dshOrigin:'http://127.0.0.1:3080',writer:saveEngineSettings});
  const origin='http://127.0.0.1:3080',url=origin+'/api/local-studio/engine-settings?engine=Strata';
  const request=source=>new Request(url,{method:'POST',headers:{origin:source,'content-type':'application/json','x-local-studio-service-settings':'1'},body:JSON.stringify({expectedRevision:current.revision,values:{...current.values,prefill:'1024'}})});
  assert.equal((await handler(request('http://example.invalid'))).status,403);
  const result=await handler(request(origin));
  assert.equal(result.status,200);
  assert.equal((await result.json()).runningMatches,false);
  assert.equal(JSON.parse(await readFile(record)).configSha256,current.launchRevision);
});

test('ComfyUI applies only the reviewed official commit with compatible local dependencies',async t=>{
  const {root,env}=await fixture(t),directory=join(root,'comfy'),python=join(directory,'python.exe');
  await mkdir(directory);
  await writeFile(join(directory,'comfyui_version.py'),'__version__ = "1.2.3"\n');
  await writeFile(python,'synthetic executable');
  await writeFile(env,JSON.stringify({comfyDirectory:directory,comfyPythonExecutable:python}));
  const before='1'.repeat(40),target='2'.repeat(40),tag='v1.2.4',official='https://github.com/Comfy-Org/ComfyUI.git';
  const fetcher=async url=>{assert.equal(url,'https://api.github.com/repos/Comfy-Org/ComfyUI/releases/latest');return Response.json({tag_name:tag});};
  let head=before,mismatch=['torch'];
  const run=async (file,args)=>{
    if(file===python)return {stdout:args.includes('pip')?'':JSON.stringify(mismatch)};
    assert.equal(file,'git.exe');
    const [verb,...operands]=args.slice(6);
    switch(verb){
      case 'remote': return {stdout:official};
      case 'ls-remote': return {stdout:target+'\trefs/tags/'+tag};
      case 'status': case 'merge-base': return {stdout:''};
      case 'rev-parse': return {stdout:operands[0]==='HEAD'?head:target};
      case 'fetch': assert.deepEqual(operands,['--no-tags',official,'refs/tags/'+tag]);return {stdout:''};
      case 'show': return {stdout:operands[0].endsWith(':requirements.txt')?'torch>=2':'__version__="1.2.4"'};
      case 'merge': assert.deepEqual(operands,['--ff-only','--no-edit',target]);head=target;return {stdout:''};
      default: assert.fail('Unexpected Git command '+verb);
    }
  };
  const options={run,fetcher};
  const offer=await checkEngineUpdate(root,'ComfyUI',options);
  assert.deepEqual(offer,{installed:'1.2.3',available:tag,canUpdate:true,identity:target});
  await assert.rejects(applyEngineUpdate(root,'ComfyUI',before,options),{status:409});
  await assert.rejects(applyEngineUpdate(root,'ComfyUI',target,options),/Python依存関係/);
  assert.equal(head,before);
  mismatch=[];
  await applyEngineUpdate(root,'ComfyUI',target,options);
  assert.equal(head,target);
});
