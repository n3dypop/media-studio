import {readFile} from 'node:fs/promises';
import {createRuntimeConfig,runtimeRootUrl} from '../shared/plugin-config.mjs';
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
  const root=runtimeRootUrl(config);
  const configuration=JSON.parse(await readFile(new URL('config/controller.json',root),'utf8'));
  if(!Number.isInteger(configuration.port))throw new Error('Invalid managed controller port.');
  const controllerOrigin=`http://127.0.0.1:${configuration.port}`;
  ctx.effect(()=>ctx.connection.fetch.register({path:VIDEO_PATH,methods:['GET','HEAD'],requestBody:'buffered',fetch:videoHandler(ctx)}));
  const readOriginal=async(path,sessionId,signal)=>{
    const token=(await readFile(new URL('data/controller/dsh-token',root),'utf8')).trim();
    if(!/^[a-f0-9]{64}$/.test(token))throw new Error('Controller authentication unavailable.');
    return fetch(controllerOrigin+path,{headers:{Authorization:`Bearer ${token}`,'X-DSH-Session':controllerSessionId(sessionId,sessionMode)},cache:'no-store',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(60000)]):AbortSignal.timeout(60000)});
  };
  const fetchRun=async({sessionId,runId,signal})=>{
    const response=await readOriginal(`/api/runs/${encodeURIComponent(runId)}`,sessionId,signal);
    if(!response.ok)throw new Error('Run unavailable.');
    return response.json();
  };
  const fetchArtifact=({sessionId,runId,name,signal})=>readOriginal(`/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(name)}`,sessionId,signal);
  ctx.effect(()=>ctx.connection.fetch.register({path:ORIGINAL_PATH,methods:['GET'],requestBody:'buffered',fetch:originalHandler({sessionQuery:ctx.sessionQuery,fetchRun,fetchArtifact,controllerSession:sessionId=>controllerSessionId(sessionId,sessionMode)})}));
  ctx.on('webserver/index-inject',rows=>rows.push({kind:'style',text:STYLE}));
}
