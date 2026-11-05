import {ApiError,digest} from './store.mjs';
import {validateSession,isDefiniteWorkflowRejection} from './productions.mjs';
import {assertActiveProfile,MOSS_OFFICIAL_IDS,QWEN21_OFFICIAL_IDS} from './media-modes.mjs';
import {isDeepStrictEqual} from 'node:util';
import {randomUUID} from 'node:crypto';
import {scheduleOwnedLaunch} from './owned-launch.mjs';

export async function productionRoute({req,res,path,url,role,store,engine,productions,workflows,mossPe,qwenPe,body,json,abortSession=()=>{},cancelProductionPe=()=>{},validateStopTurn=()=>{}}) {
  if(!productions||!workflows) return false;
  if(!path.startsWith('/api/productions')&&!path.startsWith('/api/workflow')) return false;
  const targetId=path.match(/^\/api\/productions\/([a-f0-9-]{36})/)?.[1];
  const session=validateSession(req.headers['x-dsh-session']??(role==='admin'&&targetId?productions.ownerOf(targetId):null));
  if(path==='/api/workflow-catalog'&&req.method==='GET') {json(res,200,await workflows.catalog({modelProfile:url.searchParams.get('modelProfile')??undefined,mode:url.searchParams.get('mode')??undefined,inputAssetId:url.searchParams.get('inputAssetId'),sessionId:session}));return true;}
  if(path==='/api/productions'&&req.method==='POST') {
    const input=await body(req);
    const requestedProfile=input?.modelProfile??input?.brief?.modelProfile??productions.defaultModelProfile;
    // Retired profiles are read-only, including formerly idempotent POSTs.
    assertActiveProfile(requestedProfile);
    // Preserve replay of an existing request ID even if model availability has
    // changed since it was recorded. A new production must use a currently
    // listed profile; discovery failure is not proof that a model is available.
    if(!productions.list(session,input?.requestId).some(p=>p.requestId===input?.requestId)){
      const current=await workflows.catalog({modelProfile:requestedProfile,mode:input?.brief?.mode??undefined,
        inputAssetId:input?.brief?.inputAssetId??null,sessionId:session});
      const requestedMode=input?.brief?.mode??'t2i';
      if(!current.modelProfiles?.some(profile=>profile.id===requestedProfile&&profile.available===true)||!current.capabilities?.some(item=>item.modelProfile===requestedProfile&&item.mode===requestedMode))
        throw new ApiError(409,'指定モデルまたはモードは現在の利用可能なカタログにありません。モデル、ノードと対応フローの導入・登録状態を保守担当へ確認してください。別のモデルには変更していません。');
    }
    const result=productions.create(session,input);json(res,result.created?201:200,result);return true;
  }
  if(path==='/api/productions'&&req.method==='GET') {json(res,200,{productions:productions.list(session,url.searchParams.get('requestId'))});return true;}
  if(path==='/api/workflows/draft'&&req.method==='POST') {
    const input=await body(req,131072),p=productions.get(input.productionId,session);productions.check(p,input.expectedRevision);productions.assertNoPendingWorkflow(p.id,session);
    assertActiveProfile(p.brief.modelProfile);
    if((input.modelProfile??workflows.profileId??'qwen-photo-v1')!==(p.brief.modelProfile??'qwen-photo-v1'))throw new ApiError(409,'制作で指定した画像モデルとワークフローのモデルが一致しません。');
    let preparation=null,adoption=null,admissionAttempted=false;
    try {
    const workflow=await workflows.saveDraft({...input,mode:input.mode??p.brief.mode??'t2i',inputAssetId:input.inputAssetId??p.brief.inputAssetId??null,briefInputIds:p.brief.inputAssetIds??(p.brief.inputAssetId?[p.brief.inputAssetId]:[]),sessionId:session,beforeWrite:async snapshot=>{
      if(input.enhancementRunId!==undefined){
        const kind=store.get(input.enhancementRunId)?.kind,coordinator=kind==='qwen-pe'?qwenPe:kind==='moss-pe'?mossPe:null;
        if(!coordinator)throw new ApiError(409,'PE adoption run or service unavailable');
        if(kind==='qwen-pe'&&await coordinator.licenseCheck()!==true)throw new ApiError(403,'Qwen research license purpose is unconfirmed');
        adoption=coordinator.assertWorkflowAdoption(input.enhancementRunId,session,p.id,snapshot);
      }
      admissionAttempted=true;
      preparation=productions.beginWorkflowPreparation(p.id,session,input.requestId===undefined?{...input,requestId:randomUUID()}:input);
    }});
    if(!preparation)throw new ApiError(503,'workflow受付記録がありません。結果を保留してください。');
    const production=productions.bindWorkflow(p.id,session,input.expectedRevision,workflow,adoption,preparation);
    json(res,201,{workflow,production,validation:{valid:true}});return true;
    } catch (error) {
      if(!admissionAttempted||isDefiniteWorkflowRejection(error)){if(Number.isInteger(error?.status)&&error.status>=400&&error.status<500)throw error;throw new ApiError(400,'保存前のworkflow検証に失敗しました。workflowは作成していません。');}
      throw new ApiError(503,'workflow要求の途中結果を確認できません。要求IDで照合し、再送せず保留してください。');
    }
  }
  const match=path.match(/^\/api\/productions\/([a-f0-9-]{36})(?:\/(render|render-prepared|evaluate|iteration|feedback|cancel|cancel-owned|user-decision|planning-delivery|latest-completed|run-by-request|workflow-by-request))?$/);
  if(!match) throw new ApiError(404,'制作APIがありません。');
  const [,id,action]=match;
  const production=productions.get(id,session);
  if(req.method==='POST'&&action&&!['cancel','cancel-owned'].includes(action))productions.assertNoPendingWorkflow(id,session);
  if(!action&&req.method==='GET') {json(res,200,{production});return true;}
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
  if(action==='render'&&req.method==='POST') {
    assertActiveProfile(production.brief.modelProfile);
    if([...MOSS_OFFICIAL_IDS,...QWEN21_OFFICIAL_IDS].includes(production.brief.modelProfile))throw new ApiError(409,'この公式workflowは保存済み条件で生成してください。render-preparedを使用し、設定変更は新しいdraftに固定してください。');
    const input=await body(req),workflow=await workflows.get(input.workflowId);
    const result=productions.render(id,session,input,workflow);
    if(result.created) scheduleOwnedLaunch({store,run:result.run,launch:()=>engine.launch(result.run.id)});
    json(res,result.created?202:200,{run:result.run,production:result.production});return true;
  }
  if(action==='render-prepared'&&req.method==='POST') {
    assertActiveProfile(production.brief.modelProfile);
    const input=await body(req);
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['requestId','workflowId','expectedRevision'].includes(key))||typeof input.workflowId!=='string'||!Number.isSafeInteger(input.expectedRevision))throw new ApiError(400,'workflowId、expectedRevision、requestIdのみを指定してください。');
    const workflow=await workflows.get(input.workflowId);
    const result=productions.renderPrepared(id,session,input,workflow);
    if(result.created)scheduleOwnedLaunch({store,run:result.run,launch:()=>engine.launch(result.run.id)});
    json(res,result.created?202:200,{run:result.run,production:result.production});return true;
  }
  if(action==='evaluate'&&req.method==='POST') {json(res,200,productions.evaluate(id,session,await body(req)));return true;}
  if(action==='iteration'&&req.method==='POST') {json(res,201,productions.planIteration(id,session,await body(req)));return true;}
  if(action==='feedback'&&req.method==='POST') {const result=productions.resumeWithFeedback(id,session,await body(req));json(res,result.created?201:200,result);return true;}
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
    const p=productions.cancel(id,session,input);
    // Deliberately do not abortSession: another production's inference/search
    // in this conversation must not be cancelled by this production's button.
    let stopError;try{cancelProductionPe(p,session);}catch(error){stopError=error;}
    try{for(const runId of p.attempts){const run=store.get(runId);if(run&&!['completed','cancelled','failed'].includes(run.phase)&&!engine.work.has(runId))scheduleOwnedLaunch({store,run,launch:()=>engine.launch(runId,true)});}}catch(error){stopError??=error;}
    // The durable cancellation has already committed. A later 4xx-shaped
    // cleanup failure is not evidence that no cancellation occurred.
    if(stopError)throw new ApiError(503,'停止の受付後に処理結果を確認できません。再送せず、この制作の状態を確認してください。');
    json(res,202,{production:p});return true;
  }
  if(action==='cancel'&&req.method==='POST') {
    const input=await body(req);
    if(input.expectedRunId!==undefined&&(typeof input.expectedRunId!=='string'||!Number.isSafeInteger(input.expectedRevision)))throw new ApiError(400,'停止対象の生成情報が不正です。');
    validateStopTurn(session,input.searchTurn);
    const p=productions.cancel(id,session,{expectedRunId:input.expectedRunId,expectedRevision:input.expectedRevision});
    let stopError;try{cancelProductionPe(p,session);}catch(error){stopError=error;}try{abortSession(session,input.searchTurn);}catch(error){stopError??=error;}
    try{for(const runId of p.attempts) {
      const run=store.get(runId);
      if(run&&!['completed','cancelled','failed'].includes(run.phase)&&!engine.work.has(runId)) scheduleOwnedLaunch({store,run,launch:()=>engine.launch(runId,true)});
    }}catch(error){stopError??=error;}
    if(stopError)throw new ApiError(503,'停止の受付後に処理結果を確認できません。再送せず、この制作の状態を確認してください。');
    json(res,202,{production:p});return true;
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

export async function inferenceRoute({req,res,path,role,body,json,gate,strata,registerInference=()=>()=>{}}) {
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
    if(upstream.body) for await(const chunk of upstream.body) {
      if(!res.write(Buffer.from(chunk))) await new Promise((resolve,reject)=>{
        const done=()=>{res.off('drain',done);res.off('close',closed);resolve();};
        const closed=()=>{res.off('drain',done);res.off('close',closed);reject(new Error('DSH disconnected'));};
        res.once('drain',done);res.once('close',closed);
      });
    }
    res.end();
  } finally {
    unregister();
    res.off('close',abort);controller.abort();
    await release?.();
  }
  return true;
}
