// Unregistered Qwen-Image-2.1 official PE contract. Requires separate Qwen
// Research License purpose/acceptance, exact model availability and runtime
// qualification; MOSS PE approval or availability never authorizes Qwen.
// System texts are unmodified node 475 (t2i) / 479 (edit) from the pinned
// official workflow_templates revision 60d0d2c2f5c98ab50116abd837156e4010534657.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {buildQwen21EnhancerGraph,QWEN21_MODELS} from './qwen21-workflow.mjs';
import {inspectMossOfficialSchemas} from './moss-official.mjs';
import {readExternalPrompt} from './external-prompts.mjs';

const sha256=x=>createHash('sha256').update(x).digest('hex');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail=x=>{throw new Error(x);};
// BatchImagesNode otherwise silently center-crops/resizes every subsequent
// image to the first input's canvas. Never transform user input implicitly.
export function assertQwenPeInputDimensions(inputAssets){
  if(!Array.isArray(inputAssets))fail('Invalid Qwen PE input images');
  if(inputAssets.length>1&&inputAssets.some(item=>item?.width!==inputAssets[0]?.width||item?.height!==inputAssets[0]?.height))fail('Qwen PE input dimensions differ; prepare matching images explicitly before enhancement');
}
export function buildQwenPromptEnhancer({mode,prompt,seed,inputAssets=[],sessionId,thinking=false,maxLength=4096}={}){
  if(mode==='edit')assertQwenPeInputDimensions(inputAssets);
  const system=readExternalPrompt('qwen',mode),built=buildQwen21EnhancerGraph({mode,prompt,seed,inputAssets,sessionId,systemPrompt:system.text,thinking,maxLength});
  return {...built,systemSha256:system.sha256,model:QWEN21_MODELS.enhancer[mode],originalPromptSha256:sha256(prompt),seed,thinking,maxLength,scope:'static-only'};
}
export function inspectQwenPromptEnhancer(graph,options,objects){
  const expected=buildQwenPromptEnhancer(options);if(!isDeepStrictEqual(graph,expected.graph))fail('Qwen PE graph differs from fixed contract');
  const {preview,...nonOutput}=graph,checked=inspectMossOfficialSchemas(nonOutput,objects),p=objects?.PreviewAny;
  if(!p||p.api_node===true||p.dev_only===true||p.output_node!==true||p.input?.required?.source?.[0]!=='*'||p.output?.[0]!=='STRING')checked.invalid.push('preview:unsafe-or-changed-schema');
  checked.ready=checked.missing.length===0&&checked.unsafe.length===0&&checked.invalid.length===0;return checked;
}
export function collectQwenPromptEnhancement(history,{options,controllerId,runId,promptId}={}){
  if(typeof controllerId!=='string'||!controllerId||controllerId.length>128||!UUID.test(runId??'')||!UUID.test(promptId??''))fail('Invalid Qwen PE ownership identity');
  const expected=buildQwenPromptEnhancer(options),owner=history?.prompt?.[3]?.local_genai;
  if(history?.status?.status_str!=='success'||history.status.completed!==true||!Array.isArray(history.prompt)||history.prompt[1]!==promptId||!isDeepStrictEqual(history.prompt[2],expected.graph)||owner?.controller_id!==controllerId||owner?.run_id!==runId||owner?.prompt_id!==promptId)fail('Qwen PE history status, graph or ownership differs');
  if(!history.outputs||Object.keys(history.outputs).length!==1||!Object.hasOwn(history.outputs,'preview'))fail('Unexpected Qwen PE output nodes');
  const result=history.outputs.preview?.text;if(!Array.isArray(result)||result.length!==1||typeof result[0]!=='string')fail('Qwen PE has no single text output');
  const raw=result[0];if(!raw.trim()||raw.length>6000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(raw)||/<\/?think\b|<\|(?:im_start|im_end|channel|message)\b|<tool_call\b/i.test(raw))fail('Qwen PE output is empty, oversized or contains reasoning/control markup');
  return {originalPrompt:options.prompt,originalPromptSha256:expected.originalPromptSha256,enhancedPrompt:raw,enhancedPromptSha256:sha256(raw),systemSha256:expected.systemSha256,model:expected.model,seed:expected.seed,thinking:expected.thinking,maxLength:expected.maxLength,inputAssets:expected.inputAssets,controllerId,runId,promptId,semanticValidation:'unverified',completionReason:'unavailable',runtimeEvidence:'history-fixture-or-caller-supplied'};
}
export const QWEN_PE_CONTRACT=Object.freeze({build:buildQwenPromptEnhancer,inspect:inspectQwenPromptEnhancer,collect:collectQwenPromptEnhancement,options:({prompt,seed,inputAssets,sessionId,mode,thinking,maxLength})=>({mode,prompt,seed,inputAssets,sessionId,thinking,maxLength})});
