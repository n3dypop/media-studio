import {createHash} from 'node:crypto';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const safeText=value=>typeof value==='string'&&/^[A-Za-z0-9_.-]{1,200}$/.test(value);
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const finite=(value,min,max)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;

// Called only after the caller matched the owning session/production and
// SHA-256-verified each downloaded image. Never return prompt, graph or paths.
export function executionEvidence(run,verifiedImages){
  if(!run||!run.spec||!hex(run.specHash)||!Array.isArray(verifiedImages)||verifiedImages.length===0)return null;
  // Integrated prompt enhancement preserves the original request in spec and
  // stores the actual submitted settings in effectiveSpec. If an effective
  // spec is present, never fall back to the original on a malformed value or
  // hash mismatch: that would attribute an image to the wrong settings.
  const effective=Object.hasOwn(run,'effectiveSpec');
  const spec=effective?run.effectiveSpec:run.spec;
  if(!spec||typeof spec!=='object'||Array.isArray(spec))return null;
  try{if(digest(spec)!==run.specHash)return null;}catch{return null;}
  const submitted={source:effective?'controller-stored-effective-spec':'controller-stored-spec',specSha256:run.specHash,note:effective?'Effective settings saved before execution after prompt enhancement; they are not measurements of the GPU execution.':'Requested settings saved before execution; they are not measurements of the GPU execution.'};
  if(safeText(spec.modelProfile))submitted.modelProfile=spec.modelProfile;
  if(safeText(spec.mode))submitted.mode=spec.mode;
  if(typeof spec.seed==='string'&&/^(0|[1-9]\d{0,15})$/.test(spec.seed)&&BigInt(spec.seed)<=BigInt(Number.MAX_SAFE_INTEGER))submitted.seed=spec.seed;
  if(integer(spec.steps,1,10000))submitted.steps=spec.steps;
  if(integer(spec.width,1,4096)&&integer(spec.height,1,4096))submitted.requestedCanvas={width:spec.width,height:spec.height};
  if(finite(spec.denoise,0,1))submitted.denoise=spec.denoise;
  const wf=spec.workflow;if(wf&&typeof wf==='object'){
    const draft={};if(typeof wf.id==='string'&&/^[a-f0-9-]{36}$/.test(wf.id))draft.id=wf.id;if(hex(wf.sha256))draft.sha256=wf.sha256;
    const req=wf.request??{}, sampler=wf.graph?.[wf.roles?.sampler??''];
    const cfg=req.cfg??sampler?.inputs?.cfg;if(finite(cfg,0,100))draft.cfg=cfg;
    for(const key of ['precision','sampler','scheduler'])if(safeText(req[key]))draft[key]=req[key];
    if(Object.keys(draft).length)submitted.workflow=draft;
  }
  const output=[];
  for(const {artifact,bytes} of verifiedImages){
    if(!artifact||!hex(artifact.sha256)||!Buffer.isBuffer(bytes)||createHash('sha256').update(bytes).digest('hex')!==artifact.sha256)return null;
    const item={sha256:artifact.sha256,mime:artifact.mime,source:'artifact-bytes-sha256-verified'};
    if(artifact.mime==='image/png'&&bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.toString('ascii',12,16)==='IHDR'){
      const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);if(integer(width,1,4096)&&integer(height,1,4096)){item.width=width;item.height=height;item.dimensionSource='sha256-verified-png-ihdr';}
    }
    const alpha=artifact.alpha;
    if(alpha&&typeof alpha.hasAlphaChannel==='boolean'&&(alpha.transparentPixelDetected===null||typeof alpha.transparentPixelDetected==='boolean'))item.alpha={hasAlphaChannel:alpha.hasAlphaChannel,transparentPixelDetected:alpha.transparentPixelDetected,source:'controller-verified-png'};
    const graph=artifact.historyEvidence;
    if(graph?.source==='comfyui-history-graph'&&hex(graph.graphSha256)){
      const observed={source:'comfyui-history-graph-matched-stored-run',graphSha256:graph.graphSha256,note:'The verified ComfyUI history graph matches the stored run; these are recorded graph values, not independent GPU measurements.'};
      for(const key of ['modelProfile','modelFile','sampler','scheduler'])if(safeText(graph[key]))observed[key]=graph[key];
      if(typeof graph.seed==='string'&&/^(0|[1-9]\d{0,15})$/.test(graph.seed)&&BigInt(graph.seed)<=BigInt(Number.MAX_SAFE_INTEGER))observed.seed=graph.seed;
      if(integer(graph.steps,1,10000))observed.steps=graph.steps;if(finite(graph.cfg,0,100))observed.cfg=graph.cfg;item.historyGraph=observed;
    }
    output.push(item);
  }
  const status=run.historyStatus;
  const history=status&&['success','error'].includes(status.status_str)&&typeof status.completed==='boolean'
    ?{source:'controller-recorded-comfyui-history-status',status:status.status_str,completed:status.completed,note:'Completion status from the recorded ComfyUI history; it does not prove visual quality.'}:null;
  return {submitted,outputs:output,...(history?{history}:{}),unconfirmed:'Settings absent from the matched history graph, actual numerical GPU behavior, and visual quality remain unverified.'};
}
