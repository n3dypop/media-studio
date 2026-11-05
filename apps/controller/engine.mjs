import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, open } from 'node:fs/promises';
import { join } from 'node:path';
import { terminalPhases, digest, ApiError } from './store.mjs';
import { validateEnhancementSpec } from './enhancer.mjs';
import { recoverCancelledServer } from './server-recovery.mjs';
import {preflightDiagnostic,preflightSummary,makePreflightError} from './preflight-diagnostics.mjs';
import {QWEN21_OFFICIAL_IDS} from './media-modes.mjs';
import {inputRgbaBytesFloor} from './input-memory-floor.mjs';
import {MONITOR_INSTANCE_ID} from './monitor-identity.mjs';
import {scheduleOwnedLaunch,recordOwnedLaunchFailure} from './owned-launch.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const message = error => String(error?.message ?? error).slice(0,1200);
const enhancerCleanupConfirmed=run=>Boolean(run.enhancerStartIntent?.id&&run.enhancerCleanup?.intentId===run.enhancerStartIntent.id&&run.enhancerCleanup.confirmed===true&&(run.enhancerCleanup.childStarted===false||run.enhancerCleanup.childExited===true));
const enhancerProof=(intent,record)=>record?.childExited===true&&record.cleanupConfirmed===true?{
  intentId:intent.id,confirmed:true,childStarted:true,childExited:true,childPid:record.childPid??null,resourceAfter:record.resourceAfter??null,at:new Date().toISOString(),
}:null;
export function monitorTimeoutFor(spec,baseTimeout){
  if(!Number.isSafeInteger(baseTimeout)||baseTimeout<1)throw new TypeError('Invalid job monitoring timeout');
  return baseTimeout;
}

export class RunEngine {
  constructor({store,adapter,outputRoot,verifyEpoch=null,verifyRetiredEpoch=null,gate=null,enhancer=null,observeOutputDisks=null,pollIntervalMs=1500,jobTimeoutMs=900000,cancelTimeoutMs=60000}) {
    monitorTimeoutFor(null,jobTimeoutMs);
    Object.assign(this,{store,adapter,outputRoot,verifyEpoch,verifyRetiredEpoch,gate,enhancer,observeOutputDisks,pollIntervalMs,jobTimeoutMs,cancelTimeoutMs});
    this.work = new Set();
  }
  recordPreflightFailure(id,stage,result=null,error=null){
    const diagnostic=preflightDiagnostic({stage,result,error});
    this.store.update(id,{preflightDiagnostic:diagnostic},'preflight_rejected');
    return preflightSummary(diagnostic);
  }
  launch(id, recovery=false) {
    const recorded=this.store.get(id);
    if(['moss-pe','qwen-pe'].includes(recorded?.kind)){
      const coordinator=recorded.kind==='qwen-pe'?this.qwenPe:this.mossPe;
      if(coordinator)return coordinator.launch(id,{recovery});
      if(!terminalPhases.has(recorded.phase))this.store.update(id,{phase:'needs_attention',error:'PE coordinator is unavailable; no image job was started.'},'moss_pe_coordinator_missing');
      return;
    }
    if (this.work.has(id)) return;
    this.work.add(id);
    let execution;
    try { execution=this.execute(id,recovery); } catch(error) { execution=Promise.reject(error); }
    const promise = Promise.resolve(execution).catch(() => {
      recordOwnedLaunchFailure(this.store,recorded);
    }).finally(() => this.work.delete(id));
    return promise;
  }
  recover() {
    const run = this.store.active();
    if (!run) return;
    this.store.update(run.id,{phase:'recovery_required',recoveryFromPhase:run.recoveryFromPhase??run.phase,error:'コントローラ再開後の照合中です。新規送信は行いません。'},'restart');
    scheduleOwnedLaunch({store:this.store,run,launch:()=>this.launch(run.id,true)});
  }
  recoverServer(id,input) {
    const run=this.store.get(id);
    if(!run)throw new ApiError(404,'生成記録がありません。');
    if(!input||input.confirmRunId!==id||Object.keys(input).some(key=>key!=='confirmRunId'))throw new ApiError(400,'対象のconfirmRunIdだけを指定してください。');
    if(this.work.has(id))throw new ApiError(409,'この生成は照合中です。');
    if(!run.cancelRequested||!['recovery_required','needs_attention'].includes(run.phase)||!run.promptId||!run.serverEpoch)throw new ApiError(409,'停止要求済みで実行世代を保存した確認待ちの生成だけを復旧できます。');
    if(run.enhancerStartIntent&&!enhancerCleanupConfirmed(run))throw new ApiError(409,'PE子プロセスの終了証拠がありません。');
    if(!this.verifyEpoch||!this.verifyRetiredEpoch||!this.gate)throw new ApiError(503,'実行世代とGPU使用権の復旧機能がありません。');
    const gate=this.gate.status();
    const resume=gate.generationRunId===null&&gate.blocked&&gate.owner==='unknown'&&gate.activeCore===0;
    if(gate.activeCore!==0||(gate.generationRunId!==id&&!resume))throw new ApiError(409,'復旧対象とGPU使用権が一致しません。');
    this.work.add(id);
    return recoverCancelledServer(this,id).finally(()=>this.work.delete(id));
  }
  cancellationWatch(id) {
    const controller=new AbortController();
    const refresh=()=>{
      try {if(this.store.get(id)?.cancelRequested)controller.abort(new Error('制作全体の停止を受け付けました。'));}
      catch(error) {controller.abort(error);}
    };
    refresh();
    const timer=setInterval(refresh,100);timer.unref?.();
    return {signal:controller.signal,close:()=>clearInterval(timer)};
  }
  owned(run, snapshot) {
    const matches=data=>{
      const owner=data?.local_genai;
      return owner?.controller_id === this.store.controllerId && owner?.run_id === run.id && owner?.prompt_id === run.promptId;
    };
    // A stale history entry cannot authorize a currently queued duplicate ID.
    if((snapshot.queued||snapshot.running)&&!matches(snapshot.extraData)) return false;
    if(snapshot.history&&!matches(snapshot.history.prompt?.[3])) return false;
    return Boolean(snapshot.queued||snapshot.running||snapshot.history);
  }
  async checkEpoch(run) {
    if(!this.verifyEpoch) return null;
    const epoch=await this.verifyEpoch();
    if(!run.serverEpoch||digest(epoch)!==digest(run.serverEpoch)) throw new Error('ComfyUIプロセスが前回と一致しません。再送・停止・解放をせず確認待ちにします。');
    return epoch;
  }
  async manifest(run) {
    const dir=join(this.outputRoot,run.id);
    await mkdir(dir,{recursive:true});
    const path=join(dir,'manifest.json'), temp=path+'.partial';
    await writeFile(temp,JSON.stringify(run,null,2)+'\n',{encoding:'utf8'});
    const handle=await open(temp,'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    await rename(temp,path);
  }
  async finish(id,phase,error=null) {
    const pending=this.store.get(id);
    if(terminalPhases.has(phase)&&this.gate?.status().generationRunId===id) {
      if(pending.enhancerStartIntent&&!enhancerCleanupConfirmed(pending)) {
        phase='needs_attention';error='PE子プロセスの終了・資源回復を確認できないため中核復帰を保留しました。';
      } else if(pending.promptId&&!pending.definitelyRejected&&!pending.release?.released) {
        phase='needs_attention';error='生成器の解放を確認できないため中核復帰を保留しました。';
      } else {
        this.store.update(id,{phase:'restoring_core'});
        try { const core=await this.gate.returnToCore(id,{signalcleanup:AbortSignal.timeout(300000)});this.store.update(id,{coreRestored:core},'core_restored'); }
        catch(failure) {phase='needs_attention';error='画像と記録は保持しています。中核復帰を確認できません。 '+message(failure);}
      }
    }
    const run=this.store.update(id,{phase,error});
    await this.manifest(run);
    return run;
  }
  async execute(id,recovery) {
    let run=this.store.get(id);
    if (!run || terminalPhases.has(run.phase)) return;
    if(recovery&&!run.recoveryFromPhase)run=this.store.update(id,{recoveryFromPhase:run.phase},'recovery_origin');
    if (!run.promptId) {
      if(recovery&&(run.enhancerStartIntent||(run.recoveryFromPhase??run.phase)==='enhancing')) {
        if(!enhancerCleanupConfirmed(run))return this.finish(id,'needs_attention','PE開始後の終了・資源回復の記録がありません。中核を再ロードせず確認待ちにします。');
        // A durable PE exit proof permits only cleanup, never another enhancement
        // or submission. Confirm the generator did not change while offline.
        if(this.gate?.status().generationRunId===id) {
          try {
            await this.checkEpoch(run);
            const fresh=await this.adapter.preflight(run.spec);
            if(!fresh.queueEmpty||fresh.ready===false)throw new Error('PE復旧後のComfyUI待機状態を確認できません。');
          } catch(error) {await this.gate.block(error);return this.finish(id,'needs_attention',message(error));}
        }
      }
      if (run.cancelRequested) return this.finish(id,'cancelled');
      if (recovery) return this.finish(id,'failed','送信前にコントローラが終了しました。自動再開は行いません。');
      let minimumResources=null;
      if(run.spec.enhancer) {
        try {
          if(!this.enhancer||!this.gate)throw new Error('プロンプトエンハンサーの実行環境が未接続です。');
          validateEnhancementSpec(run.spec);
          await this.enhancer.preflight?.(run.spec);
        } catch(error) {return this.finish(id,this.store.get(id).cancelRequested?'cancelled':'failed',message(error));}
      }
      this.store.update(id,{phase:'preparing',error:null});
      let preflight;
      try {const serverEpoch=this.verifyEpoch?await this.verifyEpoch():null;this.store.update(id,{serverEpoch},'server_identity');}
      catch {const text=this.recordPreflightFailure(id,'initial',null,makePreflightError('SERVER_IDENTITY_UNAVAILABLE'));return this.finish(id,this.store.get(id).cancelRequested?'cancelled':'failed',text);}
      try {preflight=await this.adapter.preflight(run.spec);}
      catch(error) {const text=this.recordPreflightFailure(id,'initial',null,error);return this.finish(id,this.store.get(id).cancelRequested?'cancelled':'failed',text);}
      if (!preflight.queueEmpty||preflight.ready===false){const text=this.recordPreflightFailure(id,'initial',preflight);return this.finish(id,'failed',text);}
      if(this.gate&&QWEN21_OFFICIAL_IDS.includes(run.spec.modelProfile)&&run.spec.inputAssets?.length){
        try{
          const inputBytes=inputRgbaBytesFloor(run.spec.inputAssets),ramBase=this.gate.minRamAvailableBytes??0,commitBase=this.gate.minCommitAvailableBytes??0;
          if(![ramBase,commitBase].every(value=>Number.isSafeInteger(value)&&value>=0))throw Error();
          minimumResources={minFreeBytes:0,minRamAvailableBytes:ramBase+inputBytes,minCommitAvailableBytes:commitBase+inputBytes};
          if(!Object.values(minimumResources).every(Number.isSafeInteger))throw Error();
          this.store.update(id,{inputMemoryFloor:{kind:'one-rgba-input-copy',bytes:inputBytes,scope:'lower-bound-only-not-peak'}},'input_memory_floor');
        }catch{const text=this.recordPreflightFailure(id,'initial',null,makePreflightError('ASSET_VERIFICATION_FAILED'));return this.finish(id,'failed',text);}
      }
      run=this.store.get(id);
      if(run.cancelRequested) return this.finish(id,'cancelled');
      try { await this.checkEpoch(run); }
      catch(error) { return this.finish(id,'failed',message(error)); }
      run=this.store.get(id);
      if(run.cancelRequested) return this.finish(id,'cancelled');
      if(this.gate) {
        this.store.update(id,{phase:'draining_core'});
        const cancellation=this.cancellationWatch(id);
        try {const lease=await this.gate.acquireGenerator(id,{signal:cancellation.signal,...(minimumResources?{minimumResources}:{})});this.store.update(id,{gpuLease:lease,...(minimumResources?{resourceRequirements:minimumResources}:{})},'generator_lease');}
        catch(error) {
          const gate=this.gate.status();
          // An abort before ownership was assigned is safe to finish. Once an
          // unload/handoff began, unknown ownership must not trigger a reload.
          if(this.store.get(id).cancelRequested&&gate.generationRunId!==id&&!gate.blocked&&['core','none'].includes(gate.owner)) return this.finish(id,'cancelled');
          if(this.store.get(id).cancelRequested&&gate.generationRunId===id&&error.cleanupConfirmed===true) {
            try {
              await this.checkEpoch(this.store.get(id));
              const fresh=await this.adapter.preflight(run.spec);
              if(!fresh.queueEmpty||fresh.ready===false)throw new Error('停止後のComfyUI待機状態を確認できません。');
            } catch(cleanup) {await this.gate.block(cleanup);return this.finish(id,'needs_attention',message(cleanup));}
            return this.finish(id,'cancelled');
          }
          if(gate.generationRunId===id&&error.resourceAdmissionRejected===true&&error.cleanupConfirmed===true){
            const causeCode=['RESOURCES_BUSY','RESOURCES_UNKNOWN'].includes(error.cause?.code)?error.cause.code:null;
            this.store.update(id,{resourceAdmission:{requirements:error.requirements??minimumResources,observation:gate.resources??null,decision:'rejected',code:error.code,causeCode}},'generator_admission_rejected');
            try {
              await this.checkEpoch(this.store.get(id));
              const fresh=await this.adapter.preflight(run.spec);
              if(!fresh.queueEmpty||fresh.ready===false)throw new Error('資源不足後のComfyUI待機状態を確認できません。');
            } catch(cleanup) {await this.gate.block(cleanup);return this.finish(id,'needs_attention',message(cleanup));}
            return this.finish(id,'failed',message(error));
          }
          return this.finish(id,'needs_attention',message(error));
        } finally {cancellation.close();}
      }
      run=this.store.get(id);
      if(run.cancelRequested) return this.finish(id,'cancelled');
      let effectiveSpec=run.spec;
      if(run.spec.enhancer) {
        if(!this.enhancer||!this.gate) return this.finish(id,'failed','プロンプトエンハンサーの実行環境が未接続です。');
        const intent={id:randomUUID(),at:new Date().toISOString(),controllerId:this.store.controllerId};
        this.store.update(id,{phase:'enhancing',enhancerStartIntent:intent,enhancerCleanup:null},'enhancer_start_intent');
        const cancellation=this.cancellationWatch(id);
        let peRecord=null;
        try {
          await this.gate.beginEnhancer(id,{signal:cancellation.signal});
          const enhanced=await this.enhancer.enhance(run.spec,{signal:cancellation.signal});
          peRecord=enhanced.record;
          const proof=enhancerProof(intent,peRecord);
          if(!proof)throw new Error('PE子プロセスの終了・資源回復の証拠を確認できません。');
          this.store.update(id,{enhancement:peRecord,enhancerCleanup:proof},'enhancer_cleanup_confirmed');
          await this.gate.endEnhancer(id);
          effectiveSpec={...run.spec,prompt:enhanced.prompt,negativePrompt:enhanced.negativePrompt??run.spec.negativePrompt};
          this.store.update(id,{enhancement:enhanced.record,effectiveSpec,specHash:digest(effectiveSpec)},'prompt_enhanced');
        } catch(error) {
          const failureRecord=error.record??peRecord;
          const proof=enhancerProof(intent,failureRecord);
          this.store.update(id,{enhancementFailure:{code:error.code??'PE_FAILED',message:message(error),record:failureRecord??null,childStarted:error.childStarted===false?false:null,at:new Date().toISOString()},...(proof?{enhancerCleanup:proof}:{})},'enhancer_failed');
          // A child failure may only restore the core if process exit and VRAM recovery were proven.
          if(proof||error.childStarted===false) {
            try {
              const after=await this.gate.endEnhancer(id);
              if(error.childStarted===false)this.store.update(id,{enhancerCleanup:{intentId:intent.id,confirmed:true,childStarted:false,childExited:null,resourceAfter:after.resources??null,at:new Date().toISOString()}},'enhancer_not_started_cleanup_confirmed');
            } catch(cleanup) {return this.finish(id,'needs_attention',message(cleanup));}
            return this.finish(id,this.store.get(id).cancelRequested?'cancelled':'failed',message(error));
          }
          await this.gate.block(error);return this.finish(id,'needs_attention',message(error));
        } finally {cancellation.close();}
      }
      run=this.store.get(id);
      if(run.cancelRequested) return this.finish(id,'cancelled');
      if(this.gate) {
        let fresh;
        try {
          fresh=await this.adapter.preflight(run.spec);
          if(!fresh.queueEmpty||fresh.ready===false){const text=this.recordPreflightFailure(id,'after-core-release',fresh);throw Object.assign(new Error(text),{preflightRecorded:true});}
        } catch(error) {const text=error.preflightRecorded?error.message:this.recordPreflightFailure(id,'after-core-release',null,error);await this.gate.block(new Error(text));return this.finish(id,'needs_attention',text);}
      }
      run=this.store.get(id);
      if(run.cancelRequested) return this.finish(id,'cancelled');
      if(this.observeOutputDisks){
        let disk;
        try {
          disk=await this.observeOutputDisks();
          if(!disk||!Array.isArray(disk.volumes)||!disk.volumes.length||disk.volumes.some(volume=>!Number.isSafeInteger(volume.availableBytes)||volume.availableBytes<0))throw new Error('出力先の空き容量が不正です。');
          // The estimate is unknown; only a zero-byte observation establishes insufficiency.
          disk={...disk,estimatedOutputBytes:null,sufficiency:disk.volumes.some(volume=>volume.availableBytes===0)?'insufficient':'unknown'};
          this.store.update(id,{diskObservation:disk},'output_disk_observed');
        } catch(error) {
          this.store.update(id,{diskObservation:{observedAt:new Date().toISOString(),sufficiency:'unavailable',estimatedOutputBytes:null,error:message(error)}},'output_disk_unavailable');
          return this.finish(id,this.store.get(id).cancelRequested?'cancelled':'failed','出力先の空き容量を確認できないため送信しません。');
        }
        if(this.store.get(id).cancelRequested)return this.finish(id,'cancelled');
        if(disk.sufficiency==='insufficient')return this.finish(id,'failed','出力先の空き容量が0 bytesのため送信しません。');
      }
      const promptId=randomUUID();
      let payload;
      try {payload=this.adapter.buildPrompt(effectiveSpec,{runId:id,promptId,controllerId:this.store.controllerId});}
      catch(error) {return this.finish(id,'failed',message(error));}
      // This durable intent is committed before the ONLY submission call. Cancellation
      // cannot interleave between this synchronous commit and invoking submit().
      run=this.store.update(id,{phase:'submitting',promptId,progressClientId:payload.client_id===promptId?promptId:null,progressInstanceId:payload.client_id===promptId?MONITOR_INSTANCE_ID:null,preflight,submittedAt:new Date().toISOString()},'submit_intent');
      try {
        const reply=await this.adapter.submit(payload);
        if(reply.prompt_id!==promptId) throw new Error('ComfyUIが別のprompt_idを返しました。再送せず確認します。');
        const partial=reply.node_errors && Object.keys(reply.node_errors).length>0;
        run=this.store.update(id,{phase:'generating',accepted:true,nodeErrors:reply.node_errors??{},error:partial?'一部ノードの受付エラー。対象ジョブを停止して確認します。':null},'submit_ack');
        if(partial) this.store.cancel(id);
      } catch(error) {
        if(error.definitelyRejected===true) {this.store.update(id,{definitelyRejected:true},'submit_rejected');return this.finish(id,'failed',message(error));}
        run=this.store.update(id,{phase:'submission_unknown',error:message(error)},'submit_unknown');
      }
    }
    // Following a crash we only inspect the persisted ID; a second POST is forbidden.
    const monitorTimeoutMs=monitorTimeoutFor(run.spec,this.jobTimeoutMs);
    const started=Date.now();
    let observed=Boolean(run.accepted), cancelledConfirmed=false, absentAfterCancel=0, cancelStarted=0;
    while(Date.now()-started<monitorTimeoutMs) {
      run=this.store.get(id);
      let snapshot;
      try { await this.checkEpoch(run); snapshot=await this.adapter.inspect(run.promptId); }
      catch(error) {
        return this.finish(id,'recovery_required','ComfyUIの状態を確認できません。再送せず台帳を保持しました。 '+message(error));
      }
      const present=snapshot.queued||snapshot.running||Boolean(snapshot.history);
      if(present&&!this.owned(run,snapshot)) return this.finish(id,'needs_attention','ジョブの所有情報が一致しません。停止・解放を行わず確認待ちです。');
      if(present) observed=true;
      if(snapshot.history&&!snapshot.queued&&!snapshot.running) {
        return this.saveAndRelease(id,snapshot.history);
      }
      if(run.cancelRequested) {
        if(!cancelStarted) cancelStarted=Date.now();
        this.store.update(id,{phase:'cancelling',progress:{state:snapshot.running?'running':snapshot.queued?'pending':'checking'}},'cancel_poll');
        if(snapshot.queued||snapshot.running) {
          try {
            await this.checkEpoch(run);
            const reply=await this.adapter.cancel(run.promptId);
            cancelledConfirmed=cancelledConfirmed||reply?.cancelled===true;
            this.store.update(id,{cancelReply:reply},'cancel_dispatched');
          } catch(error) { this.store.update(id,{error:message(error)},'cancel_transport_error'); }
          absentAfterCancel=0;
        } else if(observed&&cancelledConfirmed) {
          absentAfterCancel++;
          if(absentAfterCancel>=2) {
            if(!this.verifyEpoch||!run.serverEpoch) return this.finish(id,'recovery_required','履歴なしの停止をプロセス情報で確認できません。解放せず記録を保持しました。');
            await this.checkEpoch(run);
            return this.saveAndRelease(id,null);
          }
        }
        if(Date.now()-cancelStarted>=this.cancelTimeoutMs) return this.finish(id,'recovery_required','停止の終端を確認できません。新規生成を止めて台帳を保持しました。');
      } else if(!present) {
        // Missing history cannot prove rejection (or completion) after an uncertain POST.
        if(Date.now()-started>=10000) return this.finish(id,'recovery_required','保存済みprompt_idがキュー・履歴に見つかりません。二重生成を避けるため再送していません。');
      } else {
        const next=snapshot.running?'running':'pending';
        if(run.phase!=='generating'||run.progress?.state!==next) this.store.update(id,{phase:'generating',progress:{state:next},error:null,accepted:true},'queue_state');
      }
      await sleep(this.pollIntervalMs);
    }
    return this.finish(id,'recovery_required','生成の監視期限を超えました。対象の再送や一括停止は行っていません。停止操作で再照合できます。');
  }
  async saveAndRelease(id,history) {
    let run=this.store.update(id,{phase:'saving'});
    let saveError=null;
    try {
      const artifacts=history?await this.adapter.collect(run.promptId,{runId:id,controllerId:this.store.controllerId,destination:join(this.outputRoot,id),spec:run.spec}):[];
      run=this.store.update(id,{artifacts,historyStatus:history?.status??null},'artifacts_saved');
      await this.manifest(run);
    } catch(error) { saveError=message(error); this.store.update(id,{error:saveError},'save_failed'); }
    this.store.update(id,{phase:'releasing'});
    try {
      await this.checkEpoch(this.store.get(id));
      // Release checks the queue and samples memory across multiple HTTP calls.
      // Revalidate the original server identity around each check, not just
      // before entering the release operation.
      const release=await this.adapter.release({assertEpoch:()=>this.checkEpoch(this.store.get(id))});
      this.store.update(id,{release},'gpu_released');
    }
    catch(error) { return this.finish(id,'needs_attention','成果物は保持しています。GPU解放を確認できません。 '+message(error)); }
    run=this.store.get(id);
    if(saveError) return this.finish(id,'needs_attention','出力保存を確認できません。 '+saveError);
    if(run.cancelRequested) return this.finish(id,'cancelled');
    const success=history?.status?.status_str==='success'&&history?.status?.completed===true&&run.artifacts.length>0;
    return this.finish(id,success?'completed':'failed',success?null:'生成が正常完了しませんでした。保存できた成果物と履歴を保持しました。');
  }
}
