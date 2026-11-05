import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {executionEvidence} from '../apps/dsh-plugins/local-genai/execution-evidence.mjs';
const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==','base64');
const sha=data=>createHash('sha256').update(data).digest('hex');
const spec={prompt:'private prompt',modelProfile:'moss-image-sft-official-v1',mode:'t2i',seed:'42',steps:25,width:512,height:768,workflow:{id:'11111111-1111-4111-8111-111111111111',sha256:'b'.repeat(64),request:{cfg:2.5,precision:'int8',sampler:'er_sde'},graph:{secret:{inputs:{path:'D:/private/file'}}}}};
const artifact={name:'image.png',mime:'image/png',sha256:sha(image),path:'D:/private/image.png'};
test('execution evidence distinguishes verified stored request, real PNG dimensions and recorded history status',()=>{
 const run={spec,specHash:sha(JSON.stringify(spec)),historyStatus:{status_str:'success',completed:true,messages:[['secret','private']]}};
 const e=executionEvidence(run,[{artifact,bytes:image}]);assert.equal(e.submitted.seed,'42');assert.equal(e.submitted.workflow.cfg,2.5);assert.deepEqual(e.submitted.requestedCanvas,{width:512,height:768});assert.equal(e.outputs[0].width,1);assert.equal(e.outputs[0].height,1);assert.equal(e.history.status,'success');assert.equal(e.outputs[0].historyGraph,undefined);
 assert.doesNotMatch(JSON.stringify(e),/private|D:|prompt|inputs/);assert.match(e.unconfirmed,/unverified/);
});
test('history graph values require an explicit matched record; bad spec or image hash return no evidence',()=>{
 const run={spec,specHash:sha(JSON.stringify(spec))},historyEvidence={source:'comfyui-history-graph',graphSha256:'c'.repeat(64),modelProfile:'moss-image-sft-official-v1',modelFile:'model.safetensors',seed:'42',steps:25,cfg:2.5,sampler:'er_sde',scheduler:'simple',secret:'hidden'};
 const e=executionEvidence(run,[{artifact:{...artifact,historyEvidence},bytes:image}]);assert.equal(e.outputs[0].historyGraph.steps,25);assert.equal(e.outputs[0].historyGraph.source,'comfyui-history-graph-matched-stored-run');assert.doesNotMatch(JSON.stringify(e),/secret|hidden/);
 assert.equal(executionEvidence({...run,specHash:'d'.repeat(64)},[{artifact,bytes:image}]),null);assert.equal(executionEvidence(run,[{artifact:{...artifact,sha256:'e'.repeat(64)},bytes:image}]),null);assert.equal(executionEvidence(run,[]),null);
});
test('enhanced runs use the matching effective specification and never expose prompts',()=>{
 const effectiveSpec={...spec,prompt:'enhanced private text',negativePrompt:'private negative',steps:30};
 const run={spec,effectiveSpec,specHash:sha(JSON.stringify(effectiveSpec))};
 const evidence=executionEvidence(run,[{artifact,bytes:image}]);
 assert.equal(evidence.submitted.source,'controller-stored-effective-spec');
 assert.equal(evidence.submitted.specSha256,run.specHash);
 assert.equal(evidence.submitted.steps,30);
 assert.match(evidence.submitted.note,/after prompt enhancement/);
 assert.doesNotMatch(JSON.stringify(evidence),/private|enhanced private text|negative|D:/);
});
test('invalid or mismatched effective specification never falls back to the original',()=>{
 const effectiveSpec={...spec,prompt:'enhanced'};
 const images=[{artifact,bytes:image}];
 assert.equal(executionEvidence({spec,effectiveSpec,specHash:sha(JSON.stringify(spec))},images),null);
 assert.equal(executionEvidence({spec,effectiveSpec:{...effectiveSpec,steps:99},specHash:sha(JSON.stringify(effectiveSpec))},images),null);
 assert.equal(executionEvidence({spec,effectiveSpec:null,specHash:sha(JSON.stringify(spec))},images),null);
 assert.equal(executionEvidence({spec,effectiveSpec:[],specHash:sha(JSON.stringify([]))},images),null);
 assert.equal(executionEvidence({spec,effectiveSpec,specHash:sha(JSON.stringify(effectiveSpec))},[{artifact:{...artifact,sha256:'e'.repeat(64)},bytes:image}]),null);
});
