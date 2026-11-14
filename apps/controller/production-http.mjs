import {ApiError,digest} from './store.mjs';
import {validateSession,isDefiniteWorkflowRejection} from './productions.mjs';
import {assertActiveProfile,usesPreparedWorkflow} from './media-modes.mjs';
import {isDeepStrictEqual} from 'node:util';
import {randomUUID} from 'node:crypto';
import {scheduleOwnedLaunch} from './owned-launch.mjs';
import {relayAttestedSse} from './durable-wire-transport.mjs';

// Read and verify every listed run before scheduling any cleanup. A changed
// owner after acceptance means the cancellation outcome needs attention; it
// must never authorize launching a foreign run.
function scheduleProductionCancellation({store,engine,production,productionId,session}) {
  if(!production||production.id!==productionId||production.sessionId!==session||!Array.isArray(production.attempts)||new Set(production.attempts).size!==production.attempts.length)throw Error('Cancellation ownership unavailable');
  const stopped=new Set(['completed','cancelled','failed']),keys=['id','requestId','controllerId','sessionId','productionId','kind'];
  const owned=production.attempts.map(id=>{
    const run=store.get(id);
    if(!run||run.id!==id||run.productionId!==productionId||run.sessionId!==session||(!stopped.has(run.phase)&&run.cancelRequested!==true))throw Error('Cancellation run ownership or flag differs');
    return run;
  });
  for(const run of owned) {
    if(stopped.has(run.phase)||engine.work.has(run.id))continue;
    scheduleOwnedLaunch({store,run,launch:()=>{
      const current=store.get(run.id);
      if(!current||keys.some(key=>current[key]!==run[key]))throw Error('Cancellation run owner changed');
      if(stopped.has(current.phase)||engine.work.has(run.id))return;
      if(current.cancelRequested!==true)throw Error('Cancellation flag changed');
      return engine.launch(run.id,true);
    }});
  }
}

export async function productionRoute({req,res,path,url,role,store,engine,productions,workflows,mossPe,qwenPe,body,json,abortSession=()=>{},cancelProductionPe=()=>{},validateStopTurn=()=>{}}) {
  if(!productions||!workflows) return false;
  if(!path.startsWith('/api/productions')&&!path.startsWith('/api/workflow')) return false;
  const targetId=path.match(/^\/api\/productions\/([a-f0-9-]{36})/)?.[1];
  const session=validateSession(req.headers['x-dsh-session']??(role==='admin'&&targetId?productions.ownerOf(targetId):null));
  const rejectBeforeAdmission=(operation,id,input,error)=>{
    if(role!=='dsh'||typeof input?.requestId!=='string'||!/^[-a-zA-Z0-9_]{16,100}$/.test(input.requestId)||!Number.isInteger(error?.status)||error.status<400||error.status>499)throw error;
    let receipt;try{receipt=productions.rejectUnadmittedMutation(session,operation,id,input,error.status);}catch{throw new ApiError(503,'要求の受付状態を確認できません。再送せず照合してください。');}
    json(res,receipt.httpStatus,{error:'要求は受付前に拒否されました。',receipt});
  };
  if(path==='/api/productions/mutation-rejections/by-request'&&req.method==='GET'){
    if(role!=='dsh'||[...url.searchParams.keys()].some(key=>!['operation','requestId'].includes(key))||url.searchParams.getAll('operation').length!==1||url.searchParams.getAll('requestId').length!==1)throw new ApiError(400,'操作と要求IDを指定してください。');
    json(res,200,productions.findMutationRejection(session,url.searchParams.get('operation'),url.searchParams.get('requestId')));return true;
  }
  if(path==='/api/workflow-requests/by-request'&&req.method==='GET') {
    if([...url.searchParams.keys()].some(key=>key!=='requestId')||url.searchParams.getAll('requestId').length!==1)throw new ApiError(400,'workflow要求IDを一つ指定してください。');
    json(res,200,productions.inspectWorkflowRequest(session,url.searchParams.get('requestId')));return true;
  }
  if(path==='/api/workflow-requests/abandon'&&req.method==='POST') {
    if(role!=='admin')throw new ApiError(403,'workflow受付の放棄は保守担当のみ実行できます。');
    json(res,200,productions.abandonWorkflowFence(session,await body(req)));return true;
  }
  if(path==='/api/workflow-catalog'&&req.method==='GET') {json(res,200,await workflows.catalog({modelProfile:url.searchParams.get('modelProfile')??undefined,mode:url.searchParams.get('mode')??undefined,inputAssetId:url.searchParams.get('inputAssetId'),sessionId:session}));return true;}
  if (path === '/api/workflow-library/selection' && req.method === 'POST') {
    const input = await body(req, 65536);
    if (url.search || typeof input?.reference !== 'string') throw new ApiError(400, 'A workflow reference is required');
    const result = await workflows.library({reference:input.reference,limit:25});
    json(res,200,{state:result.state,total:result.total,workflows:result.workflows.map(({id,label,mode,file,dshProfile,unavailableDshProfile,state,recommendation})=>({id,label,mode,file,dshProfile,unavailableDshProfile,state,recommendation}))});return true;
  }
  if (path === '/api/workflow-library' && req.method === 'GET') {
    const filters = url.searchParams, keys = ['id', 'query', 'mode', 'media', 'details', 'page', 'limit'];
    if ([...filters.keys()].some(key => !keys.includes(key) || filters.getAll(key).length !== 1)) {
      throw new ApiError(400, 'Invalid workflow library filter');
    }
    const options = Object.fromEntries([...filters].map(([key, value]) =>
      [key, ['page', 'limit'].includes(key) ? (/^[1-9][0-9]*$/.test(value) ? Number(value) : NaN) : value]));
    json(res, 200, await workflows.library(options));
    return true;
  }
  if(path==='/api/productions'&&req.method==='POST') {
    const input=await body(req);
    let result;
    try{
    const requestedProfile=input?.modelProfile??input?.brief?.modelProfile??productions.defaultModelProfile;
    // Retired profiles are read-only, including formerly idempotent POSTs.
    assertActiveProfile(requestedProfile);
    // Preserve replay of an existing request ID even if model availability has
    // changed since it was recorded. A new production must use a currently
    // listed profile; discovery failure is not proof that a model is available.
    if(!productions.list(session,input?.requestId).some(p=>p.requestId===input?.requestId)){
      const current=await workflows.catalog({modelProfile:requestedProfile,mode:input?.brief?.mode??undefined,
        includeCatalogCandidates:role==='admin'&&/^catalog-smoke-[a-f0-9-]{36}$/.test(session),
        inputAssetId:input?.brief?.inputAssetId??null,sessionId:session});
      const requestedMode=input?.brief?.mode??'t2i';
      if(!current.modelProfiles?.some(profile=>profile.id===requestedProfile&&profile.available===true)||!current.capabilities?.some(item=>item.modelProfile===requestedProfile&&item.mode===requestedMode))
        throw new ApiError(409,'指定モデルまたはモードは現在の利用可能なカタログにありません。モデル、ノードと対応フローの導入・登録状態を保守担当へ確認してください。別のモデルには変更していません。');
    }
    result=productions.create(session,input);
    }catch(error){rejectBeforeAdmission('create',null,input,error);return true;}
    json(res,result.created?201:200,result);return true;
  }
  if(path==='/api/productions'&&req.method==='GET') {json(res,200,productions.listWithCancellationEvidence(session,url.searchParams.get('requestId')));return true;}
  if(path==='/api/workflows/draft'&&req.method==='POST') {
    const input=await body(req,131072);let preparation=null,adoption=null,admissionAttempted=false,workflowWriteMayHaveStarted=false;
    const fenced=input?.requestId!==undefined;
    if(fenced){
      preparation=productions.reserveWorkflowPreparation(session,input);
      if(!preparation.admitted){
        const current=productions.inspectWorkflowRequest(session,input.requestId);
        json(res,409,{error:'このworkflow要求は受付済み、拒否済み、または結果未確認です。再送せず元の受付を照合してください。',...current});return true;
      }
    }
    try {
    const p=productions.get(input.productionId,session);
    productions.check(p,input.expectedRevision,{allowedPreparation:fenced?preparation.requestId:null});
    if(!fenced)productions.assertNoPendingWorkflow(p.id,session);
    assertActiveProfile(p.brief.modelProfile);
    if((input.modelProfile??workflows.profileId??'qwen-photo-v1')!==(p.brief.modelProfile??'qwen-photo-v1'))throw new ApiError(409,'制作で指定した画像モデルとワークフローのモデルが一致しません。');
    const workflow=await workflows.saveDraft({...input,mode:input.mode??p.brief.mode??'t2i',inputAssetId:input.inputAssetId??p.brief.inputAssetId??null,briefInputIds:p.brief.inputAssetIds??(p.brief.inputAssetId?[p.brief.inputAssetId]:[]),sessionId:session,beforeWrite:async snapshot=>{
      if(input.enhancementRunId!==undefined){
        const kind=store.get(input.enhancementRunId)?.kind,coordinator=kind==='qwen-pe'?qwenPe:kind==='moss-pe'?mossPe:null;
        if(!coordinator)throw new ApiError(409,'PE adoption run or service unavailable');
        if(kind==='qwen-pe'&&await coordinator.licenseCheck()!==true)throw new ApiError(403,'Qwen research license purpose is unconfirmed');
        adoption=coordinator.assertWorkflowAdoption(input.enhancementRunId,session,p.id,snapshot);
      }
      if(fenced)productions.confirmWorkflowPreparation(p.id,session,input.expectedRevision,preparation);
      else {admissionAttempted=true;preparation=productions.beginWorkflowPreparation(p.id,session,{...input,requestId:randomUUID()});}
      workflowWriteMayHaveStarted=true;
    }});
    if(!preparation)throw new ApiError(503,'workflow受付記録がありません。結果を保留してください。');
    const production=productions.bindWorkflow(p.id,session,input.expectedRevision,workflow,adoption,preparation);
    json(res,201,{workflow,production,validation:{valid:true}});return true;
    } catch (error) {
      if(fenced&&!workflowWriteMayHaveStarted){
        const status=Number.isInteger(error?.status)&&error.status>=400&&error.status<500?error.status:400;
        let receipt;try{receipt=productions.rejectWorkflowPreparation(session,input.productionId,input,preparation,status);}catch{throw new ApiError(503,'workflow受付の結果を確認できません。元の要求を照合し、再送せず保留してください。');}
        json(res,status,{error:typeof error?.message==='string'?error.message:'保存前のworkflow検証に失敗しました。',receipt});return true;
      }
      if(fenced)throw new ApiError(503,'workflow要求の途中結果を確認できません。要求IDで照合し、再送せず保留してください。');
      if(!admissionAttempted||isDefiniteWorkflowRejection(error)){if(Number.isInteger(error?.status)&&error.status>=400&&error.status<500)throw error;throw new ApiError(400,'保存前のworkflow検証に失敗しました。workflowは作成していません。');}
      throw new ApiError(503,'workflow要求の途中結果を確認できません。要求IDで照合し、再送せず保留してください。');
    }
  }
  const match=path.match(/^\/api\/productions\/([a-f0-9-]{36})(?:\/(render|render-prepared|evaluate|iteration|feedback|cancel|cancel-owned|cancel-by-request|user-decision|planning-delivery|latest-completed|run-by-request|workflow-by-request|workflow-recovery|operation-by-request))?$/);
  if(!match) throw new ApiError(404,'制作APIがありません。');
  const [,id,action]=match;
  if(req.method==='POST'&&['evaluate','iteration','feedback'].includes(action)){
    const input=await body(req);let result;
    try{productions.get(id,session);productions.assertNoPendingWorkflow(id,session);result=action==='evaluate'?productions.evaluate(id,session,input):action==='iteration'?productions.planIteration(id,session,input):productions.resumeWithFeedback(id,session,input);}
    catch(error){rejectBeforeAdmission(action,id,input,error);return true;}
    json(res,action==='evaluate'?200:action==='iteration'?201:result.created?201:200,result);return true;
  }
  if(req.method==='POST'&&['render','render-prepared'].includes(action)){
    const input=await body(req),operation=action==='render'?'render':'prepared-render';let result;
    try{
      const production=productions.get(id,session);productions.assertNoPendingWorkflow(id,session);assertActiveProfile(production.brief.modelProfile);
      if(action==='render'&&usesPreparedWorkflow(production.brief.modelProfile))throw new ApiError(409,'この公式workflowは保存済み条件で生成してください。render-preparedを使用し、設定変更は新しいdraftに固定してください。');
      if(action==='render-prepared'&&(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['requestId','workflowId','expectedRevision'].includes(key))||typeof input.workflowId!=='string'||!Number.isSafeInteger(input.expectedRevision)))throw new ApiError(400,'workflowId、expectedRevision、requestIdのみを指定してください。');
      const workflow=await workflows.get(input.workflowId);result=action==='render'?productions.render(id,session,input,workflow):productions.renderPrepared(id,session,input,workflow);
    }catch(error){rejectBeforeAdmission(operation,id,input,error);return true;}
    try{if(result.created)scheduleOwnedLaunch({store,run:result.run,launch:()=>engine.launch(result.run.id)});}catch{throw new ApiError(503,'生成受付後の起動状態を確認できません。照合してください。');}
    json(res,result.created?202:200,{run:result.run,production:result.production});return true;
  }
  if(req.method==='POST'&&action==='cancel'){
    const input=await body(req);let result,p;
    try{productions.get(id,session);if(input.expectedRunId!==undefined&&(typeof input.expectedRunId!=='string'||!Number.isSafeInteger(input.expectedRevision)))throw new ApiError(400,'停止対象の生成情報が不正です。');validateStopTurn(session,input.searchTurn);result=input.requestId===undefined?null:productions.cancelWithReceipt(id,session,input,'cancel');if(!result)p=productions.cancel(id,session,{expectedRunId:input.expectedRunId,expectedRevision:input.expectedRevision});}
    catch(error){rejectBeforeAdmission('cancel',id,input,error);return true;}
    if(result&&!result.created){json(res,200,result);return true;}p=result?.production??p;
    let stopError;try{cancelProductionPe(p,session);}catch(error){stopError=error;}try{abortSession(session,input.searchTurn);}catch(error){stopError??=error;}try{scheduleProductionCancellation({store,engine,production:p,productionId:id,session});}catch(error){stopError??=error;}
    if(stopError)throw new ApiError(503,'停止の受付後に処理結果を確認できません。再送せず、この制作の状態を確認してください。');json(res,202,result??{production:p});return true;
  }
  const production=productions.get(id,session);
  if(req.method==='POST'&&action&&!['cancel','cancel-owned','workflow-recovery'].includes(action))productions.assertNoPendingWorkflow(id,session);
  if(!action&&req.method==='GET') {
    if(url.searchParams.get('includeWorkflowAdvisories')==='1') {
      const {modelProfile:profile,mode='t2i'}=production.brief;
      const advisories=(await workflows.library({profile,mode,advisoriesOnly:true})).workflows;
      json(res,200,{production,workflowAdvisories:advisories});return true;
    }
    json(res,200,{production});return true;
  }
  if(action==='cancel-by-request'&&req.method==='GET') {
    if([...url.searchParams.keys()].some(key=>key!=='requestId')||url.searchParams.getAll('requestId').length!==1)throw new ApiError(400,'停止要求IDを一つ指定してください。');
    const result=productions.findCancelByRequest(id,session,url.searchParams.get('requestId'));
    json(res,200,{...result,guidance:'This receipt proves only the recorded cancellation request. Observe the owned job and resource state separately; no retry or cleanup is implied.'});return true;
  }
  if(action==='operation-by-request'&&req.method==='GET') {
    if([...url.searchParams.keys()].some(key=>!['requestId','operation'].includes(key))||url.searchParams.getAll('requestId').length!==1||url.searchParams.getAll('operation').length!==1)throw new ApiError(400,'操作と要求IDをそれぞれ一つ指定してください。');
    json(res,200,productions.findActionByRequest(id,session,url.searchParams.get('operation'),url.searchParams.get('requestId')));return true;
  }
  if(action==='workflow-recovery') {
    if(role!=='admin')throw new ApiError(403,'workflow受付の復旧は保守担当のみ実行できます。');
    if(req.method==='GET') {
      if([...url.searchParams.keys()].some(key=>key!=='requestId')||url.searchParams.getAll('requestId').length!==1)throw new ApiError(400,'workflow要求IDを一つ指定してください。');
      json(res,200,productions.inspectWorkflowRecovery(id,session,url.searchParams.get('requestId')));return true;
    }
    if(req.method==='POST') {json(res,200,productions.abandonWorkflowPreparation(id,session,await body(req)));return true;}
    throw new ApiError(405,'この操作は対応していません。');
  }
  if(action==='workflow-by-request'&&req.method==='GET') {
    if([...url.searchParams.keys()].some(key=>key!=='requestId')||url.searchParams.getAll('requestId').length!==1)throw new ApiError(400,'workflow要求IDを一つ指定してください。');
    const result=productions.findWorkflowPreparation(id,session,url.searchParams.get('requestId'));
    let workflow;try{workflow=await workflows.get(result.receipt.workflowId);}catch{throw new ApiError(409,'保存済みworkflowを確認できません。再送せず保留してください。');}
    if(workflow.productionId!==id||workflow.id!==result.receipt.workflowId||workflow.sha256!==result.receipt.workflowHash||workflow.modelProfile!==result.production.brief.modelProfile||digest(workflow)!==result.receipt.snapshotHash)throw new ApiError(409,'workflow記録の所有情報またはhashが一致しません。');
    json(res,200,{...result,workflow});return true;
  }
  if(action==='run-by-request'&&req.method==='GET') {
    if([...url.searchParams.keys()].some(key=>key!=='requestId')||url.searchParams.getAll('requestId').length!==1)throw new ApiError(400,'生成要求IDを一つ指定してください。');
    const result=productions.findRenderByRequest(id,session,url.searchParams.get('requestId'));
    let saved;
    try {
      if(typeof result.run?.spec?.workflow?.id!=='string')throw Error('Missing workflow identity');
      saved=await workflows.get(result.run.spec.workflow.id);
      if(!saved||saved.productionId!==id||!isDeepStrictEqual(saved,result.run.spec.workflow))throw Error('Saved workflow differs');
    } catch { throw new ApiError(409,'保存済みworkflowと生成時の条件が一致することを確認できません。送信結果は未解決です。'); }
    json(res,200,result);return true;
  }
  if(action==='latest-completed'&&req.method==='GET') {json(res,200,productions.latestCompletedRun(id,session));return true;}
  if(action==='user-decision'&&req.method==='POST'){
    if(role!=='admin')throw new ApiError(403,'採否は本人画面だけが記録できます。');
    const result=productions.userDecision(id,session,await body(req));json(res,result.created?201:200,result);return true;
  }
  if(action==='planning-delivery'&&req.method==='POST'){
    if(role!=='admin')throw new ApiError(403,'検討依頼の送信記録は本人画面だけが使用できます。');
    json(res,200,productions.planningDelivery(id,session,await body(req)));return true;
  }
  if(action==='cancel-owned'&&req.method==='POST'){
    if(role!=='admin')throw new ApiError(403,'制作単独の停止は本人画面だけが使用できます。');
    const input=await body(req);
    if(!Number.isSafeInteger(input.expectedRevision)||!(input.expectedRunId===null||typeof input.expectedRunId==='string'))throw new ApiError(400,'制作の状態と最新runを指定してください。');
    const result=input.requestId===undefined?null:productions.cancelWithReceipt(id,session,input,'cancel-owned');
    if(result&&!result.created){json(res,200,result);return true;}
    const p=result?.production??productions.cancel(id,session,input);
    // Deliberately do not abortSession: another production's inference/search
    // in this conversation must not be cancelled by this production's button.
    let stopError;try{cancelProductionPe(p,session);}catch(error){stopError=error;}
    try{scheduleProductionCancellation({store,engine,production:p,productionId:id,session});}catch(error){stopError??=error;}
    // The durable cancellation has already committed. A later 4xx-shaped
    // cleanup failure is not evidence that no cancellation occurred.
    if(stopError)throw new ApiError(503,'停止の受付後に処理結果を確認できません。再送せず、この制作の状態を確認してください。');
    json(res,202,result??{production:p});return true;
  }
  throw new ApiError(405,'この操作は対応していません。');
}

export function validateInference(input) {
  if(!input||input.model!=='strata-core'||!Array.isArray(input.messages)||!input.messages.length) throw new ApiError(400,'Strata中核モデルとmessagesが必要です。');
  const allowed=new Set(['model','messages','stream','stream_options','store','max_tokens','max_completion_tokens','temperature','top_p','top_k','min_p','tools','tool_choice','parallel_tool_calls','response_format','stop','seed','presence_penalty','frequency_penalty','reasoning_effort']);
  for(const key of Object.keys(input)) if(!allowed.has(key)) throw new ApiError(400,`未対応の推論オプション: ${key}`);
  if(input.store!==undefined&&input.store!==false)throw new ApiError(400,'推論の外部保存は指定できません。');
  let images=0;
  for(const message of input.messages) {
    if(!['system','developer','user','assistant','tool'].includes(message?.role)) throw new ApiError(400,'message roleが不正です。');
    if(Array.isArray(message.content)) for(const item of message.content) {
      if(item.type==='text'&&typeof item.text==='string') continue;
      if(item.type==='image_url'&&typeof item.image_url?.url==='string'&&/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(item.image_url.url)&&item.image_url.url.length<12000000) {images++;continue;}
      throw new ApiError(400,'画像入力にはローカル画像のdata URLだけを使用してください。');
    } else if(typeof message.content!=='string'&&message.content!==null&&message.content!==undefined) throw new ApiError(400,'message contentが不正です。');
  }
  if(images>8) throw new ApiError(400,'1回の推論の画像入力は8枚以内です。');
  return input;
}

export async function inferenceRoute({req,res,path,role,body,json,gate,strata,wireStore=null,wireReader=null,wireSessionId=null,registerInference=()=>()=>{}}) {
  if(!path.startsWith('/v1/')) return false;
  if(!gate||!strata) throw new ApiError(503,'Strata接続の準備が完了していません。');
  if(path==='/v1/models'&&req.method==='GET') {json(res,200,{object:'list',data:[{id:'strata-core',object:'model',owned_by:'local'}]});return true;}
  if(path!=='/v1/chat/completions'||req.method!=='POST') throw new ApiError(404,'対応する推論APIではありません。');
  const input=validateInference(await body(req,24*1024*1024));
  const controller=new AbortController();
  const session=req.headers['x-session-id']??req.headers.session_id;
  const unregister=registerInference(typeof session==='string'?session:null,controller);
  const abort=()=>controller.abort(new Error('DSH connection closed'));
  res.once('close',abort);
  let release;
  try {
    release=await gate.acquireCore(AbortSignal.any([controller.signal,AbortSignal.timeout(1800000)]));
    const upstream=await strata.forward(input,{signal:controller.signal});
    res.writeHead(upstream.status,{'Content-Type':upstream.headers.get('content-type')??'application/json','Cache-Control':'no-store'});
    const write=async chunk=>{
      if(!res.write(Buffer.from(chunk))) await new Promise((resolve,reject)=>{
        const done=()=>{res.off('drain',done);res.off('close',closed);resolve();};
        const closed=()=>{res.off('drain',done);res.off('close',closed);reject(new Error('DSH disconnected'));};
        res.once('drain',done);res.once('close',closed);
      });
    };
    if(role==='dsh'&&wireStore&&wireReader&&typeof wireSessionId==='string')await relayAttestedSse({sessionId:wireSessionId,input,upstream,wireStore,readReceipts:({sessionId,messages})=>wireReader.collect(sessionId,messages),signal:controller.signal,write});
    else if(upstream.body)for await(const chunk of upstream.body)await write(chunk);
    res.end();
  } finally {
    unregister();
    res.off('close',abort);controller.abort();
    await release?.();
  }
  return true;
}
