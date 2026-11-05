import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,lstatSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {readExternalPrompt} from '../apps/controller/external-prompts.mjs';
import {buildMossPromptEnhancer} from '../apps/controller/moss-prompt-enhancer.mjs';
import {buildQwenPromptEnhancer} from '../apps/controller/qwen21-prompt-enhancer.mjs';
import {MossPeCoordinator} from '../apps/controller/moss-pe-controller.mjs';
import {installExternalPrompts} from '../scripts/install-external-prompts.mjs';

test('missing, relative and modified private official prompts never become usable',async()=>{
  const previous=process.env.MEDIA_STUDIO_HOME;
  const parent=resolve(tmpdir()),root=mkdtempSync(join(parent,'external-prompts-'));
  try{
    delete process.env.MEDIA_STUDIO_HOME;
    assert.throws(()=>buildMossPromptEnhancer({prompt:'Test',seed:'42'}),/MEDIA_STUDIO_HOME/);
    process.env.MEDIA_STUDIO_HOME='relative/path';
    assert.throws(()=>buildMossPromptEnhancer({prompt:'Test',seed:'42'}),/absolute/);
    process.env.MEDIA_STUDIO_HOME=root;
    assert.throws(()=>readExternalPrompt('moss','t2i'),/unavailable/);
    assert.throws(()=>buildQwenPromptEnhancer({mode:'t2i',prompt:'Test',seed:'42'}),/unavailable/);
    assert.throws(()=>readExternalPrompt('qwen','unsupported'),/Unsupported/);
    const path=join(root,'external/comfy-workflow-templates/workflows/source/moss-image');
    mkdirSync(path,{recursive:true});writeFileSync(join(path,'official-t2i-enhancer-system.txt'),'modified');
    assert.throws(()=>buildMossPromptEnhancer({prompt:'Test',seed:'42'}),/hash mismatch/);
    let requests=0;
    const common={store:{},productions:{},adapter:{request:async()=>{requests++;return {};}},gate:{},verifyEpoch:async()=>({})};
    const moss=new MossPeCoordinator(common),qwen=new MossPeCoordinator({...common,family:'qwen',licenseCheck:async()=>true});
    assert.equal((await moss.availability()).available,false);
    assert.equal((await qwen.availability()).available,false);
    moss.syncCancellation=()=>({phase:'queued',cancelRequested:false,spec:{}});
    qwen.syncCancellation=()=>({phase:'queued',cancelRequested:false,spec:{peMode:'t2i'}});
    await assert.rejects(moss.execute('synthetic-run'),/hash mismatch/);
    await assert.rejects(qwen.execute('synthetic-run'),/unavailable/);
    assert.equal(requests,0,'missing or altered prompt must fail before network calls');
  }finally{
    if(previous===undefined)delete process.env.MEDIA_STUDIO_HOME;else process.env.MEDIA_STUDIO_HOME=previous;
    const actual=resolve(root);
    if(!actual.startsWith(parent+sep)||lstatSync(actual).isSymbolicLink())throw Error('Unexpected temporary test root');
    rmSync(actual,{recursive:true,force:true});
  }
});

test('offline prompt importer rejects an unverified source before writing',()=>{
  const parent=resolve(tmpdir()),root=mkdtempSync(join(parent,'external-import-'));
  try{
    const source=join(root,'source'),runtime=join(root,'private-runtime');
    mkdirSync(source);mkdirSync(runtime);
    writeFileSync(join(source,'image_moss_image_t2i.json'),'incorrect upstream bytes');
    assert.throws(()=>installExternalPrompts({sourceDir:source,runtimeRoot:runtime}),/hash mismatch/);
    assert.throws(()=>lstatSync(join(runtime,'external')),/ENOENT/);
    assert.throws(()=>installExternalPrompts({sourceDir:source,runtimeRoot:fileURLToPath(new URL('../',import.meta.url))}),/must not be inside/);
  }finally{
    const actual=resolve(root);
    if(!actual.startsWith(parent+sep)||lstatSync(actual).isSymbolicLink())throw Error('Unexpected temporary test root');
    rmSync(actual,{recursive:true,force:true});
  }
});
