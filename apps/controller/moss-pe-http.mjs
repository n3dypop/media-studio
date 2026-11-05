// Route helper only; the server must supply auth, Host/origin and body limits.
// The caller must keep enabled=false until the runtime and handoff are qualified.
import {ApiError} from './store.mjs';
import {validateSession} from './productions.mjs';
import {scheduleOwnedLaunch} from './owned-launch.mjs';

export async function mossPeRoute({req,res,path,url,body,json,mossPe,productions=mossPe?.productions,enabled=false,basePath='/api/moss-pe'}){
  if(!['/api/moss-pe','/api/qwen-pe'].includes(basePath))throw new TypeError('Invalid PE route');
  if(path!==basePath&&!path.startsWith(basePath+'/'))return false;
  if(path===`${basePath}/status`&&req.method==='GET'){
    validateSession(req.headers['x-dsh-session']);
    json(res,200,mossPe&&enabled?await mossPe.availability(url.searchParams.get('mode')??'t2i'):{available:false,scope:`official-${basePath.includes('qwen')?'qwen':'moss'}-prompt-enhancement`,reason:'not-qualified'});return true;
  }
  if(!mossPe||!enabled){
    const match=path===basePath?null:path.slice(basePath.length).match(/^\/([a-f0-9-]{36})\/(decision|reconcile)$/),operation=path===basePath?'start':match?.[2],target=match?.[1];
    if(req.method==='POST'&&operation&&productions){
      const session=validateSession(req.headers['x-dsh-session']),input=await body(req,1048576),targetId=operation==='start'?input?.productionId:target;
      if(typeof input?.requestId==='string'&&/^[-a-zA-Z0-9_]{16,100}$/.test(input.requestId)&&typeof targetId==='string'&&/^[a-f0-9-]{36}$/.test(targetId)){
        let receipt;try{receipt=productions.rejectUnadmittedMutation(session,`${basePath.includes('qwen')?'qwen':'moss'}-pe-${operation}`,targetId,input,409);}catch{throw new ApiError(503,'PE availability or admission could not be verified; do not retry');}
        json(res,receipt.httpStatus,{error:'PE is unavailable and the request was rejected before admission',receipt});return true;
      }
    }
    throw new ApiError(503,'MOSS prompt enhancement is not yet qualified');
  }
  const session=validateSession(req.headers['x-dsh-session']);
  const rejectBeforeAdmission=(operation,targetId,input,error)=>{
    if(typeof input?.requestId!=='string'||!/^[-a-zA-Z0-9_]{16,100}$/.test(input.requestId)||typeof targetId!=='string'||!/^[a-f0-9-]{36}$/.test(targetId)||!Number.isInteger(error?.status)||error.status<400||error.status>499)throw error;
    let receipt;try{receipt=mossPe.productions.rejectUnadmittedMutation(session,`${mossPe.family}-pe-${operation}`,targetId,input,error.status);}catch{throw new ApiError(503,'PE admission could not be verified; do not retry');}
    json(res,receipt.httpStatus,{error:'PE request was rejected before admission',receipt});
  };
  if(path===basePath&&req.method==='GET'){
    if([...url.searchParams.keys()].some(key=>!['productionId','requestId'].includes(key))||url.searchParams.getAll('productionId').length!==1||url.searchParams.getAll('requestId').length!==1)throw new ApiError(400,'Exactly one production and PE request ID are required');
    const productionId=url.searchParams.get('productionId'),requestId=url.searchParams.get('requestId');
    const found=mossPe.findStartReceipt(productionId,session,requestId);
    json(res,200,found??{run:mossPe.find(productionId,session,requestId)});return true;
  }
  if(path===basePath&&req.method==='POST'){
    const input=await body(req);
    let result;
    try{
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['productionId','requestId','expectedRevision','prompt','seed','reason','inputAssetId','inputAssetIds','thinking','maxLength'].includes(k)))throw new ApiError(400,'Invalid PE request');
    if(mossPe.family==='qwen'&&await mossPe.licenseCheck()!==true)throw new ApiError(403,'Qwen research license and intended purpose are unconfirmed');
    result=mossPe.create(input.productionId,session,input);
    }catch(error){rejectBeforeAdmission('start',input?.productionId,input,error);return true;}
    if(result.created)scheduleOwnedLaunch({store:mossPe.store,run:result.run,launch:()=>mossPe.launch(result.run.id)});
    json(res,result.created?202:200,result);return true;
  }
  const match=path.slice(basePath.length).match(/^\/([a-f0-9-]{36})(?:\/(decision|decision-by-request|cancel|reconcile|reconcile-by-request))?$/);
  if(!match)throw new ApiError(404,'PE request not found');
  const [,id,action]=match;
  if(action==='decision'&&req.method==='POST'){
    const input=await body(req,1048576);let result;try{result=mossPe.decide(id,session,input);}catch(error){rejectBeforeAdmission('decision',id,input,error);return true;}json(res,200,result);return true;
  }
  if(action==='reconcile'&&req.method==='POST'){
    const input=await body(req);let accepted,run;
    try{run=mossPe.get(id,session);if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>key!=='requestId'))throw new ApiError(400,'Reconcile accepts only an optional request ID');accepted=input.requestId===undefined?null:mossPe.acceptReconcile(id,session,input);}catch(error){rejectBeforeAdmission('reconcile',id,input,error);return true;}
    try{if((!accepted||accepted.created)&&!mossPe.work.has(id)&&!['completed','failed','cancelled'].includes(run.phase))scheduleOwnedLaunch({store:mossPe.store,run,launch:()=>{const current=mossPe.get(id,session);if(current.productionId!==run.productionId||current.requestId!==run.requestId||current.controllerId!==run.controllerId||current.kind!==run.kind)throw Error('PE ownership changed before deferred recovery');if(!['completed','failed','cancelled'].includes(current.phase))return mossPe.launch(id,{recovery:true});}});}catch(error){if(accepted)throw new ApiError(503,'PE reconciliation was accepted but scheduling could not be confirmed; inspect the receipt and run without resubmitting');throw error;}
    json(res,202,accepted??{run});return true;
  }
  const run=mossPe.get(id,session);
  if(!action&&req.method==='GET'){json(res,200,{run});return true;}
  if(action==='decision-by-request'&&req.method==='GET'){
    if([...url.searchParams.keys()].some(key=>key!=='requestId')||url.searchParams.getAll('requestId').length!==1)throw new ApiError(400,'Exactly one PE decision request ID is required');
    json(res,200,mossPe.findDecision(id,session,url.searchParams.get('requestId')));return true;
  }
  if(action==='reconcile-by-request'&&req.method==='GET'){
    if([...url.searchParams.keys()].some(key=>key!=='requestId')||url.searchParams.getAll('requestId').length!==1)throw new ApiError(400,'Exactly one PE reconciliation request ID is required');
    json(res,200,mossPe.findReconcile(id,session,url.searchParams.get('requestId')));return true;
  }
  if(action==='cancel'&&req.method==='POST'){
    const input=await body(req);if(!input||Object.keys(input).length)throw new ApiError(400,'Cancel accepts an empty JSON object');
    const next=mossPe.cancel(id,session);
    if(!mossPe.work.has(id)&&!['completed','failed','cancelled'].includes(next.phase))scheduleOwnedLaunch({store:mossPe.store,run:next,launch:()=>mossPe.launch(id,{recovery:true})});
    json(res,202,{run:next});return true;
  }
  throw new ApiError(404,'PE request not found');
}
