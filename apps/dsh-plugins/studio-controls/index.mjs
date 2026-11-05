import {readFile} from 'node:fs/promises';
import {createRuntimeConfig,runtimeRootUrl} from '../shared/plugin-config.mjs';
import {ACTIONS_PATH,actionsHandler} from './actions.mjs';
import {controllerSessionMode,controllerSessionId,withControllerSessionNamespace} from '../shared/controller-session.mjs';
import {createHostDesktopRequestTrust,registerDesktopProof} from '../shared/desktop-request-trust.mjs';
import {desktopPackagedRuntimeOption,withDesktopPackagedRuntime} from '../local-genai/runtime.mjs';

export const name='local-genai-studio-controls';
export const Config=withDesktopPackagedRuntime(withControllerSessionNamespace(createRuntimeConfig({allowUnknown:true}),{allowedKeys:['desktopPackagedRuntime']}));
export const inject=['webServer','connection','sessionQuery','sessionController','agents'];
const STYLE=`.local-studio-controls{padding:12px 0;line-height:1.65;min-width:0;max-width:100%;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family)}
.local-studio-controls h3{font-size:1em;font-weight:600;margin:0 0 6px}.local-studio-controls p{margin:4px 0 10px}
.local-studio-controls pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:24rem;overflow:auto;font-size:.85em}.local-studio-controls summary{cursor:pointer}`;

// Trust the listener owned by this Host, rather than a configured Web port or
// request-supplied Host header. An unavailable or non-loopback listener is not
// an origin on which to authorize an action.
export function localHostOrigin(server){
  try{
    if(!server||server.host!=='127.0.0.1'||server.protocol!=='http:'||!Number.isInteger(server.port)||server.port<1||server.port>65535||typeof server.getOrigin!=='function')return null;
    const origin=server.getOrigin();
    return origin===`http://127.0.0.1:${server.port}`?origin:null;
  }catch{return null;}
}

// This sender is valid only behind DSH's owner-authenticated connection.fetch
// route. Calling the Host service directly does not authorize the requester.
export function createPlanningSender(sessionController){
  return async(request,sessionId,planning)=>{
    if(!request.headers.get('cookie')||typeof sessionController?.prompt!=='function')throw Object.assign(new Error('Authenticated Host session unavailable'),{definitelyNotSent:true});
    const result=await sessionController.prompt({sessionId,requestId:planning.requestId,mode:'queue',content:[{type:'text',text:planning.text}],clientTimeZone:'Asia/Tokyo'},AbortSignal.timeout(30000));
    if(result?.accepted!==true)throw new Error('Planning admission unavailable');
  };
}

// A consumed inbox entry remains in splice history even if the model step fails
// before a user/message event. Evidence must identify the exact user message.
export async function planningReceiptFromHost({agents,sessionQuery},sessionId,requestId,signal,planning){
  const messages=[];
  const agent=agents.get(sessionId);
  if(agent)messages.push(...(agent.inbox?.nextTurn??[]),...(agent.inbox?.nextStep??[]));
  let observation;
  try{
    observation=await sessionQuery.observeSession(sessionId,{signal,projectionMode:'none'});
    if(!Array.isArray(observation?.events))throw Error('Session observation unavailable');
    for(const event of observation.events){
      if(event?.type==='user/message')messages.push(event.data);
      if(event?.type==='agent/inbox/spliced'&&Array.isArray(event.data?.inserted))messages.push(...event.data.inserted);
    }
  }finally{observation?.[Symbol.dispose]?.();}
  const candidates=messages.filter(message=>message?.source?.rpcId===requestId);
  const matches=message=>message?.source?.kind==='user'&&Array.isArray(message.content)&&message.content.length===1&&message.content[0]?.type==='text'&&message.content[0].text===planning?.text;
  if(candidates.some(message=>!matches(message)))return 'conflict';
  return candidates.length>0;
}

export async function apply(ctx,config){
  const sessionMode=controllerSessionMode(config);
  if(sessionMode==='desktop')desktopPackagedRuntimeOption({desktopPackagedRuntime:true});
  const root=runtimeRootUrl(config);
  const configuration=JSON.parse(await readFile(new URL('config/controller.json',root),'utf8'));
  if(!Number.isInteger(configuration.port))throw new Error('Invalid managed controller port.');
  const controllerOrigin=`http://127.0.0.1:${configuration.port}`;
  const dshOrigin=()=>localHostOrigin(ctx.webServer);
  const trust=sessionMode==='desktop'?createHostDesktopRequestTrust(dshOrigin):null;
  const controllerRequest=async(path,{method='GET',body,signal}={})=>{
    const token=(await readFile(new URL('data/controller/auth-token',root),'utf8')).trim();
    if(!/^[a-f0-9]{64}$/.test(token)||!path.startsWith('/api/'))throw new Error('Controller authentication unavailable.');
    const response=await fetch(controllerOrigin+path,{method,headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000),redirect:'error'});
    const value=await response.json();
    if(!response.ok)throw Object.assign(new Error(typeof value.error==='string'?value.error:'Controller request failed.'),{status:response.status});
    return value;
  };
  const sendPlanning=createPlanningSender(ctx.sessionController);
  const planningReceipt=(sessionId,requestId,signal,planning)=>planningReceiptFromHost(ctx,sessionId,requestId,signal,planning);
  if(trust)ctx.effect(()=>registerDesktopProof(ctx,'/api/local-studio/desktop-proof/actions',trust,{method:'POST',path:ACTIONS_PATH}));
  ctx.effect(()=>ctx.connection.fetch.register({path:ACTIONS_PATH,methods:['GET','POST'],requestBody:'buffered',fetch:actionsHandler({sessionQuery:ctx.sessionQuery,controllerRequest,dshOrigin,sendPlanning,planningReceipt,controllerSession:sessionId=>controllerSessionId(sessionId,sessionMode),...(trust?{mutationAllowed:request=>trust.mutationAllowed(request,{marker:'x-local-studio-action'})}:{})})}));
  ctx.on('webserver/index-inject',rows=>rows.push({kind:'style',text:STYLE}));
}
