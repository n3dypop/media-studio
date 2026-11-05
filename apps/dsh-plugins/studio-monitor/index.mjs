import {readFile} from 'node:fs/promises';
import {createRuntimeConfig,runtimeRootUrl} from '../shared/plugin-config.mjs';
import {controllerSessionMode,controllerSessionId,withControllerSessionNamespace} from '../shared/controller-session.mjs';

export const name='local-studio-monitor';
export const Config=withControllerSessionNamespace(createRuntimeConfig({allowUnknown:true}));
export const inject=['connection','sessionQuery'];
export const MONITOR_PATH='/api/local-studio/monitor';
const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const response=(status,value)=>new Response(JSON.stringify(value),{status,headers});
const validSession=value=>typeof value==='string'&&value.trim().length>0&&value.length<=160&&!/[\x00-\x1f\x7f]/.test(value);

// The endpoint is read-only, authenticated by DSH's connection layer, and
// requires an existing session before forwarding that session's own identity.
export function monitorHandler({sessionQuery,controllerRequest}){
  return async request=>{
    if(request.method!=='GET')return response(405,{error:'未対応の操作です。'});
    const url=new URL(request.url);
    if([...url.searchParams.keys()].some(key=>key!=='sessionId')||url.searchParams.getAll('sessionId').length!==1)return response(400,{error:'会話を確認できません。'});
    const sessionId=url.searchParams.get('sessionId');if(!validSession(sessionId))return response(400,{error:'会話を確認できません。'});
    let observation;
    try{observation=await sessionQuery.observeSession(sessionId,{signal:request.signal,projectionMode:'none'});}
    catch{return response(404,{error:'この会話を確認できません。'});}
    finally{observation?.[Symbol.dispose]?.();}
    try{return response(200,await controllerRequest({sessionId,signal:request.signal}));}
    catch{return response(503,{error:'制作状態を確認できません。'});}
  };
}

export async function apply(ctx,config){
  const sessionMode=controllerSessionMode(config);
  const root=runtimeRootUrl(config);
  const configuration=JSON.parse(await readFile(new URL('config/controller.json',root),'utf8'));
  if(!Number.isInteger(configuration.port)||configuration.port<1024||configuration.port>65535)throw new Error('Invalid controller port');
  const url=`http://127.0.0.1:${configuration.port}/api/studio-monitor`;
  const controllerRequest=async({sessionId,signal})=>{
    const token=(await readFile(new URL('data/controller/dsh-token',root),'utf8')).trim();
    if(!/^[a-f0-9]{64}$/.test(token))throw new Error('Controller authentication unavailable');
    const result=await fetch(url,{headers:{Authorization:`Bearer ${token}`,'X-DSH-Session':controllerSessionId(sessionId,sessionMode)},cache:'no-store',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)});
    if(!result.ok)throw new Error('Controller monitoring unavailable');return result.json();
  };
  ctx.effect(()=>ctx.connection.fetch.register({path:MONITOR_PATH,methods:['GET'],requestBody:'buffered',fetch:monitorHandler({sessionQuery:ctx.sessionQuery,controllerRequest})}));
}
