// Production-bound PE orchestration. MOSS and Qwen use separate run kinds,
// license/availability gates and disabled-by-default HTTP exposure. PE runs
// must be routed here rather than through the image RunEngine.
import {createHash,randomUUID} from 'node:crypto';
import {ApiError,digest,normalizeRequest,terminalPhases} from './store.mjs';
import {MOSS_OFFICIAL_IDS,QWEN21_OFFICIAL_IDS} from './media-modes.mjs';
import {validateSession} from './productions.mjs';
import {MossPeStage} from './moss-pe-stage.mjs';
import {buildMossPromptEnhancer,inspectMossPromptEnhancer} from './moss-prompt-enhancer.mjs';
import {QWEN_PE_CONTRACT,assertQwenPeInputDimensions} from './qwen21-prompt-enhancer.mjs';
import {inputRgbaBytesFloor} from './input-memory-floor.mjs';
import {GateError} from './resource-gate.mjs';
import {readExternalPrompt} from './external-prompts.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const now=()=>new Date().toISOString();
const sha256=value=>createHash('sha256').update(value).digest('hex');
const errorText=e=>String(e?.message??e).slice(0,1000);
const text=(x,max,label)=>{if(typeof x!=='string'||!x.trim()||x.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(x))throw new ApiError(400,`${label} is invalid`);return x;};
const requirements=(p,run)=>[{kind:'user-request',requirement:p.brief.request},{kind:'source-prompt',requirement:run.spec.prompt},...['invariants','requiredConditions','avoid'].flatMap(kind=>(p.brief[kind]??[]).map(requirement=>({kind,requirement})))];

export class MossPeCoordinator{
  constructor({store,productions,adapter,gate,assets,verifyEpoch,pollIntervalMs=1500,timeoutMs=900000,family='moss',licenseCheck=null}){
    if(!store||!productions||!adapter||!gate||typeof verifyEpoch!=='function'||!Number.isSafeInteger(pollIntervalMs)||pollIntervalMs<1||!Number.isSafeInteger(timeoutMs)||timeoutMs<1)throw new TypeError('Invalid MOSS PE coordinator dependencies');
    if(!['moss','qwen'].includes(family)||family==='qwen'&&typeof licenseCheck!=='function')throw new TypeError('PE family and Qwen license check are required');
    Object.assign(this,{store,productions,adapter,gate,assets,verifyEpoch,pollIntervalMs,timeoutMs,family,licenseCheck});
    this.kind=family==='qwen'?'qwen-pe':'moss-pe';this.stateKey=family==='qwen'?'qwenPe':'mossPe';this.decisionKey=family==='qwen'?'qwenPeDecision':'mossPeDecision';
    this.work=new Set();
    this.stage=new MossPeStage({store,adapter,gate,assets,checkEpoch:run=>this.checkEpoch(run),stateKey:this.stateKey,...(family==='qwen'?{contract:QWEN_PE_CONTRACT}:{})});
  }
  async checkEpoch(run){const epoch=await this.verifyEpoch();if(!run.serverEpoch||digest(epoch)!==digest(run.serverEpoch))throw Error('ComfyUI epoch changed; PE was not retried or released');return epoch;}
  async availability(mode='t2i'){
    try{
      const scope=`official-${this.family}-prompt-enhancement`;
      if(this.family==='qwen'){
        if(!['t2i','edit'].includes(mode)||await this.licenseCheck()!==true)return {available:false,scope,reason:'license-or-mode-unconfirmed'};
        const sessionId='availability-fixture',id='11111111-1111-4111-8111-111111111111',hash='a'.repeat(64),prefix=sha256(sessionId).slice(0,24);
        const inputAssets=mode==='edit'?[{id,purpose:'input',sha256:hash,width:512,height:512,comfyInputName:`controller-assets/${prefix}/${id}-${hash}.png`}]:[];
        const options={mode,prompt:'Availability check only',seed:'0',inputAssets,sessionId},built=QWEN_PE_CONTRACT.build(options);
        const inspection=QWEN_PE_CONTRACT.inspect(built.graph,options,await this.adapter.request('/object_info'));
        return {available:inspection.ready,scope,mode,qualification:'static-schema-only',...(inspection.ready?{}:{reason:'nodes-or-model-unavailable'})};
      }
      const options={prompt:'Availability check only',seed:'0'},built=buildMossPromptEnhancer(options);
      const inspection=inspectMossPromptEnhancer(built.graph,options,await this.adapter.request('/object_info'));
      return {available:inspection.ready,scope,qualification:'static-schema-only',...(inspection.ready?{}:{reason:'nodes-or-model-unavailable'})};
    }catch{return {available:false,scope:`official-${this.family}-prompt-enhancement`,reason:'availability-unconfirmed'};}
  }
  get(id,session){
    validateSession(session);const run=this.store.get(id);
    if(!run||run.kind!==this.kind||run.sessionId!==session)throw new ApiError(404,'PE run is not owned by this session');
    this.productions.get(run.productionId,session);return run;
  }
  find(productionId,session,requestId){
    this.productions.get(productionId,session);
    if(typeof requestId!=='string'||!/^[-a-zA-Z0-9_]{16,100}$/.test(requestId))throw new ApiError(400,'Invalid PE request ID');
    const row=this.store.db.prepare('SELECT json FROM runs WHERE request_id=?').get(requestId);
    if(!row)throw new ApiError(404,'PE request not observed; absence does not prove rejection');
    const candidate=JSON.parse(row.json),run=this.get(candidate.id,session);
    if(run.productionId!==productionId)throw new ApiError(404,'PE request not owned by this production');
    return run;
  }
  create(productionId,session,input){
    validateSession(session);const p=this.productions.get(productionId,session);
    const mode=p.brief.mode??'t2i';
    if(!(this.family==='qwen'?QWEN21_OFFICIAL_IDS:MOSS_OFFICIAL_IDS).includes(p.brief.modelProfile)||!(this.family==='qwen'?['t2i','edit']:['t2i','layout']).includes(mode))throw new ApiError(400,'PE family and production mode do not match');
    const prompt=text(input?.prompt,6000,'prompt'),reason=text(input?.reason,2000,'reason');
    const seed=input?.seed??'42',inputAssetId=input?.inputAssetId??null;
    const thinking=input?.thinking??false,maxLength=input?.maxLength??4096;
    if(this.family==='qwen'&&(typeof thinking!=='boolean'||!Number.isSafeInteger(maxLength)||maxLength<1||maxLength>32768)||this.family==='moss'&&(input?.thinking!==undefined||input?.maxLength!==undefined))throw new ApiError(400,'Invalid PE thinking or token limit');
    const allowedIds=p.brief.inputAssetIds??(p.brief.inputAssetId?[p.brief.inputAssetId]:[]);
    const inputAssetIds=input?.inputAssetIds??[];
    if(this.family==='qwen'&&(!Array.isArray(inputAssetIds)||inputAssetId!==null||JSON.stringify(inputAssetIds)!==JSON.stringify(mode==='edit'?allowedIds:[])))throw new ApiError(400,'Qwen PE inputs must match the ordered production generator inputs');
    if(this.family==='qwen'&&inputAssetIds.length){
      if(!this.assets||typeof this.assets.get!=='function')throw new ApiError(409,'Owned Qwen PE image metadata unavailable');
      const selected=inputAssetIds.map(id=>this.assets.get(id,session));
      try{inputRgbaBytesFloor(selected);assertQwenPeInputDimensions(selected);}catch(error){throw new ApiError(400,errorText(error));}
    }
    if(this.family==='moss'&&input?.inputAssetIds!==undefined)throw new ApiError(400,'MOSS PE accepts one input image');
    if(this.family==='moss'&&inputAssetId!==((p.brief.peInputAssetIds??[])[0]??null))throw new ApiError(400,'PE image must match the explicitly designated PE-only input in this production');
    const normalized=normalizeRequest({requestId:input?.requestId,prompt,seed,modelProfile:p.brief.modelProfile});
    const spec={...normalized.spec,prompt,task:this.kind,productionId,briefHash:p.briefHash,reason,...(this.family==='qwen'?{inputAssetIds,peMode:mode,thinking,maxLength}:{inputAssetId})};
    const result=this.store.create({...normalized,spec},{decorate:run=>{
      const current=this.productions.get(productionId,session);this.productions.check(current,input.expectedRevision);
      if(current.briefHash!==p.briefHash)throw new ApiError(409,'Production brief changed');
      current.promptEnhancements??=[];current.promptEnhancements.push(run.id);current.revision++;
      this.productions.write(current,`${this.family}_pe_requested`,{runId:run.id,reason,originalPromptSha256:sha256(prompt)});
      return {kind:this.kind,productionId,sessionId:session,productionRevision:current.revision};
    }});
    if(result.run.kind!==this.kind||result.run.productionId!==productionId||result.run.sessionId!==session)throw new ApiError(409,'Request ID belongs to another task');
    return {...result,production:this.productions.get(productionId,session)};
  }
  launch(id,{recovery=false}={}){
    if(this.work.has(id))return;
    this.work.add(id);
    const work=this.execute(id,{recovery}).catch(async error=>{
      let run=this.store.get(id);if(!run||terminalPhases.has(run.phase))return;
      const gate=this.gate.status();
      if(!run.pePreSubmit&&!run[this.stateKey]&&gate.generationRunId!==id&&gate.blocked===false&&['core','none'].includes(gate.owner))return this.store.update(id,{phase:run.cancelRequested?'cancelled':'failed',error:run.cancelRequested?null:errorText(error)},`${this.family}_pe_preflight_failed`);
      if(!run[this.stateKey]&&run.pePreSubmit){
        try{return await this.recoverBeforeSubmission(id,errorText(error));}catch(cleanup){run=this.store.get(id);error=new Error(`${errorText(error)}; cleanup: ${errorText(cleanup)}`);}
      }
      if(run&&!terminalPhases.has(run.phase))this.store.update(id,{phase:'needs_attention',error:errorText(error)},`${this.family}_pe_unhandled`);
    }).finally(()=>this.work.delete(id));
    return work;
  }
  syncCancellation(id){
    const run=this.store.get(id);if(!run||run.kind!==this.kind)throw Error('PE run unavailable');
    const production=this.productions.get(run.productionId,run.sessionId);
    if(production.cancelRequested&&!run.cancelRequested&&!terminalPhases.has(run.phase))return this.store.cancel(id);
    return run;
  }
  assertNoSubmission(id){
    const run=this.syncCancellation(id),marker=run.pePreSubmit;
    if(!marker||marker.version!==1||marker.runId!==id||marker.family!==this.family||!run.serverEpoch||marker.serverEpochDigest!==digest(run.serverEpoch)||run[this.stateKey]||run.promptId||marker.submitted!==false)throw Error('Durable pre-submission evidence is incomplete');
    if(this.store.db.prepare('SELECT 1 FROM events WHERE run_id=? AND type=? LIMIT 1').get(id,`${this.family}_pe_submit_intent`))throw Error('A durable PE submission intent already exists');
    return run;
  }
  async recoverBeforeSubmission(id,reason='PE did not begin'){
    const run=this.assertNoSubmission(id),marker=run.pePreSubmit,gate=this.gate.status();
    // Stage submit intent and stage data are committed in the same SQLite
    // transaction. An intent event, even with a damaged stage record, forbids
    // treating this as a job that was never submitted.
    const eventType=`${this.family}_pe_submit_intent`;
    if(gate.initialized!==true||gate.generationRunId!==id||gate.blocked!==true||gate.activeCore!==0||!(gate.owner==='generator'||gate.owner==='none'&&marker.noneCleanupConfirmed===true))throw Error('Pre-submission GPU lease is not provably owned');
    const assertGeneratorIdle=async()=>{
      const fresh=this.store.get(id);if(!fresh||fresh[this.stateKey]||fresh.promptId||fresh.pePreSubmit?.submitted!==false||this.store.db.prepare('SELECT 1 FROM events WHERE run_id=? AND type=? LIMIT 1').get(id,eventType))throw Error('PE submission state changed during cleanup');
      await this.checkEpoch(fresh);
      const q=await this.adapter.request('/queue');
      if(!Array.isArray(q?.queue_running)||!Array.isArray(q?.queue_pending)||q.queue_running.length||q.queue_pending.length)throw Error('Comfy queue is not empty');
      await this.checkEpoch(this.store.get(id));
    };
    const coreBefore=await this.gate.state();if(coreBefore.loaded!==false||coreBefore.activity?.in_flight!==0)throw Error('Strata is not proven unloaded and idle');
    await assertGeneratorIdle();
    this.store.update(id,{pePreSubmit:{...marker,cleanupIntentAt:now(),cleanupReason:reason}},`${this.family}_pe_pre_submit_cleanup_intent`);
    const core=await this.gate.returnToCore(id,{assertGeneratorIdle,signalcleanup:AbortSignal.timeout(300000)});
    const final=this.syncCancellation(id);
    return this.store.update(id,{phase:final.cancelRequested?'cancelled':'failed',coreRestored:core,error:final.cancelRequested?null:reason,pePreSubmit:{...final.pePreSubmit,cleanupConfirmed:true,restoredAt:now()}},`${this.family}_pe_pre_submit_cleanup_confirmed`);
  }
  async execute(id,{recovery=false}={}){
    let run=this.syncCancellation(id);if(terminalPhases.has(run.phase))return;
    let stage;
    if(recovery){
      // A fresh process with an unknown gate owner does not establish lease
      // ownership. Only an already-owned generator lease can be reconciled.
      const ownership=this.gate.status();stage=run[this.stateKey];
      if(!stage&&run.pePreSubmit)return this.recoverBeforeSubmission(id,run.error??'PE did not begin');
      if(ownership.generationRunId!==id||ownership.owner!=='generator'||!stage||!['submitting','monitoring','submission_unknown','cancelling','result-saved','failed-terminal','cancelled-terminal','rejected'].includes(stage.phase))
        return this.store.update(id,{phase:'needs_attention',error:'PE recovery requires verified GPU ownership; no job was resent'},`${this.family}_pe_recovery_hold`);
      await this.checkEpoch(run);
    }else{
      if(run.cancelRequested)return this.store.update(id,{phase:'cancelled'},`${this.family}_pe_cancelled_before_start`);
      if(this.family==='qwen'&&await this.licenseCheck()!==true)throw Error('Qwen research license purpose is not confirmed');
      // Reject absent or changed private upstream data before any GPU handoff.
      // The graph builder verifies the same file again immediately before use.
      readExternalPrompt(this.family,this.family==='qwen'?run.spec.peMode:'t2i');
      let minimumResources=null,inputBufferFloorBytes=0;
      if(this.family==='qwen'&&run.spec.inputAssetIds?.length){
        if(!this.assets||typeof this.assets.get!=='function')throw Error('Qwen PE owned input metadata unavailable');
        const inputAssets=run.spec.inputAssetIds.map(assetId=>this.assets.get(assetId,run.sessionId));
        inputBufferFloorBytes=inputRgbaBytesFloor(inputAssets);
        assertQwenPeInputDimensions(inputAssets);
        const values=[this.gate.minFreeBytes,this.gate.minRamAvailableBytes,this.gate.minCommitAvailableBytes];
        if(values.some(n=>!Number.isSafeInteger(n)||n<0)||!Number.isSafeInteger(values[1]+inputBufferFloorBytes)||!Number.isSafeInteger(values[2]+inputBufferFloorBytes))throw Error('Qwen PE resource floor cannot be established');
        minimumResources={minFreeBytes:values[0],minRamAvailableBytes:values[1]+inputBufferFloorBytes,minCommitAvailableBytes:values[2]+inputBufferFloorBytes};
      }
      const epoch=await this.verifyEpoch();this.store.update(id,{phase:'preparing',serverEpoch:epoch,pePreSubmit:{version:1,runId:id,family:this.family,serverEpochDigest:digest(epoch),submitted:false},...(minimumResources?{peResourceRequirements:{...minimumResources,inputBufferFloorBytes,scope:'one RGBA input buffer only; not total peak or a guarantee'}}:{})},`${this.family}_pe_server_identity`);
      const cancel=new AbortController();
      const refresh=()=>{if(this.store.get(id)?.cancelRequested)cancel.abort(new Error('PE cancellation requested'));};
      const timer=setInterval(refresh,100);timer.unref?.();
      try{refresh();await this.gate.acquireGenerator(id,{signal:cancel.signal,...(minimumResources?{minimumResources}:{})});}
      catch(error){
        const state=this.gate.status(),latest=this.store.get(id);
        if(error instanceof GateError&&error.code==='GENERATOR_LEASE_BUSY'&&error.leaseNotAcquired===true&&state.initialized===true&&state.blocked===true&&typeof state.generationRunId==='string'&&state.generationRunId!==id&&['generator','enhancer','draining_core','restoring_core','none'].includes(state.owner)){
          // The gate proved this attempt was rejected under its mutex before
          // assignment. Only finish this run; do not free, cancel, restore or
          // otherwise modify the foreign owner's lease or jobs.
          const safe=this.assertNoSubmission(id);
          return this.store.update(id,{phase:safe.cancelRequested?'cancelled':'failed',error:safe.cancelRequested?null:'Another run owns the GPU; this PE was not submitted.',pePreSubmit:{...safe.pePreSubmit,leaseNotAcquired:true,rejectionCode:error.code,confirmedAt:now()}},`${this.family}_pe_lease_busy_not_acquired`);
        }
        if(latest.cancelRequested&&state.generationRunId!==id&&!state.blocked&&['core','none'].includes(state.owner))return this.store.update(id,{phase:'cancelled'},`${this.family}_pe_cancelled_before_lease`);
        if(state.generationRunId===id&&state.owner==='none'&&error.cleanupConfirmed===true)this.store.update(id,{pePreSubmit:{...latest.pePreSubmit,noneCleanupConfirmed:true}},`${this.family}_pe_handoff_cleanup_proven`);
        throw error;
      }finally{clearInterval(timer);}
      run=this.store.update(id,{phase:'enhancing'},`${this.family}_pe_lease_acquired`);
      if(run.cancelRequested)throw Error('PE stopped after GPU handoff; cleanup requires reconciliation');
      if(this.family==='qwen'&&await this.licenseCheck()!==true)throw Error('Qwen research license purpose is not confirmed');
      stage=await this.stage.start(id,{prompt:run.spec.prompt,seed:run.spec.seed,...(this.family==='qwen'?{inputAssetIds:run.spec.inputAssetIds,mode:run.spec.peMode,thinking:run.spec.thinking,maxLength:run.spec.maxLength}:{inputAssetId:run.spec.inputAssetId}),sessionId:run.sessionId});
    }
    const deadline=Date.now()+this.timeoutMs;
    while(!['result-saved','failed-terminal','cancelled-terminal','rejected'].includes(stage.phase)){
      if(Date.now()>=deadline)return this.store.update(id,{phase:'needs_attention',error:'PE outcome remains unknown; no retry or release'},`${this.family}_pe_timeout`);
      await sleep(this.pollIntervalMs);this.syncCancellation(id);stage=await this.stage.reconcile(id);
    }
    const terminal=stage.phase;
    stage=await this.stage.releaseAndRestore(id);
    if(stage.phase!=='core-restored')return this.store.update(id,{phase:'needs_attention',error:stage.error??'PE cleanup unresolved'},`${this.family}_pe_cleanup_unresolved`);
    const phase=terminal==='result-saved'?'completed':terminal==='cancelled-terminal'?'cancelled':'failed';
    return this.store.update(id,{phase,coreRestored:stage.core,error:phase==='failed'?(stage.error??'PE failed'):null},`${this.family}_pe_finished`);
  }
  cancel(id,session){const run=this.get(id,session);return this.store.cancel(run.id);}
  cancelProduction(production,session){
    validateSession(session);
    if(production.sessionId!==session||production.cancelRequested!==true)throw new ApiError(409,'Production cancellation is not confirmed');
    for(const id of production.promptEnhancements??[]){
      const candidate=this.store.get(id);if(!candidate||candidate.kind!==this.kind)continue;
      const run=this.get(id,session);
      if(run.productionId!==production.id)throw new ApiError(409,'PE run belongs to another production');
      if(!terminalPhases.has(run.phase)){
        this.store.cancel(id);
        if(!this.work.has(id))setImmediate(()=>this.launch(id,{recovery:true}));
      }
    }
  }
  /** Only an explicitly accepted result for the same unchanged production can
   * be linked to a workflow. Caller must provide the actual saved workflow,
   * not an agent-supplied hash. This check does not itself create a workflow. */
  assertWorkflowAdoption(id,session,productionId,workflow){
    const run=this.get(id,session),p=this.productions.get(productionId,session),result=run[this.stateKey]?.result,decision=run[this.decisionKey];
    if(run.productionId!==productionId||run.spec.briefHash!==p.briefHash||run.phase!=='completed'||run[this.stateKey]?.phase!=='core-restored'||decision?.decision!=='accept'||!result||typeof result.enhancedPrompt!=='string'||sha256(result.enhancedPrompt)!==result.enhancedPromptSha256)throw new ApiError(409,'No accepted PE result belongs to this unchanged production');
    if(!workflow||workflow.productionId!==productionId||workflow.modelProfile!==p.brief.modelProfile||workflow.mode!==(p.brief.mode??'t2i')||workflow.request?.prompt!==result.enhancedPrompt)throw new ApiError(409,'Workflow prompt does not exactly match the accepted PE result');
    const peInputAssets=result.inputAssets??(result.inputAsset?[result.inputAsset]:[]);
    return {family:this.family,peRunId:id,decisionId:decision.id,originalPromptSha256:result.originalPromptSha256,enhancedPromptSha256:result.enhancedPromptSha256,peInputAssets,briefHash:p.briefHash,workflowId:workflow.id,workflowSha256:workflow.sha256};
  }
  decide(id,session,input){
    const reason=text(input?.reason,3000,'decision reason');
    if(!['accept','reject'].includes(input?.decision)||!Array.isArray(input?.invariants))throw new ApiError(400,'Decision and invariant checks are required');
    return this.store.transaction(()=>{
      const run=this.get(id,session),p=this.productions.get(run.productionId,session);this.productions.check(p,input.expectedRevision);
      if(run.phase!=='completed'||run[this.stateKey]?.phase!=='core-restored'||!run[this.stateKey].result||run.spec.briefHash!==p.briefHash||run[this.decisionKey])throw new ApiError(409,'PE result cannot be decided for this production');
      const result=run[this.stateKey].result;
      if(typeof result.originalPrompt!=='string'||typeof result.enhancedPrompt!=='string'||sha256(result.originalPrompt)!==result.originalPromptSha256||sha256(result.enhancedPrompt)!==result.enhancedPromptSha256)throw new ApiError(409,'Stored PE text differs from its recorded hashes');
      if(input.originalPromptSha256!==result.originalPromptSha256||input.enhancedPromptSha256!==result.enhancedPromptSha256)throw new ApiError(409,'PE prompt hashes differ');
      const required=requirements(p,run);
      if(input.invariants.length!==required.length)throw new ApiError(400,'Every invariant requires a recorded judgement');
      const checks=input.invariants.map((item,i)=>{
        if(item?.kind!==required[i].kind||item?.requirement!==required[i].requirement||!['met','unmet','unverified'].includes(item.status))throw new ApiError(400,'Requirement order or judgement differs from the production brief');
        return {...required[i],status:item.status,evidence:text(item.evidence,2000,'requirement evidence')};
      });
      if(input.decision==='accept'&&checks.some(x=>x.status!=='met'))throw new ApiError(409,'Unmet or unverified invariants cannot be accepted');
      const decision={id:randomUUID(),decision:input.decision,reason,checks,originalPromptSha256:result.originalPromptSha256,enhancedPromptSha256:result.enhancedPromptSha256,completionReason:result.completionReason,at:now()};
      // Already inside a RunStore transaction: update directly instead of
      // starting a nested transaction through store.update().
      run[this.decisionKey]=decision;run.updatedAt=now();
      this.store.db.prepare('UPDATE runs SET phase=?,json=? WHERE id=?').run(run.phase,JSON.stringify(run),id);
      this.store.event(id,`${this.family}_pe_decided`,{[this.decisionKey]:decision});
      p.revision++;this.productions.write(p,`${this.family}_pe_decided`,{runId:id,decision});return {run:this.get(id,session),production:p};
    });
  }
}
