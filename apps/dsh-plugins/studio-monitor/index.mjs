import {createRuntimeConfig} from '../shared/plugin-config.mjs';
import {withControllerSessionNamespace} from '../shared/controller-session.mjs';
import {createControllerRequest} from '../shared/controller-request.mjs';
import {jsonResponse as response} from '../shared/web-route.mjs';

export const name='local-studio-monitor';
export const Config=withControllerSessionNamespace(createRuntimeConfig({allowUnknown:true}));
export const inject=['connection','sessionQuery'];
export const MONITOR_PATH='/api/local-studio/monitor';
const CATALOG_PATH='/api/local-studio/catalog';
const CORE_PATH='/api/local-studio/core-model';
const ROUTES = [
  [MONITOR_PATH, '/api/studio-monitor'],
  [CATALOG_PATH, '/api/workflow-library', { filters: ['query', 'media', 'mode', 'page'], unavailable: 'ワークフローを取得できません。' }],
  [CORE_PATH, '/api/core-catalog', { unavailable: 'Strataのモデル情報を確認できません。' }],
];
const validSession=value=>typeof value==='string'&&value.trim().length>0&&value.length<=160&&!/[\x00-\x1f\x7f]/.test(value);

// The endpoint is read-only, authenticated by DSH's connection layer, and
// requires an existing session before forwarding that session's own identity.
export function monitorHandler({sessionQuery,controllerRequest,filters=[],unavailable='制作状態を確認できません。'}){
  return async request=>{
    if(request.method!=='GET')return response(405,{error:'未対応の操作です。'});
    const url=new URL(request.url);
    const params=url.searchParams;
    if(params.getAll('sessionId').length!==1)return response(400,{error:'会話を確認できません。'});
    for(const key of params.keys()){
      if(key!=='sessionId'&&(!filters.includes(key)||params.getAll(key).length!==1))return response(400,{error:'検索条件が正しくありません。'});
    }
    const sessionId=url.searchParams.get('sessionId');if(!validSession(sessionId))return response(400,{error:'会話を確認できません。'});
    let observation;
    try{observation=await sessionQuery.observeSession(sessionId,{signal:request.signal,projectionMode:'none'});}
    catch{return response(404,{error:'この会話を確認できません。'});}
    finally{observation?.[Symbol.dispose]?.();}
    params.delete('sessionId');
    try{return response(200,await controllerRequest({sessionId,signal:request.signal,params}));}
    catch{return response(503,{error:unavailable});}
  };
}

export async function apply(ctx,config){
  const request=await createControllerRequest(config,{timeoutMs:20000});
  const controllerRequest=path=>async options=>{
    const result=await request(path,options);
    if(!result.ok)throw Error('Controller monitoring unavailable');
    return result.json();
  };
  for (const [path, endpoint, options] of ROUTES) {
    ctx.effect(() => ctx.connection.fetch.register({
      path, methods: ['GET'], requestBody: 'buffered',
      fetch: monitorHandler({ sessionQuery: ctx.sessionQuery, controllerRequest: controllerRequest(endpoint), ...options }),
    }));
  }
}
