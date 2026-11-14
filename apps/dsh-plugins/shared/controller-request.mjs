import {readFile} from 'node:fs/promises';
import {controllerSessionId,controllerSessionMode} from './controller-session.mjs';
import {runtimeRootUrl} from './plugin-config.mjs';

export async function createControllerRequest(config,{admin=false,timeoutMs}={}){
  const root=runtimeRootUrl(config),mode=controllerSessionMode(config);
  const {port}=JSON.parse(await readFile(new URL('config/controller.json',root),'utf8'));
  if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid managed Controller port.');
  const origin=`http://127.0.0.1:${port}`;
  const tokenPath=new URL(admin?'data/controller/auth-token':'data/controller/dsh-token',root);
  return async (path,{method='GET',sessionId,params,body,signal}={})=>{
    const url=new URL(path,origin);
    if(url.origin!==origin||!url.pathname.startsWith('/api/')||url.hash)throw Error('Invalid Controller API route.');
    if(params)url.search=params.toString();
    const token=(await readFile(tokenPath,'utf8')).trim();
    if(!/^[a-f0-9]{64}$/.test(token))throw Error('Controller authentication unavailable.');
    const headers={Authorization:`Bearer ${token}`};
    if(!admin)headers['X-DSH-Session']=controllerSessionId(sessionId,mode);
    if(body!==undefined)headers['Content-Type']='application/json';
    const timeout=AbortSignal.timeout(timeoutMs);
    return fetch(url,{method,headers,body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',redirect:'error',
      signal:signal?AbortSignal.any([signal,timeout]):timeout});
  };
}
