import {lstat,open,readFile,unlink} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRuntimeConfig,runtimeRootOf} from '../shared/plugin-config.mjs';
import {createSystemAdapter,createServiceManager} from './service-manager.mjs';
import {createServiceSettings} from './service-settings.mjs';
import {controllerSessionMode,withControllerSessionNamespace} from '../shared/controller-session.mjs';
import {createHostDesktopRequestTrust,registerDesktopProof} from '../shared/desktop-request-trust.mjs';
import {desktopPackagedRuntimeOption,withDesktopPackagedRuntime} from '../local-genai/runtime.mjs';
import {isLocalJsonMutation,jsonResponse as response,localHostOrigin} from '../shared/web-route.mjs';
import {engines,readEngineSettings,validateEngineSettings} from './engine-settings.mjs';
export const name='studio-services';
export const Config=withDesktopPackagedRuntime(withControllerSessionNamespace(createRuntimeConfig({allowUnknown:true}),{allowedKeys:['desktopPackagedRuntime']}));
export const inject=['connection','webServer'];
export const SERVICES_PATH='/api/local-studio/services';
export const SETTINGS_PATH='/api/local-studio/service-settings';
export const ENGINE_SETTINGS_PATH='/api/local-studio/engine-settings';
const serviceMarker='x-local-studio-service',settingsMarker='x-local-studio-service-settings';
const allowWebMutation=(hostOrigin,marker)=>request=>isLocalJsonMutation(request,typeof hostOrigin==='function'?hostOrigin():hostOrigin,marker);
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function servicesHandler({manager,dshOrigin,mutationAllowed=allowWebMutation(dshOrigin,serviceMarker)}){
  return async request=>{
    try{
      const url=new URL(request.url);
      if(request.method==='GET'){
        if([...url.searchParams.keys()].some(k=>k!=='requestId')||url.searchParams.getAll('requestId').length>1)return response(400,{error:'要求が不正です。'});
        const requestId=url.searchParams.get('requestId');if(requestId!==null&&!uuid.test(requestId))return response(400,{error:'要求IDが不正です。'});
        return response(200,await manager.snapshot(requestId??undefined));
      }
      if(request.method!=='POST')return response(405,{error:'未対応の操作です。'});
      if(url.search||!mutationAllowed(request))return response(403,{error:'DSH画面からの本人操作を確認できません。'});
      const input=await request.json(),result=await manager.submit(input,{cookie:request.headers.get('cookie')});
      return response(result.created?202:200,result);
    }catch(e){return response(Number.isInteger(e?.status)?e.status:503,{error:Number.isInteger(e?.status)?e.message:'サービスの状態を確認できません。自動で再送しません。'});}
  };
}
export function serviceSettingsHandler({settings,dshOrigin,mutationAllowed=allowWebMutation(dshOrigin,settingsMarker)}){
  return async request=>{
    try{
      const url=new URL(request.url);
      if(url.search)return response(400,{error:'要求が不正です。'});
      const context={cookie:request.headers.get('cookie')};
      if(request.method==='GET')return response(200,await settings.read(context));
      if(request.method!=='POST')return response(405,{error:'未対応の操作です。'});
      if(!mutationAllowed(request))return response(403,{error:'DSH設定画面からの本人操作を確認できません。'});
      return response(200,await settings.save(await request.json(),context));
    }catch(e){return response(Number.isInteger(e?.status)?e.status:503,{error:Number.isInteger(e?.status)?e.message:'設定の保存結果を確認できません。再読込して確認してください。'});}
  };
}
async function writeEngineSettings(root,engine,input){
  const script=fileURLToPath(new URL('../../../scripts/Save-EngineSettings.ps1',import.meta.url));
  const info=await lstat(script);
  if(!info.isFile()||info.isSymbolicLink())throw Error('Engine settings writer is not a regular file');
  return new Promise((done,fail)=>{
    const child=spawn('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',script,'-RuntimeRoot',root,'-Engine',engine],{
      cwd:root,windowsHide:true,stdio:['pipe','pipe','ignore'],shell:false,
    });
    let output='';
    child.stdout.setEncoding('utf8').on('data',chunk=>{output=(output+chunk).slice(-8192);});
    child.once('error',fail);
    child.stdin.on('error',fail);
    child.once('close',code=>{
      try{
        const result=JSON.parse(output.trim());
        if(code!==0)throw Error('Engine settings writer failed');
        if(result.status)throw Object.assign(Error(result.error),{status:result.status});
        done();
      }catch(error){fail(error);}
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export function engineSettingsHandler({root,adapter,manager,dshOrigin,writer=writeEngineSettings,mutationAllowed=allowWebMutation(dshOrigin,settingsMarker)}){
  const busy=message=>Object.assign(Error(message),{status:409});
  const lockPath=join(root,'runtime/Studio-services.lock');
  async function snapshot(engine){
    const current=await readEngineSettings(root,engine),state=(await adapter.snapshot()).services.find(item=>item.id===engine)?.state??'unknown';
    let runningMatches=null;
    if(state==='running'){
      const record=JSON.parse(await readFile(join(root,'runtime',engine+'.json'),'utf8'));
      if(engine==='Strata'&&record.configSha256)runningMatches=record.configSha256===current.launchRevision;
      if(engine==='ComfyUI'&&record.comfyTuning)runningMatches=Object.keys(current.values).every(key=>record.comfyTuning[key]===current.values[key]);
    }
    return {values:current.values,editable:current.editable,revision:current.revision,state,runningMatches};
  }
  return async request=>{
    try{
      const url=new URL(request.url),engine=url.searchParams.get('engine');
      if([...url.searchParams].length!==1||!engines.includes(engine))return response(400,{error:'設定対象が不正です。'});
      if(request.method==='GET')return response(200,await snapshot(engine));
      if(request.method!=='POST')return response(405,{error:'未対応の操作です。'});
      if(!mutationAllowed(request))return response(403,{error:'DSH設定画面からの本人操作を確認できません。'});
      const input=await request.json();
      validateEngineSettings(engine,input?.values);
      let lock;
      try{
        const directory=await lstat(join(root,'runtime'));
        if(directory.isSymbolicLink()||!directory.isDirectory())throw Error('Untrusted settings lock');
        try{lock=await open(lockPath,'wx');}catch(error){if(error.code!=='EEXIST')throw error;throw busy('サービス操作中です。終了後に保存してください。');}
        const before=await manager.snapshot();
        if(before.operation&&!['completed','failed','cancelled','succeeded'].includes(before.operation.state))throw busy('未解決のサービス操作を確認してください。');
        const state=before.services.find(item=>item.id===engine)?.state;
        if(!['stopped','running'].includes(state))throw busy('管理対象のサービス状態を確認できません。');
        // Atomic file replacement changes the next launch only. An in-flight
        // Strata service must keep its launch-time identity and settings.
        await writer(root,engine,input);
        adapter.reload?.();
        manager.invalidateCache?.();
        return response(200,await snapshot(engine));
      }finally{if(lock){await lock.close();await unlink(lockPath);}}
    }catch(error){
      return response(Number.isInteger(error?.status)?error.status:503,{error:Number.isInteger(error?.status)?error.message:'設定の保存または読み取りを確認できません。再読込してください。'});
    }
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
  if(trust)ctx.effect(()=>registerDesktopProof(ctx,'/api/local-studio/desktop-proof/engine-settings',trust,{method:'POST',path:ENGINE_SETTINGS_PATH}));
  ctx.effect(()=>ctx.connection.fetch.register({path:SERVICES_PATH,methods:['GET','POST'],requestBody:'buffered',fetch:servicesHandler({manager,dshOrigin:hostOrigin,...(trust?{mutationAllowed:request=>trust.mutationAllowed(request,{marker:serviceMarker})}:{})})}));
  ctx.effect(()=>ctx.connection.fetch.register({path:SETTINGS_PATH,methods:['GET','POST'],requestBody:'buffered',fetch:serviceSettingsHandler({settings,dshOrigin:hostOrigin,...(trust?{mutationAllowed:request=>trust.mutationAllowed(request,{marker:settingsMarker})}:{})})}));
  ctx.effect(()=>ctx.connection.fetch.register({path:ENGINE_SETTINGS_PATH,methods:['GET','POST'],requestBody:'buffered',fetch:engineSettingsHandler({root,adapter,manager,dshOrigin:hostOrigin,...(trust?{mutationAllowed:request=>trust.mutationAllowed(request,{marker:settingsMarker})}:{})})}));
}
