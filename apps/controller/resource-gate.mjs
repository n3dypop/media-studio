// CPU-only cooperative admission and GPU ownership. No lifecycle action is inferred
// from an HTTP 200 alone, and uncertain cleanup keeps new inference blocked.
export class GateError extends Error {
  constructor(message,code='GPU_GATE_BLOCKED') { super(message);this.status=503;this.code=code; }
}
// Only stableResources can mark a deadline reached after a valid low sample.
// An observer error with a matching public code is not resource evidence.
const observedShortage=Symbol('observed-resource-shortage');
const aborted=signal=>signal?.throwIfAborted();
const wait=(ms,signal)=>new Promise((resolve,reject)=>{
  aborted(signal);
  const stop=()=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);reject(signal.reason);};
  const timer=setTimeout(()=>{signal?.removeEventListener('abort',stop);resolve();},ms);
  signal?.addEventListener('abort',stop,{once:true});
});
const abortable=(promise,signal)=>new Promise((resolve,reject)=>{
  aborted(signal);
  const abort=()=>reject(signal.reason);
  signal.addEventListener('abort',abort,{once:true});
  Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
});

class Mutex {
  constructor(){this.locked=false;this.waiters=[];}
  async acquire(signal){
    aborted(signal);
    if(this.locked) await new Promise((resolve,reject)=>{
      const item={resolve:()=>{signal?.removeEventListener('abort',abort);resolve();},reject};
      const abort=()=>{const at=this.waiters.indexOf(item);if(at>=0)this.waiters.splice(at,1);reject(signal.reason);};
      signal?.addEventListener('abort',abort,{once:true});this.waiters.push(item);
    });
    else this.locked=true;
    let released=false;
    return ()=>{if(released)return;released=true;const next=this.waiters.shift();if(next)next.resolve();else this.locked=false;};
  }
}

export class ResourceGate {
  constructor({strata,observeResources,onState=async()=>{},beforeCoreLoad=null,minFreeBytes=8*1024**3,minCoreFreeBytes=minFreeBytes,minRamAvailableBytes=0,minCommitAvailableBytes=0,stableSamples=2,intervalMs=500,drainTimeoutMs=60000,resourceTimeoutMs=45000}) {
    if(!strata||typeof observeResources!=='function'||typeof onState!=='function')throw new TypeError('Strata, resource observation, and state callback are required');
    if(beforeCoreLoad!==null&&typeof beforeCoreLoad!=='function')throw new TypeError('Core load preflight must be a function');
    for(const [key,value]of Object.entries({minFreeBytes,minCoreFreeBytes,minRamAvailableBytes,minCommitAvailableBytes,stableSamples,intervalMs,drainTimeoutMs,resourceTimeoutMs}))if(!Number.isSafeInteger(value)||value<0||(['stableSamples','intervalMs','drainTimeoutMs','resourceTimeoutMs'].includes(key)&&value<1))throw new TypeError('Invalid gate limit: '+key);
    Object.assign(this,{strata,observeResources,onState,beforeCoreLoad:beforeCoreLoad??(async()=>{}),hasCoreLoadPreflight:beforeCoreLoad!==null,minFreeBytes,minCoreFreeBytes,minRamAvailableBytes,minCommitAvailableBytes,stableSamples,intervalMs,drainTimeoutMs,resourceTimeoutMs});
    this.owner='unknown';this.activeCore=0;this.blocked=true;this.generationRunId=null;this.error=null;this.initialized=false;this.strataStarted=null;this.resources=null;
    this.mutex=new Mutex();this.changed=new Set();this.publications=Promise.resolve();
  }
  status(){return {owner:this.owner,activeCore:this.activeCore,blocked:this.blocked,generationRunId:this.generationRunId,error:this.error,initialized:this.initialized,strataStarted:this.strataStarted,resources:this.resources};}
  notify(){for(const notify of this.changed)notify();this.changed.clear();}
  async publish(){
    const snapshot=this.status();
    const operation=this.publications.then(()=>this.onState(snapshot));
    this.publications=operation.catch(()=>{});
    try{await operation;}catch(error){this.owner='unknown';this.blocked=true;this.error='GPU使用権の永続化を確認できません。';this.notify();throw error;}
    this.notify();
  }
  async block(error){this.owner='unknown';this.blocked=true;this.error=String(error?.message??error).slice(0,800);await this.publish();}
  changedOrAbort(signal){return new Promise((resolve,reject)=>{
    aborted(signal);
    const done=()=>{this.changed.delete(done);signal?.removeEventListener('abort',abort);resolve();};
    const abort=()=>{this.changed.delete(done);signal?.removeEventListener('abort',abort);reject(signal.reason);};
    this.changed.add(done);signal?.addEventListener('abort',abort,{once:true});
  });}
  readyCore(status){
    if(!status.loaded||status.vision?.enabled!==true||status.vision?.available!==true||status.vision?.error!=null)throw new GateError('画像入力可能な中核モデルの準備を確認できません。','CORE_NOT_READY');
  }
  async state({signal}={}){
    const status=await this.strata.status({signal});
    if(!Number.isSafeInteger(status.activity?.in_flight)||status.activity.in_flight<0||typeof status.loaded!=='boolean')throw new GateError('中核の実行状態を確認できません。');
    if(this.strataStarted!==null&&status.started!==this.strataStarted)throw new GateError('中核モデルの実行世代が変わりました。','CORE_EPOCH_CHANGED');
    if(!Number.isSafeInteger(status.started)||status.started<1)throw new GateError('中核の実行世代を確認できません。');
    this.strataStarted=status.started;return status;
  }
  async initialize(options={}){
    if(typeof options==='boolean')options={recovery:options};
    const {recovery=false,previousState=null,signal}=options;
    const unlock=await this.mutex.acquire(signal);
    try{
      aborted(signal);
      if(this.initialized)throw new GateError('GPUゲートは既に初期化されています。');
      if(previousState?.strataStarted!=null)this.strataStarted=previousState.strataStarted;
      if(recovery||previousState?.generationRunId||previousState?.activeCore>0||previousState?.blocked===true){
        this.generationRunId=previousState?.generationRunId??null;this.initialized=true;
        await this.block('前回のGPU使用権を照合する必要があります。モデルの自動ロードは行いません。');return this.status();
      }
      const current=await this.state({signal});
      if(current.activity.in_flight!==0)throw new GateError('中核に既存の推論があります。初期化を保留します。');
      if(current.loaded)this.readyCore(current);
      this.owner=current.loaded?'core':'none';this.blocked=false;this.error=null;this.initialized=true;await this.publish();return this.status();
    }catch(error){await this.block(error);throw error;}finally{unlock();}
  }
  async stableResources(minimum,signal,requirements={}){
    const minRamAvailableBytes=Math.max(this.minRamAvailableBytes,requirements.minRamAvailableBytes??0);
    const minCommitAvailableBytes=Math.max(this.minCommitAvailableBytes,requirements.minCommitAvailableBytes??0);
    const deadline=Date.now()+this.resourceTimeoutMs;let count=0;
    while(true){
      aborted(signal);
      const deadlineSignal=AbortSignal.timeout(Math.max(1,deadline-Date.now()));
      const observationSignal=signal?AbortSignal.any([signal,deadlineSignal]):deadlineSignal;
      let sample;
      try{sample=await abortable(this.observeResources({signal:observationSignal}),observationSignal);}
      catch(error){if(signal?.aborted)throw signal.reason;if(deadlineSignal.aborted)throw new GateError('RAM・VRAMの観測が期限内に完了しませんでした。','RESOURCES_UNKNOWN');throw error;}
      if(!sample||!Number.isSafeInteger(sample.freeBytes)||sample.freeBytes<0||(minRamAvailableBytes>0&&(!Number.isSafeInteger(sample.ramAvailableBytes)||sample.ramAvailableBytes<0)))throw new GateError('RAM・VRAMの実測値を確認できません。','RESOURCES_UNKNOWN');
      if(minCommitAvailableBytes>0&&(!Number.isSafeInteger(sample.commitAvailableBytes)||sample.commitAvailableBytes<0))throw new GateError('Windowsコミット余裕を確認できません。','RESOURCES_UNKNOWN');
      this.resources={freeBytes:sample.freeBytes};
      for(const field of ['ramAvailableBytes','commitUsedBytes','commitLimitBytes','commitAvailableBytes'])if(Number.isSafeInteger(sample[field])&&sample[field]>=0)this.resources[field]=sample[field];
      this.resources.observedAt=typeof sample.observedAt==='string'?sample.observedAt:new Date().toISOString();
      count=sample.freeBytes>=minimum&&(minRamAvailableBytes===0||sample.ramAvailableBytes>=minRamAvailableBytes)&&(minCommitAvailableBytes===0||sample.commitAvailableBytes>=minCommitAvailableBytes)?count+1:0;
      if(count>=this.stableSamples)return this.resources;
      if(Date.now()>=deadline){const error=new GateError('モデル交代に必要なRAM・VRAMの余裕を確認できません。','RESOURCES_BUSY');error[observedShortage]=true;throw error;}
      await wait(Math.min(this.intervalMs,Math.max(1,deadline-Date.now())),signal);
    }
  }
  async acquireCore(signal){
    while(true){
      aborted(signal);
      const unlock=await this.mutex.acquire(signal);let waiting;
      try{
        aborted(signal);
        if(!this.initialized)throw new GateError('GPUゲートが初期化されていません。');
        if(this.generationRunId&&this.owner!=='unknown')waiting=this.changedOrAbort(signal);
        else{
          if(this.blocked||!['core','none'].includes(this.owner))throw new GateError(this.error||'GPU使用権の確認待ちです。');
          if(this.owner==='none'){
            this.owner='loading_core';this.blocked=true;await this.publish();
            let refusedBeforeLoad=false;
            try{
              try{await this.stableResources(this.minCoreFreeBytes,signal);}
              catch(error){
                // A positive shortage is the only automatically recoverable
                // failure here. No lifecycle request has been sent by this
                // admission. Recheck external Comfy ownership and the same
                // Strata epoch before durably reopening the idle gate.
                if(error?.code!=='RESOURCES_BUSY'||error[observedShortage]!==true||signal?.aborted||!this.hasCoreLoadPreflight)throw error;
                const cleanupSignal=AbortSignal.timeout(10000);
                await abortable(Promise.resolve().then(()=>this.beforeCoreLoad({signal:cleanupSignal})),cleanupSignal);
                const observed=await abortable(this.state({signal:cleanupSignal}),cleanupSignal);
                if(observed.loaded||observed.activity.in_flight!==0||this.owner!=='loading_core'||this.generationRunId!==null||this.activeCore!==0)
                  throw new GateError('資源不足の確認中にGPUまたは中核の状態が変わりました。');
                this.owner='none';this.blocked=false;this.error=null;
                await this.publish();
                refusedBeforeLoad=true;
                throw error;
              }
              await this.beforeCoreLoad({signal});
              const before=await this.state({signal});if(before.loaded||before.activity.in_flight!==0)throw new GateError('中核の状態が受付前に変わりました。');
              await this.strata.load({signal});const current=await this.state({signal});this.readyCore(current);
              if(current.activity.in_flight!==0)throw new GateError('中核に管理外の推論があります。');
              this.owner='core';this.blocked=false;this.error=null;
            }catch(error){if(!refusedBeforeLoad)await this.block(error);throw error;}
          }else{
            try{this.readyCore(await this.state({signal}));}
            catch(error){await this.block(error);throw error;}
          }
          this.activeCore++;await this.publish();
          let released=false;
          return async()=>{if(released)return;released=true;this.activeCore--;await this.publish();};
        }
      }finally{unlock();}
      await waiting;
    }
  }
  async acquireGenerator(runId,{signal,minimumResources=null}={}){
    if(typeof runId!=='string'||!runId||runId.length>128)throw new TypeError('A bounded generation run ID is required');
    if(minimumResources!==null&&(!minimumResources||typeof minimumResources!=='object'||Array.isArray(minimumResources)||Object.keys(minimumResources).some(key=>!['minFreeBytes','minRamAvailableBytes','minCommitAvailableBytes'].includes(key))||['minFreeBytes','minRamAvailableBytes','minCommitAvailableBytes'].some(key=>!Number.isSafeInteger(minimumResources[key])||minimumResources[key]<0)))throw new TypeError('Invalid generation resource requirements');
    const unlock=await this.mutex.acquire(signal);
    let previousOwner,unloadStarted=false,unloadConfirmed=false;
    try{
      aborted(signal);
      // Under the mutex this is a definite refusal before assigning the
      // caller's run or issuing any model lifecycle operation. The explicit
      // proof lets that caller finish without changing the foreign lease.
      if(this.initialized&&this.generationRunId&&this.generationRunId!==runId&&this.owner!=='unknown'){
        const busy=new GateError('別の生成がGPU使用権を所有しています。','GENERATOR_LEASE_BUSY');
        busy.leaseNotAcquired=true;throw busy;
      }
      if(!this.initialized||this.blocked||this.generationRunId||!['core','none'].includes(this.owner))throw new GateError('別の生成またはGPU使用権の確認が残っています。');
      previousOwner=this.owner;
      this.generationRunId=runId;this.owner='draining_core';this.blocked=true;this.error=null;await this.publish();
      const deadline=Date.now()+this.drainTimeoutMs;
      while(this.activeCore>0){if(Date.now()>=deadline)throw new GateError('中核の応答streamが終了していません。','CORE_BUSY');await wait(this.intervalMs,signal);}
      let current;
      while(true){
        aborted(signal);current=await this.state({signal});if(current.activity.in_flight===0)break;
        if(Date.now()>=deadline)throw new GateError('Strataの実行中・待機中の推論が終了していません。','CORE_BUSY');
        await wait(this.intervalMs,signal);
      }
      aborted(signal);
      // Once a lifecycle POST starts, do not abandon its response on user stop:
      // GET in_flight does not count Strata's model-management FIFO operation.
      // A fresh bounded signal lets the original unload settle before any reload.
      const cleanupSignal=AbortSignal.timeout(30000);
      if(current.loaded){unloadStarted=true;await this.strata.unload({signal:cleanupSignal});}
      current=await this.state({signal:unloadStarted?cleanupSignal:signal});if(current.loaded||current.activity.in_flight!==0)throw new GateError('中核の解放完了を確認できません。');
      unloadConfirmed=true;
      this.owner='none';this.resources=null;await this.publish();
      try {
        await this.stableResources(Math.max(this.minFreeBytes,minimumResources?.minFreeBytes??0),signal,minimumResources??{});
      } catch(error) {
        if(!signal?.aborted){
          const denied=new GateError('指定モデルの試験開始に必要なRAM・コミット余裕・VRAMを確認できません。生成は送信していません。','GENERATOR_RESOURCES_UNAVAILABLE');
          denied.resourceAdmissionRejected=true;denied.cleanupConfirmed=true;denied.cause=error;
          denied.requirements={minFreeBytes:Math.max(this.minFreeBytes,minimumResources?.minFreeBytes??0),minRamAvailableBytes:Math.max(this.minRamAvailableBytes,minimumResources?.minRamAvailableBytes??0),minCommitAvailableBytes:Math.max(this.minCommitAvailableBytes,minimumResources?.minCommitAvailableBytes??0)};
          throw denied;
        }
        throw error;
      }
      aborted(signal);
      // Recheck auto-load immediately before assigning the generator's lease.
      current=await this.state({signal});if(current.loaded||current.activity.in_flight!==0)throw new GateError('受渡し中に中核が再ロードされました。');
      this.owner='generator';await this.publish();return this.status();
    }catch(error){
      if(this.generationRunId===runId&&unloadConfirmed&&error.resourceAdmissionRejected===true){
        // No generator was assigned or submitted. Keep the lease closed until
        // the engine proves Comfy idle and restores the core with its own limits.
        this.owner='none';this.blocked=true;this.error=error.message;await this.publish();throw error;
      }
      if(this.generationRunId===runId&&signal?.aborted&&error===signal.reason){
        if(!unloadStarted){
          // Admission was the only changed state. The original core streams may
          // still finish; no model lifecycle or generator operation was sent.
          this.owner=previousOwner;this.generationRunId=null;this.blocked=false;this.error=null;await this.publish();
          throw error;
        }
        if(unloadConfirmed){
          const cancelled=new GateError('停止を受け付け、中核のアンロード完了を確認しました。','GENERATION_CANCELLED');
          cancelled.cleanupConfirmed=true;
          // Keep admission closed and the run identity until the engine verifies
          // Comfy is still idle and returnToCore completes with a fresh signal.
          throw cancelled;
        }
      }
      if(this.generationRunId===runId)await this.block(error);throw error;
    }finally{unlock();}
  }
  async returnToCore(runId,{signalcleanup,signal=signalcleanup,assertGeneratorIdle=null,resumeRecovery=false}={}){
    // Caller must already prove ALL owned Comfy jobs terminal, foreign queue empty,
    // and Comfy memory released. A cancelled production signal must not abort cleanup.
    const unlock=await this.mutex.acquire(signal);
    try{
      aborted(signal);
      if(this.generationRunId!==runId){
        // A crash can occur after the durable gate cleared its lease but before
        // the run became terminal. Only the explicit, proven retirement path
        // may reattach that still-blocked recovery lease; ordinary callers cannot.
        if(!resumeRecovery||typeof assertGeneratorIdle!=='function'||this.generationRunId!==null||!this.blocked||this.owner!=='unknown'||this.activeCore!==0)throw new GateError('GPU使用権の生成IDが一致しません。');
        await assertGeneratorIdle();
        this.generationRunId=runId;await this.publish();
      }
      if(assertGeneratorIdle)await assertGeneratorIdle();
      const previousOwner=this.owner;
      this.owner='restoring_core';this.blocked=true;await this.publish();
      const current=await this.state({signal});
      if(current.activity.in_flight!==0)throw new GateError('中核に管理外の推論があります。');
      if(['generator','enhancer'].includes(previousOwner)&&current.loaded)throw new GateError('画像生成中に中核が管理外で再ロードされました。');
      if(!current.loaded){await this.stableResources(this.minCoreFreeBytes,signal);await this.beforeCoreLoad({signal});if(assertGeneratorIdle)await assertGeneratorIdle();await this.strata.load({signal});}
      const restored=await this.state({signal});this.readyCore(restored);
      if(restored.activity.in_flight!==0)throw new GateError('復帰中に管理外の推論が始まりました。');
      this.owner='core';this.blocked=false;this.generationRunId=null;this.error=null;await this.publish();return this.status();
    }catch(error){if(this.generationRunId===runId)await this.block(error);throw error;}finally{unlock();}
  }
  async beginEnhancer(runId,{signal}={}){
    const unlock=await this.mutex.acquire(signal);
    try{
      aborted(signal);
      if(this.generationRunId!==runId||this.owner!=='generator')throw new GateError('PEへ渡す生成使用権が一致しません。');
      const current=await this.state({signal});if(current.loaded||current.activity.in_flight!==0)throw new GateError('PEの前に中核が解放されていません。');
      this.owner='enhancer';this.blocked=true;await this.publish();return this.status();
    }catch(error){if(this.generationRunId===runId)await this.block(error);throw error;}finally{unlock();}
  }
  async unloadIdle(service,{releaseGenerator,assertGeneratorIdle=async()=>{},signal}={}){
    if(!['Strata','ComfyUI'].includes(service)||service==='ComfyUI'&&typeof releaseGenerator!=='function')throw new TypeError('An eligible unload target is required');
    const unlock=await this.mutex.acquire(signal);let changed=false;
    try{
      aborted(signal);
      if(!this.initialized||this.blocked||this.activeCore!==0||this.generationRunId||!['core','none'].includes(this.owner))throw new GateError('実行中または未解決のGPU使用権があります。','RESOURCE_UNLOAD_BUSY');
      const before=await this.state({signal});
      if(before.activity.in_flight!==0)throw new GateError('Strataに実行中の推論があります。','RESOURCE_UNLOAD_BUSY');
      await assertGeneratorIdle();
      this.owner='releasing_resources';this.blocked=true;this.error=null;changed=true;await this.publish();
      // Lifecycle requests retain their bounded cleanup signal even if the UI
      // disconnects. A lost reply must never trigger an automatic second POST.
      const cleanupSignal=AbortSignal.timeout(60000);
      let evidence;
      if(service==='Strata'){
        if(before.loaded)await this.strata.unload({signal:cleanupSignal});
      }else evidence=await releaseGenerator();
      await assertGeneratorIdle();
      const after=await this.state({signal:cleanupSignal});
      if(after.activity.in_flight!==0||service==='Strata'&&after.loaded||service==='ComfyUI'&&after.loaded!==before.loaded||service==='ComfyUI'&&evidence?.released!==true)throw new GateError('資源解放後の状態を確認できません。','RESOURCE_UNLOAD_UNKNOWN');
      this.owner=after.loaded?'core':'none';this.blocked=false;this.resources=null;this.error=null;await this.publish();
      return {service,released:true,resources:this.status(),...(evidence?{evidence}:{})};
    }catch(error){if(changed){await this.block(error);error.uncertain=true;}throw error;}finally{unlock();}
  }
  async endEnhancer(runId,{signalcleanup,signal=signalcleanup}={}){
    // Caller must prove its exact PE child has exited, even after cancellation/error.
    const unlock=await this.mutex.acquire(signal);
    try{
      aborted(signal);
      if(this.generationRunId!==runId||this.owner!=='enhancer')throw new GateError('PEの使用権が一致しません。');
      const current=await this.state({signal});if(current.loaded||current.activity.in_flight!==0)throw new GateError('PE中に中核が管理外で動き始めました。');
      await this.stableResources(this.minFreeBytes,signal);
      const after=await this.state({signal});if(after.loaded||after.activity.in_flight!==0)throw new GateError('PE解放中に中核が再ロードされました。');
      this.owner='generator';this.blocked=true;await this.publish();return this.status();
    }catch(error){if(this.generationRunId===runId)await this.block(error);throw error;}finally{unlock();}
  }
}
