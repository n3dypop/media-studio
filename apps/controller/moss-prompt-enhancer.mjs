// Unintegrated, local ComfyUI MOSS prompt enhancement stage.
// The system prompt is extracted without alteration from node 14 of the pinned
// official image_moss_image_t2i.json template (workflow_templates revision
// 60d0d2c2f5c98ab50116abd837156e4010534657; source SHA-256
// 91d76c158a1e427c09904c6222978065c1ed965c8b3f40ae323e649808af2198).
// This module never submits jobs, owns leases, resolves assets or writes data.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {assertInputBinding} from './media-modes.mjs';
import {inspectMossOfficialSchemas} from './moss-official.mjs';
import {readExternalPrompt} from './external-prompts.mjs';

const sha256=x=>createHash('sha256').update(x).digest('hex');
const ENCODER='qwen3.5_9b_w4a8_gptq.safetensors';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail=x=>{throw new Error(x);};
const node=(class_type,inputs)=>({class_type,inputs});

/** inputAsset is an optional independently verified, session-owned *generator*
 * input. A reference-only observation is not promoted to model input. For a
 * layout request pass only the natural-language summary here; attach boxes with
 * MOSSImageLayoutPrompt after accepting the result, never rewrite its JSON. */
export function buildMossPromptEnhancer({prompt,seed,inputAsset=null,sessionId}={}){
  if(typeof prompt!=='string'||!prompt.trim()||prompt.length>6000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(prompt))fail('Invalid original prompt');
  if(typeof seed!=='string'||!/^(0|[1-9]\d{0,15})$/.test(seed)||BigInt(seed)>BigInt(Number.MAX_SAFE_INTEGER))fail('Invalid PE seed');
  const system=readExternalPrompt('moss','t2i');
  const graph={
    clip:node('CLIPLoader',{clip_name:ENCODER,type:'moss_image',device:'default'}),
    system:node('PrimitiveStringMultiline',{value:system.text}),
  };
  if(inputAsset!==null){
    if(typeof sessionId!=='string'||!sessionId.trim()||sessionId.length>160)fail('Session required for enhancer image');
    assertInputBinding(inputAsset);
    const owner=sha256(sessionId).slice(0,24);
    if(!inputAsset.comfyInputName.startsWith(`controller-assets/${owner}/`))fail('Enhancer image is not session-owned');
    graph.image=node('LoadImage',{image:inputAsset.comfyInputName});
  }
  graph.enhance=node('TextGenerate',{clip:['clip',0],prompt,max_length:4096,sampling_mode:'on','sampling_mode.temperature':0.7,'sampling_mode.top_k':64,'sampling_mode.top_p':0.95,'sampling_mode.min_p':0.05,'sampling_mode.repetition_penalty':1,'sampling_mode.seed':Number(seed),'sampling_mode.presence_penalty':0,thinking:false,use_default_template:true,system_prompt:['system',0],...(inputAsset?{image:['image',0]}:{})});
  graph.preview=node('PreviewAny',{source:['enhance',0]});
  return {graph,outputNode:'preview',systemSha256:system.sha256,originalPromptSha256:sha256(prompt),inputAsset:inputAsset?{id:inputAsset.id,sha256:inputAsset.sha256}:null,model:ENCODER,seed,scope:'static-only'};
}

export function inspectMossPromptEnhancer(graph,options,objects){
  const expected=buildMossPromptEnhancer(options);
  if(!isDeepStrictEqual(graph,expected.graph))fail('PE graph differs from fixed contract');
  const {preview,...nonOutput}=graph;
  const checked=inspectMossOfficialSchemas(nonOutput,objects);
  const p=objects?.PreviewAny;
  if(!p||p.api_node===true||p.dev_only===true||p.output_node!==true||p.input?.required?.source?.[0]!=='*'||p.output?.[0]!=='STRING')checked.invalid.push('preview:unsafe-or-changed-schema');
  checked.ready=checked.missing.length===0&&checked.unsafe.length===0&&checked.invalid.length===0;
  return checked;
}

/** Read only an exact owned completed history. History output layout is based
 * on ComfyUI PreviewAny source code and MUST still be tested over real HTTP.
 * A nonempty text is not proof of semantic preservation or completion: Comfy's
 * TextGenerate does not expose finish_reason. The caller must durably save this
 * result before any generation and decide independently whether to use it. */
export function collectMossPromptEnhancement(history,{options,controllerId,runId,promptId}={}){
  if(typeof controllerId!=='string'||!controllerId||controllerId.length>128||!UUID.test(runId??'')||!UUID.test(promptId??''))fail('Invalid PE ownership identity');
  const expected=buildMossPromptEnhancer(options);
  if(!history||history.status?.status_str!=='success'||history.status?.completed!==true||!Array.isArray(history.prompt)||history.prompt[1]!==promptId||!isDeepStrictEqual(history.prompt[2],expected.graph))fail('PE job status, prompt ID or graph mismatch');
  const own=history.prompt[3]?.local_genai;
  if(!own||own.controller_id!==controllerId||own.run_id!==runId||own.prompt_id!==promptId)fail('PE history ownership mismatch');
  if(!history.outputs||Object.keys(history.outputs).length!==1||!Object.hasOwn(history.outputs,'preview'))fail('Unexpected PE output nodes');
  const text=history.outputs.preview?.text;
  if(!Array.isArray(text)||text.length!==1||typeof text[0]!=='string')fail('PE history has no single string output');
  const raw=text[0];
  if(!raw.trim()||raw.length>6000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(raw)||/<\/?think\b|<\|(?:im_start|im_end|channel|message)\b|<tool_call\b/i.test(raw))fail('PE output is empty, oversized or contains control/reasoning markup');
  return {originalPrompt:options.prompt,originalPromptSha256:expected.originalPromptSha256,enhancedPrompt:raw,enhancedPromptSha256:sha256(raw),systemSha256:expected.systemSha256,model:expected.model,seed:expected.seed,inputAsset:expected.inputAsset,controllerId,runId,promptId,semanticValidation:'unverified',completionReason:'unavailable',runtimeEvidence:'history-fixture-or-caller-supplied'};
}
