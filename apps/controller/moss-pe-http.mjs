// Route helper only; the server must supply auth, Host/origin and body limits.
// The caller must keep enabled=false until the runtime and handoff are qualified.
import {ApiError} from './store.mjs';
import {validateSession} from './productions.mjs';
import {scheduleOwnedLaunch} from './owned-launch.mjs';

export async function mossPeRoute({req,res,path,url,body,json,mossPe,enabled=false,basePath='/api/moss-pe'}){
  if(!['/api/moss-pe','/api/qwen-pe'].includes(basePath))throw new TypeError('Invalid PE route');
  if(path!==basePath&&!path.startsWith(basePath+'/'))return false;
  if(path===`${basePath}/status`&&req.method==='GET'){
    validateSession(req.headers['x-dsh-session']);
    json(res,200,mossPe&&enabled?await mossPe.availability(url.searchParams.get('mode')??'t2i'):{available:false,scope:`official-${basePath.includes('qwen')?'qwen':'moss'}-prompt-enhancement`,reason:'not-qualified'});return true;
  }
  if(!mossPe||!enabled)throw new ApiError(503,'MOSS prompt enhancement is not yet qualified');
  const session=validateSession(req.headers['x-dsh-session']);
  if(path===basePath&&req.method==='GET'){
    const run=mossPe.find(url.searchParams.get('productionId'),session,url.searchParams.get('requestId'));
    json(res,200,{run});return true;
  }
  if(path===basePath&&req.method==='POST'){
    const input=await body(req);
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['productionId','requestId','expectedRevision','prompt','seed','reason','inputAssetId','inputAssetIds','thinking','maxLength'].includes(k)))throw new ApiError(400,'Invalid PE request');
    if(mossPe.family==='qwen'&&await mossPe.licenseCheck()!==true)throw new ApiError(403,'Qwen research license and intended purpose are unconfirmed');
    const result=mossPe.create(input.productionId,session,input);
    if(result.created)scheduleOwnedLaunch({store:mossPe.store,run:result.run,launch:()=>mossPe.launch(result.run.id)});
    json(res,result.created?202:200,result);return true;
  }
  const match=path.slice(basePath.length).match(/^\/([a-f0-9-]{36})(?:\/(decision|cancel|reconcile))?$/);
  if(!match)throw new ApiError(404,'PE request not found');
  const [,id,action]=match,run=mossPe.get(id,session);
  if(!action&&req.method==='GET'){json(res,200,{run});return true;}
  if(action==='decision'&&req.method==='POST'){json(res,200,mossPe.decide(id,session,await body(req,1048576)));return true;}
  if(action==='cancel'&&req.method==='POST'){
    const input=await body(req);if(!input||Object.keys(input).length)throw new ApiError(400,'Cancel accepts an empty JSON object');
    const next=mossPe.cancel(id,session);
    if(!mossPe.work.has(id)&&!['completed','failed','cancelled'].includes(next.phase))scheduleOwnedLaunch({store:mossPe.store,run:next,launch:()=>mossPe.launch(id,{recovery:true})});
    json(res,202,{run:next});return true;
  }
  if(action==='reconcile'&&req.method==='POST'){
    const input=await body(req);if(!input||Object.keys(input).length)throw new ApiError(400,'Reconcile accepts an empty JSON object');
    if(!mossPe.work.has(id)&&!['completed','failed','cancelled'].includes(run.phase))scheduleOwnedLaunch({store:mossPe.store,run,launch:()=>mossPe.launch(id,{recovery:true})});
    json(res,202,{run});return true;
  }
  throw new ApiError(404,'PE request not found');
}
