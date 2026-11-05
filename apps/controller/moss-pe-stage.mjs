// ComfyUI PE stage shared by separately gated MOSS and Qwen coordinators.
// Importing it performs no network or GPU operation. Starting a stage requires
// an already-owned generator lease; see tests.
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {buildMossPromptEnhancer,inspectMossPromptEnhancer,collectMossPromptEnhancement} from './moss-prompt-enhancer.mjs';
import {MONITOR_INSTANCE_ID} from './monitor-identity.mjs';

const activeByStore=new WeakMap();
const fail=message=>{throw new Error(message);};
const message=error=>String(error?.message??error).slice(0,800);
const now=()=>new Date().toISOString();
const queueEmpty=q=>Array.isArray(q?.queue_running)&&Array.isArray(q?.queue_pending)&&q.queue_running.length===0&&q.queue_pending.length===0;

export class MossPeStage {
  constructor({store,adapter,gate,assets,checkEpoch,contract=null,stateKey='mossPe'}){
    if(!store||!adapter||!gate||typeof checkEpoch!=='function')throw new TypeError('PE stage dependencies are required');
    if(!['mossPe','qwenPe'].includes(stateKey))throw new TypeError('Invalid PE stage identity');
    this.contract=contract??{build:buildMossPromptEnhancer,inspect:inspectMossPromptEnhancer,collect:collectMossPromptEnhancement,options:({prompt,seed,inputAssets,sessionId})=>({prompt,seed,inputAsset:inputAssets[0]??null,sessionId})};
    Object.assign(this,{store,adapter,gate,assets,checkEpoch,stateKey});
  }
  async exclusive(id,action){
    let active=activeByStore.get(this.store);if(!active){active=new Set();activeByStore.set(this.store,active);}
    if(active.has(id))fail('PE stage operation already active');active.add(id);
    try{return await action();}finally{active.delete(id);}
  }
  run(id){const run=this.store.get(id);if(!run||run.id!==id||run.controllerId!==this.store.controllerId||!run.serverEpoch)fail('Run identity or Comfy epoch unavailable');return run;}
  update(id,stage,type){return this.store.update(id,{[this.stateKey]:stage},this.stateKey==='qwenPe'?type.replace(/^moss_/,'qwen_'):type)[this.stateKey];}
  async assertLease(id){
    const run=this.run(id),gate=this.gate.status();
    if(gate.initialized!==true||gate.generationRunId!==id||gate.owner!=='generator'||gate.blocked!==true||gate.activeCore!==0)fail('PE does not own the generator lease');
    const core=await this.gate.state();
    if(core.loaded!==false||core.activity?.in_flight!==0)fail('Strata is not proven unloaded and idle');
    await this.checkEpoch(run);
    return run;
  }
  async assertIdle(id){await this.assertLease(id);const q=await this.adapter.request('/queue');if(!queueEmpty(q))fail('Comfy queue is not empty');await this.assertLease(id);}
  async start(id,{prompt,seed,inputAssetId=null,inputAssetIds,sessionId=null,mode,thinking,maxLength}={}){
    return this.exclusive(id,async()=>{
      let run=await this.assertLease(id);
      if(run[this.stateKey]||run.promptId||run.cancelRequested)fail('PE cannot start on this run');
      if(inputAssetIds!==undefined&&inputAssetId!==null)fail('Use one input selection form');
      const ids=inputAssetIds??(inputAssetId!==null?[inputAssetId]:[]),inputAssets=[];
      if(!Array.isArray(ids)||new Set(ids).size!==ids.length||ids.length>(this.stateKey==='qwenPe'?16:1))fail('Invalid ordered PE input assets');
      if(ids.length){
        if(!this.assets||typeof sessionId!=='string')fail('Owned input asset service unavailable');
        for(const id of ids){const binding=await this.assets.binding(id,sessionId,'input');await this.assets.verifyBinding(binding,sessionId);inputAssets.push(binding);}
      }
      const options=this.contract.options({prompt,seed,inputAssets,sessionId,mode,thinking,maxLength}),built=this.contract.build(options);
      const objects=await this.adapter.request('/object_info');
      const inspection=this.contract.inspect(built.graph,options,objects);
      if(!inspection.ready)fail('PE nodes or models unavailable: '+JSON.stringify(inspection));
      await this.assertIdle(id);
      run=this.run(id);if(run[this.stateKey]||run.promptId||run.cancelRequested)fail('Run changed before PE intent');
      const promptId=randomUUID();
      let stage={version:1,phase:'submitting',promptId,progressClientId:promptId,progressInstanceId:MONITOR_INSTANCE_ID,options,createdAt:now(),submissionCount:1,accepted:false};
      // Synchronous durable RunStore transaction precedes the one possible POST.
      stage=this.update(id,stage,'moss_pe_submit_intent');
      const payload={prompt_id:promptId,client_id:promptId,prompt:built.graph,extra_data:{local_genai:{controller_id:this.store.controllerId,run_id:id,prompt_id:promptId},purpose:this.stateKey==='qwenPe'?'qwen-official-pe':'moss-official-pe'}};
      try{
        const response=await this.adapter.submit(payload);
        if(response.prompt_id!==promptId)throw new Error('PE acknowledgement prompt ID mismatch');
        if(Object.keys(response.node_errors??{}).length)stage=this.update(id,{...stage,phase:'submission_unknown',nodeErrors:response.node_errors,error:'Partial node errors require reconciliation'},'moss_pe_partial_acceptance');
        else stage=this.update(id,{...stage,phase:'monitoring',accepted:true,ackAt:now()},'moss_pe_ack');
      }catch(error){
        stage=this.update(id,{...stage,phase:error.definitelyRejected===true?'rejected':'submission_unknown',error:message(error)},'moss_pe_submit_result');
      }
      return stage;
    });
  }
  async reconcile(id){
    return this.exclusive(id,async()=>{
      const run=await this.assertLease(id),stage=run[this.stateKey];
      if(!stage||!['submitting','monitoring','submission_unknown','cancelling'].includes(stage.phase))fail('PE stage does not require reconciliation');
      const snapshot=await this.adapter.inspect(stage.promptId);await this.assertLease(id);
      const ownerMatches=data=>data?.local_genai?.controller_id===this.store.controllerId&&data?.local_genai?.run_id===id&&data?.local_genai?.prompt_id===stage.promptId;
      const expectedGraph=this.contract.build(stage.options).graph;
      if((snapshot.running||snapshot.queued)&&(!ownerMatches(snapshot.extraData)||snapshot.queueItem?.[1]!==stage.promptId||!isDeepStrictEqual(snapshot.queueItem?.[2],expectedGraph)))fail('Active PE job ownership or graph mismatch');
      if(snapshot.history&&(!ownerMatches(snapshot.history.prompt?.[3])||snapshot.history.prompt?.[1]!==stage.promptId||!isDeepStrictEqual(snapshot.history.prompt?.[2],expectedGraph)))fail('PE history ownership or graph mismatch');
      if(snapshot.history&&!snapshot.running&&!snapshot.queued){
        if(snapshot.history.status?.completed!==true)return this.update(id,{...stage,phase:'submission_unknown',lastObservedAt:now(),error:'History does not prove termination'},'moss_pe_terminal_unknown');
        if(run.cancelRequested)return this.update(id,{...stage,phase:'cancelled-terminal',completedAt:now()},'moss_pe_cancelled');
        try{
          const result=this.contract.collect(snapshot.history,{options:stage.options,controllerId:this.store.controllerId,runId:id,promptId:stage.promptId});
          return this.update(id,{...stage,phase:'result-saved',result,completedAt:now()},'moss_pe_result_saved');
        }catch(error){return this.update(id,{...stage,phase:'failed-terminal',error:message(error),completedAt:now()},'moss_pe_output_rejected');}
      }
      if(run.cancelRequested&&(snapshot.running||snapshot.queued)){
        // A durable targeted-cancel intent is not a terminal-state proof.
        if(stage.cancelIntent)return stage;
        const intended=this.update(id,{...stage,phase:'cancelling',cancelIntent:{at:now(),promptId:stage.promptId}},'moss_pe_cancel_intent');
        await this.checkEpoch(this.run(id));
        try{const reply=await this.adapter.cancel(stage.promptId);return this.update(id,{...intended,cancelReply:reply},'moss_pe_cancel_ack');}
        catch(error){return this.update(id,{...intended,cancelError:message(error)},'moss_pe_cancel_unknown');}
      }
      // No history and no queue entry does not prove rejection or completion.
      return this.update(id,{...stage,phase:'submission_unknown',lastObservedAt:now()},'moss_pe_reconcile_unknown');
    });
  }
  async releaseAndRestore(id){
    return this.exclusive(id,async()=>{
      let run=await this.assertLease(id),stage=run[this.stateKey];
      if(!stage||!['result-saved','failed-terminal','cancelled-terminal','rejected'].includes(stage.phase))fail('PE terminal state is not proven');
      await this.assertIdle(id);
      stage=this.update(id,{...stage,phase:'release-intent',releaseIntentAt:now()},'moss_pe_release_intent');
      try{
        const release=await this.adapter.release({assertEpoch:()=>this.checkEpoch(this.run(id))});
        if(release?.released!==true)fail('Comfy release was not proven');
        stage=this.update(id,{...stage,phase:'released',release},'moss_pe_released');
        // returnToCore invokes this both before and after changing owner to
        // restoring_core, so the callback checks the server/queue rather than
        // requiring the old generator owner throughout that transition.
        const assertGeneratorIdle=async()=>{
          await this.checkEpoch(this.run(id));
          if(!queueEmpty(await this.adapter.request('/queue')))fail('Comfy queue changed during core restoration');
          await this.checkEpoch(this.run(id));
        };
        const core=await this.gate.returnToCore(id,{assertGeneratorIdle});
        return this.update(id,{...stage,phase:'core-restored',core,restoredAt:now()},'moss_pe_core_restored');
      }catch(error){
        await this.gate.block(error);
        return this.update(id,{...stage,phase:'recovery-required',error:message(error)},'moss_pe_release_unknown');
      }
    });
  }
}
