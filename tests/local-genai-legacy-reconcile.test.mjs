// Canonical Controller/DSH code, actual workflow file, HTTP and SQLite with a
// frozen Comfy node schema. No actual ComfyUI job or user data are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {randomUUID,createHash} from 'node:crypto';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {openMutationJournal} from '../apps/dsh-plugins/local-genai/durable-journal.mjs';
import {runDurableOwnedMutation,reconcileDurableOwnedMutation} from '../apps/dsh-plugins/local-genai/durable-coordinator.mjs';
import {mossInputTemplate} from '../apps/controller/media-modes.mjs';
import {WorkflowRegistry} from '../apps/controller/workflows.mjs';
import {RunStore} from '../apps/controller/store.mjs';
import {ProductionStore} from '../apps/controller/productions.mjs';
import {createControllerServer} from '../apps/controller/http.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Small synthetic node contracts for the fixed fixture graph, not a copy of
// external ComfyUI metadata. They exist only to exercise the stored workflow.
function schemasFor(graph){
  const outputs={CLIPLoader:['CLIP'],UNETLoader:['MODEL'],VAELoader:['VAE'],CLIPTextEncode:['CONDITIONING'],EmptyFlux2LatentImage:['LATENT'],KSampler:['LATENT'],VAEDecode:['IMAGE'],SaveImage:[],LoadImage:['IMAGE','MASK'],ImageScale:['IMAGE'],VAEEncode:['LATENT']};
  const choices=new Set(['clip_name','unet_name','vae_name','type','device','sampler_name','scheduler','upscale_method','crop','image']);
  const result={};
  for(const node of Object.values(graph)){
    const schema=result[node.class_type]??={input:{required:{}},output:outputs[node.class_type],...(node.class_type==='SaveImage'?{output_node:true}:{})};
    for(const [name,value] of Object.entries(node.inputs)){
      if(Array.isArray(value))schema.input.required[name]=[outputs[graph[value[0]].class_type][value[1]]];
      else if(typeof value==='string')schema.input.required[name]=choices.has(name)?[[value]]:['STRING'];
      else if(typeof value==='boolean')schema.input.required[name]=['BOOLEAN'];
      else schema.input.required[name]=[Number.isInteger(value)?'INT':'FLOAT'];
    }
  }
  return result;
}
for(const scenario of ['t2i','i2i','i2i-custom','edit','enhanced'])test(`legacy ${scenario} response loss reconciles only proven owned saved evidence`,async t=>{
  const parent=resolve(tmpdir()),root=await mkdtemp(join(parent,'media-studio-legacy-http-'));assert.equal(root.startsWith(parent+sep),true);
  let file,hold,store,journal;
  t.after(async()=>{journal?.close();store?.close();assert.ok(root.startsWith(parent+sep));await rm(root,{recursive:true,force:true});});
  const profile='moss-image-sft-int8-v1',base=JSON.parse(await readFile('workflows/approved/moss-image-sft-int8-v1.json','utf8'));
  const mode=scenario==='edit'?'edit':scenario.startsWith('i2i')?'i2i':'t2i',id='11111111-1111-4111-8111-111111111111',sha256='a'.repeat(64),sessionPrefix=createHash('sha256').update('session').digest('hex').slice(0,24);
  const binding={id,purpose:'input',sha256,width:512,height:768,comfyInputName:`controller-assets/${sessionPrefix}/${id}-${sha256}.png`};
  const assets={get(key,session){assert.equal(key,id);assert.equal(session,'session');return binding;},async binding(key,session,purpose){assert.equal(purpose,'input');return this.get(key,session);},async verifyBinding(value,session){assert.deepEqual(value,this.get(id,session));}};
  const graph=mode!=='t2i'?mossInputTemplate(base,mode,binding):base,objects=schemasFor(graph),adapter={modelProfile:profile,profile:base,request:async route=>{assert.equal(route,'/object_info');return objects;}};
  const registry=new WorkflowRegistry({root,adapter,assets});store=new RunStore(':memory:');const productions=new ProductionStore(store,{assets});
  const p=productions.create('session',{requestId:randomUUID(),modelProfile:profile,brief:{request:'portrait',criteria:[{id:'C1',description:'portrait'}],invariants:['adult'],mode,...(mode!=='t2i'?{inputAssetId:id}:{})}}).production;
  const workflow=await registry.saveDraft({productionId:p.id,sessionId:'session',modelProfile:profile,mode,inputAssetId:mode!=='t2i'?id:null,graph,rationale:'legacy fixture'});
  file=join(root,'workflows','drafts',`${workflow.id}.json`);hold=file+'.hold';
  const bound=productions.bindWorkflow(p.id,'session',0,workflow),bytes=await readFile(file);
  const reservation=createServer();await new Promise(ok=>reservation.listen(0,'127.0.0.1',ok));const port=reservation.address().port;await new Promise(ok=>reservation.close(ok));
  let launches=0,post=0,alter=null;
  const server=createControllerServer({store,productions,workflows:registry,engine:{work:new Set(),launch(){launches++;}},token:'admin',dshToken:'synthetic-only',port,profile});
  await new Promise((ok,fail)=>server.once('error',fail).listen(port,'127.0.0.1',ok));t.after(async()=>{server.closeAllConnections();await new Promise(ok=>server.close(ok));});
  await mkdir(join(root,'data'));journal=await openMutationJournal(root);
  const events=[],session={id:'session',surface:{nodes:[]},snapshotEvents:()=>events,deriveMessages:()=>[]},sessions={flush:async()=>true},persistence={flush:async()=>{},open:async(id,access)=>({id,access,read:async seq=>({events:events.filter(x=>x.seq===seq)}),close:async()=>{}})},common={journal,session,sessions,persistence,mapSessionId:id=>id,wireProof:async()=>true};
  let step=0;const call=name=>{const callId=`fixture-${++step}`;events.push({seq:events.length,type:'tool/call',data:{callId,name,turn:1,step}});return callId;};
  const requestId=randomUUID(),input={expectedRevision:bound.revision,workflowId:workflow.id,prompt:'  A portrait  ',negativePrompt:' text ',seed:'42',width:512,height:768,steps:20,enhancer:scenario==='enhanced',...(scenario==='i2i-custom'?{denoise:0.45}:{}),requestId};
  const headers={Authorization:'Bearer synthetic-only','X-DSH-Session':'session','Content-Type':'application/json'};
  const readProof=async()=>{const response=await fetch(`http://127.0.0.1:${port}/api/productions/${p.id}/run-by-request?${new URLSearchParams({requestId})}`,{headers});if(!response.ok)throw Error(`HTTP ${response.status}`);const value=await response.json();if(alter)alter(value);return value;};
  const reconcile=()=>reconcileDurableOwnedMutation({...common,currentCallId:call('local_render_reconcile'),toolName:'local_render_reconcile',operation:'render',targetId:p.id,requestId,readProof});
  await assert.rejects(runDurableOwnedMutation({...common,currentCallId:call('local_production_render'),toolName:'local_production_render',operation:'render',targetId:p.id,input,send:async()=>{post++;const response=await fetch(`http://127.0.0.1:${port}/api/productions/${p.id}/render`,{method:'POST',headers,body:JSON.stringify(input)});assert.equal(response.status,202);await response.arrayBuffer();throw Error('lost after acceptance');},readProof}),/lost after acceptance/);
  journal.close();journal=await openMutationJournal(root);common.journal=journal;
  if(scenario==='enhanced'){
    // The original request can be identified before enhancement begins; this
    // proves admission only, not completion, cleanup or the effective prompt.
    const accepted=await reconcile();assert.equal(accepted.value.run.phase,'queued');assert.equal(accepted.value.run.effectiveSpec,undefined);assert.equal(accepted.value.receipt.originalSpecHash,hash(accepted.value.run.spec));assert.equal(post,1);assert.equal(launches,1);
    return;
  }
  await rename(file,hold);await assert.rejects(reconcile(),/HTTP 409/);await rename(hold,file);
  const metadata=JSON.parse(bytes);metadata.rationale='Different saved snapshot';await writeFile(file,JSON.stringify(metadata));
  await assert.rejects(reconcile(),/HTTP 409/);await writeFile(file,bytes);
  for(const mutate of [
    x=>{x.run.sessionId='other';},
    x=>{x.run.spec.prompt='different';x.run.specHash=hash(x.run.spec);},
    x=>{x.run.spec.seed='999';x.run.specHash=hash(x.run.spec);},
    x=>{x.run.spec.width=768;x.run.specHash=hash(x.run.spec);},
    x=>{x.run.productionRevision++;},
    x=>{x.production.attempts=[];},
    x=>{x.production.brief.mode='video';x.production.briefHash=hash(x.production.brief);x.run.spec.mode='video';x.run.spec.briefHash=x.production.briefHash;x.run.spec.workflow.mode='video';x.run.specHash=hash(x.run.spec);},
    ...['qwen-photo-v1','realesrgan-x4plus-v1','image-scale-v1'].map(profile=>x=>{x.production.brief.modelProfile=profile;x.production.briefHash=hash(x.production.brief);x.run.spec.modelProfile=profile;x.run.spec.briefHash=x.production.briefHash;x.run.spec.workflow.modelProfile=profile;x.run.specHash=hash(x.run.spec);}),
    ...(mode!=='t2i'?[x=>{x.run.spec.denoise=0.5;x.run.specHash=hash(x.run.spec);},x=>{x.run.spec.inputAsset.sha256='b'.repeat(64);x.run.specHash=hash(x.run.spec);}]:[]),
  ]){alter=mutate;await assert.rejects(reconcile(),/unresolved/);}
  alter=null;const result=await reconcile();
  assert.equal(result.value.run.phase,'queued');assert.equal(store.get(result.value.run.id).requestId,requestId);assert.equal(post,1);assert.equal(launches,1);assert.equal(journal.pending('session')[0].state,'receipt');
});
