import {createRuntimeConfig} from '../shared/plugin-config.mjs';
import {createControllerRequest} from '../shared/controller-request.mjs';
import {VIDEO_PATH,videoHandler} from './video.mjs';
import {ORIGINAL_PATH,originalHandler} from './original.mjs';
import {controllerSessionMode,controllerSessionId,withControllerSessionNamespace} from '../shared/controller-session.mjs';

export const name='local-genai-media-results';
export const Config=withControllerSessionNamespace(createRuntimeConfig({allowUnknown:true}));
export const inject=['webServer','connection','sessionQuery','attachments'];
const STYLE=`.local-genai-result{padding:12px 0;line-height:1.65;min-width:0;max-width:100%;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family)}
.local-genai-result h3{font-size:1em;font-weight:600;margin:0 0 6px}
.local-genai-result p{margin:4px 0 10px}.local-genai-result details{margin-top:10px}
.local-genai-result summary{cursor:pointer}.local-genai-result pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:24rem;overflow:auto;font-size:.85em}
.local-genai-result [role="alert"]{font-weight:600}`;

/** Each route retains the original conversation/attachment and hash checks. */
export async function apply(ctx,config){
  const sessionMode=controllerSessionMode(config);
  const readOriginal=await createControllerRequest(config,{timeoutMs:60000});
  ctx.effect(()=>ctx.connection.fetch.register({path:VIDEO_PATH,methods:['GET','HEAD'],requestBody:'buffered',fetch:videoHandler(ctx)}));
  const fetchRun=async({sessionId,runId,signal})=>{
    const response=await readOriginal(`/api/runs/${encodeURIComponent(runId)}`,{sessionId,signal});
    if(!response.ok)throw new Error('Run unavailable.');
    return response.json();
  };
  const fetchArtifact=({sessionId,runId,name,signal})=>readOriginal(`/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(name)}`,{sessionId,signal});
  ctx.effect(()=>ctx.connection.fetch.register({path:ORIGINAL_PATH,methods:['GET'],requestBody:'buffered',fetch:originalHandler({sessionQuery:ctx.sessionQuery,fetchRun,fetchArtifact,controllerSession:sessionId=>controllerSessionId(sessionId,sessionMode)})}));
  ctx.on('webserver/index-inject',rows=>rows.push({kind:'style',text:STYLE}));
}
