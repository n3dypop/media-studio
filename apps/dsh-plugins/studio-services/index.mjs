import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createRuntimeConfig,runtimeRootOf} from '../shared/plugin-config.mjs';
import {createSystemAdapter,createServiceManager} from './service-manager.mjs';
import {createServiceSettings} from './service-settings.mjs';
import {controllerSessionMode,withControllerSessionNamespace} from '../shared/controller-session.mjs';
import {createHostDesktopRequestTrust,registerDesktopProof} from '../shared/desktop-request-trust.mjs';
import {desktopPackagedRuntimeOption,withDesktopPackagedRuntime} from '../local-genai/runtime.mjs';
import {localHostOrigin} from '../studio-controls/index.mjs';
export const name='studio-services';
export const Config=withDesktopPackagedRuntime(withControllerSessionNamespace(createRuntimeConfig({allowUnknown:true}),{allowedKeys:['desktopPackagedRuntime']}));
export const inject=['connection','webServer'];
export const SERVICES_PATH='/api/local-studio/services';
export const SETTINGS_PATH='/api/local-studio/service-settings';
const response=(status,value)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function servicesHandler({manager,dshOrigin,mutationAllowed}){
  return async request=>{
    try{
      const url=new URL(request.url);
      if(request.method==='GET'){
        if([...url.searchParams.keys()].some(k=>k!=='requestId')||url.searchParams.getAll('requestId').length>1)return response(400,{error:'要求が不正です。'});
        const requestId=url.searchParams.get('requestId');if(requestId!==null&&!uuid.test(requestId))return response(400,{error:'要求IDが不正です。'});
        return response(200,await manager.snapshot(requestId??undefined));
      }
      if(request.method!=='POST')return response(405,{error:'未対応の操作です。'});
      if(url.search||(mutationAllowed?!mutationAllowed(request):request.headers.get('origin')!==dshOrigin||request.headers.get('x-local-studio-service')!=='1'||!(request.headers.get('content-type')??'').startsWith('application/json')||request.headers.get('sec-fetch-site')==='cross-site'))return response(403,{error:'DSH画面からの本人操作を確認できません。'});
      const input=await request.json(),result=await manager.submit(input,{cookie:request.headers.get('cookie')});
      return response(result.created?202:200,result);
    }catch(e){return response(Number.isInteger(e?.status)?e.status:503,{error:Number.isInteger(e?.status)?e.message:'サービスの状態を確認できません。自動で再送しません。'});}
  };
}
export function serviceSettingsHandler({settings,dshOrigin,mutationAllowed}){
  return async request=>{
    try{
      const url=new URL(request.url);
      if(url.search)return response(400,{error:'要求が不正です。'});
      const context={cookie:request.headers.get('cookie')};
      if(request.method==='GET')return response(200,await settings.read(context));
      if(request.method!=='POST')return response(405,{error:'未対応の操作です。'});
      if(mutationAllowed?!mutationAllowed(request):request.headers.get('origin')!==dshOrigin||request.headers.get('x-local-studio-service-settings')!=='1'||!(request.headers.get('content-type')??'').startsWith('application/json')||request.headers.get('sec-fetch-site')==='cross-site')return response(403,{error:'DSH設定画面からの本人操作を確認できません。'});
      return response(200,await settings.save(await request.json(),context));
    }catch(e){return response(Number.isInteger(e?.status)?e.status:503,{error:Number.isInteger(e?.status)?e.message:'設定の保存結果を確認できません。再読込して確認してください。'});}
  };
}
export async function apply(ctx,config){
  const desktop=controllerSessionMode(config)==='desktop';
  if(desktop)desktopPackagedRuntimeOption({desktopPackagedRuntime:true});
  const root=runtimeRootOf(config);
  const configuration=JSON.parse(await readFile(join(root,'config/environment.json'),'utf8'));
  if(!Number.isInteger(configuration.dshPort)||configuration.dshPort<1024||configuration.dshPort>65535)throw Error('Invalid DSH port');
  const hostOrigin=()=>localHostOrigin(ctx.webServer);
  const trust=desktop?createHostDesktopRequestTrust(hostOrigin):null;
  const adapter=await createSystemAdapter({root,...(desktop?{hostOrigin}:{})}),manager=await createServiceManager({root,adapter}),settings=await createServiceSettings({root,adapter,manager});
  ctx.effect(()=>()=>manager.dispose());
  if(trust){ctx.effect(()=>registerDesktopProof(ctx,'/api/local-studio/desktop-proof/services',trust,{method:'POST',path:SERVICES_PATH}));ctx.effect(()=>registerDesktopProof(ctx,'/api/local-studio/desktop-proof/service-settings',trust,{method:'POST',path:SETTINGS_PATH}));}
  const dshOrigin=`http://127.0.0.1:${configuration.dshPort}`;
  ctx.effect(()=>ctx.connection.fetch.register({path:SERVICES_PATH,methods:['GET','POST'],requestBody:'buffered',fetch:servicesHandler({manager,dshOrigin,...(trust?{mutationAllowed:request=>trust.mutationAllowed(request,{marker:'x-local-studio-service'})}:{})})}));
  ctx.effect(()=>ctx.connection.fetch.register({path:SETTINGS_PATH,methods:['GET','POST'],requestBody:'buffered',fetch:serviceSettingsHandler({settings,dshOrigin,...(trust?{mutationAllowed:request=>trust.mutationAllowed(request,{marker:'x-local-studio-service-settings'})}:{})})}));
}
