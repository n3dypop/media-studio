import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha256=value=>createHash('sha256').update(value).digest('hex');
const SCRIPT=fileURLToPath(new URL('./enhance_prompt.py',import.meta.url));
export class EnhancerError extends Error {
  constructor(message,code='PE_FAILED'){super(message);this.code=code;this.cleanupConfirmed=false;}
}
export function validateEnhancementSpec(spec){
  if(!spec||typeof spec.prompt!=='string'||!spec.prompt.trim()||spec.prompt.length>6000)throw new TypeError('PE prompt must contain 1–6000 characters');
  if(spec.negativePrompt!==undefined&&(typeof spec.negativePrompt!=='string'||spec.negativePrompt.length>3000))throw new TypeError('Invalid PE negative prompt');
  const invariants=spec.invariants??[];
  if(!Array.isArray(invariants)||invariants.length>32)throw new TypeError('Invalid PE invariants');
  const fixed=invariants.map((item,index)=>{
    const requirement=typeof item==='string'?item:item?.requirement;
    const id=typeof item==='string'?`fixed-${index+1}`:item?.id;
    if(typeof requirement!=='string'||!requirement.trim()||requirement.length>500||typeof id!=='string'||!id||id.length>100)throw new TypeError('Invalid fixed PE requirement');
    return {id,requirement};
  });
  if(fixed.reduce((sum,item)=>sum+item.requirement.length,0)>2500)throw new TypeError('PE invariants are too long');
  return {prompt:spec.prompt,negativePrompt:spec.negativePrompt??'',invariants:fixed,seed:typeof spec.seed==='string'&&/^[0-9]{1,16}$/.test(spec.seed)?spec.seed:'20261102'};
}
function waitFor(promise,signal){return new Promise((resolve,reject)=>{
  signal.throwIfAborted();const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
  Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
});}

export class PromptEnhancer {
  constructor({pythonExecutable,modelPath,scriptPath=SCRIPT,observeResources,timeoutMs=180000,cleanupTimeoutMs=30000,minFreeBytes=8*1024**3,stableSamples=2,intervalMs=500,terminateWaitMs=5000,spawnProcess=spawn,fileInfo=stat}){
    for(const path of [pythonExecutable,modelPath,scriptPath])if(typeof path!=='string'||!isAbsolute(path))throw new TypeError('PE paths must be absolute');
    if(!/\.gguf$/i.test(modelPath)||typeof observeResources!=='function')throw new TypeError('A local GGUF and resource observer are required');
    for(const value of [timeoutMs,cleanupTimeoutMs,stableSamples,intervalMs,terminateWaitMs])if(!Number.isSafeInteger(value)||value<1)throw new TypeError('Invalid PE deadline');
    if(!Number.isSafeInteger(minFreeBytes)||minFreeBytes<0)throw new TypeError('Invalid PE resource threshold');
    Object.assign(this,{pythonExecutable,modelPath,scriptPath,observeResources,timeoutMs,cleanupTimeoutMs,minFreeBytes,stableSamples,intervalMs,terminateWaitMs,spawnProcess,fileInfo});
    this.busy=false;
  }
  async preflight(spec,{signal}={}){
    signal?.throwIfAborted();validateEnhancementSpec(spec);
    if(this.busy)throw new EnhancerError('PEの実行または終了確認が残っています。','PE_BUSY');
    const infos=await Promise.all([this.pythonExecutable,this.scriptPath,this.modelPath].map(path=>this.fileInfo(path)));
    if(infos.some(info=>!info.isFile()))throw new TypeError('PE runtime, script, and model must be existing files');
    signal?.throwIfAborted();return infos;
  }
  async cleanup(){
    const signal=AbortSignal.timeout(this.cleanupTimeoutMs);let stable=0,sample;
    try{
      while(true){
        signal.throwIfAborted();sample=await waitFor(this.observeResources({signal}),signal);
        if(!sample||!Number.isSafeInteger(sample.freeBytes)||sample.freeBytes<0)throw new EnhancerError('PE終了後のVRAMを確認できません。','PE_CLEANUP_UNKNOWN');
        stable=sample.freeBytes>=this.minFreeBytes?stable+1:0;
        if(stable>=this.stableSamples)return {freeBytes:sample.freeBytes,...(Number.isSafeInteger(sample.ramAvailableBytes)?{ramAvailableBytes:sample.ramAvailableBytes}:{})};
        await waitFor(new Promise(resolve=>setTimeout(resolve,this.intervalMs)),signal);
      }
    }catch(error){if(error instanceof EnhancerError)throw error;throw new EnhancerError('PE終了後のVRAM回復を期限内に確認できません。','PE_CLEANUP_UNKNOWN');}
  }
  runChild(input,signal){
    return new Promise(resolve=>{
      let child,finished=false,started=false,childExited=false,exitCode=null,exitSignal=null,failure=null,stdoutSize=0,stderrSize=0;
      const chunks=[],stderrHash=createHash('sha256');let timeout,killTimer,unknownTimer;
      const finish=()=>{
        if(finished)return;finished=true;
        clearTimeout(timeout);clearTimeout(killTimer);clearTimeout(unknownTimer);signal?.removeEventListener('abort',cancel);
        resolve({stdout:Buffer.concat(chunks).toString('utf8'),stderrSha256:stderrHash.digest('hex'),stderrBytes:stderrSize,childPid:child?.pid??null,childExited,exitCode,exitSignal,failure,started});
      };
      const stop=reason=>{
        if(finished)return;if(!failure)failure=reason;
        if(killTimer||unknownTimer)return;
        try{child?.kill('SIGTERM');}catch{}
        if(finished)return;
        killTimer=setTimeout(()=>{
          try{child?.kill('SIGKILL');}catch{}
          if(finished)return;
          unknownTimer=setTimeout(()=>{failure=new EnhancerError('PE子プロセスの終了を確認できません。','PE_EXIT_UNKNOWN');finish();},this.terminateWaitMs);
        },this.terminateWaitMs);
      };
      const cancel=()=>stop(new EnhancerError('プロンプト補助の停止を受け付けました。','PE_CANCELLED'));
      const env={...process.env,PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',HF_HUB_DISABLE_TELEMETRY:'1',LOCAL_GENAI_PE_OWNER_PID:String(process.pid)};
      delete env.PYTHONHOME;delete env.PYTHONPATH;
      try{
        // Only interpreter flags and our fixed script appear in the command line.
        child=this.spawnProcess(this.pythonExecutable,['-I','-B','-u',this.scriptPath],{cwd:dirname(this.scriptPath),windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],env});
        started=Number.isSafeInteger(child.pid)&&child.pid>0;
        child.stdout.on('data',chunk=>{if(finished)return;const bytes=Buffer.from(chunk);stdoutSize+=bytes.length;if(stdoutSize>65536){stop(new EnhancerError('PEの出力が上限を超えました。','PE_INVALID_OUTPUT'));return;}chunks.push(bytes);});
        child.stderr.on('data',chunk=>{if(finished)return;const bytes=Buffer.from(chunk);stderrSize+=bytes.length;stderrHash.update(bytes);});
        child.on('error',()=>{if(finished)return;failure??=new EnhancerError('PE子プロセスを実行できません。','PE_PROCESS_ERROR');if(!started){childExited=true;finish();}else stop(failure);});
        child.on('close',(code,closedSignal)=>{if(finished)return;childExited=true;exitCode=code;exitSignal=closedSignal;finish();});
        child.stdin.on('error',()=>{if(!finished)stop(new EnhancerError('PE子プロセスへの入力を完了できません。','PE_PROCESS_ERROR'));});
        signal?.addEventListener('abort',cancel,{once:true});
        timeout=setTimeout(()=>stop(new EnhancerError('プロンプト補助の実行期限を超えました。','PE_TIMEOUT')),this.timeoutMs);
        if(signal?.aborted)cancel();else child.stdin.end(JSON.stringify(input)+'\n');
      }catch{failure=new EnhancerError('PE子プロセスを開始できません。','PE_PROCESS_ERROR');childExited=!started;if(started)stop(failure);else finish();}
    });
  }
  async enhance(spec,{signal}={}){
    if(this.busy)throw new EnhancerError('PEの実行または終了確認が残っています。','PE_BUSY');
    let safeToRelease=true,childAttempted=false;
    const began=Date.now();
    try{
      signal?.throwIfAborted();
      const normalized=validateEnhancementSpec(spec);this.busy=true;
      const infos=await Promise.all([this.pythonExecutable,this.scriptPath,this.modelPath].map(path=>this.fileInfo(path)));
      if(infos.some(info=>!info.isFile()))throw new TypeError('PE runtime, script, and model must be existing files');
      signal?.throwIfAborted();
      const sourcePromptSha256=sha256(normalized.prompt);
      childAttempted=true;
      const child=await this.runChild({schemaVersion:1,modelPath:this.modelPath,...normalized},signal);
      safeToRelease=child.childExited;
      const record={model:basename(this.modelPath),modelPath:this.modelPath,modelSizeBytes:infos[2].size??null,modelMtimeMs:infos[2].mtimeMs??null,originalPrompt:normalized.prompt,negativePrompt:normalized.negativePrompt,invariants:normalized.invariants,sourcePromptSha256,semanticValidation:'not_performed',childPid:child.childPid,childExited:child.childExited,exitCode:child.exitCode,exitSignal:child.exitSignal,stderrBytes:child.stderrBytes,stderrSha256:child.stderrSha256,elapsedMs:Date.now()-began,cleanupConfirmed:false};
      if(!child.childExited){const error=child.failure??new EnhancerError('PE終了が不明です。','PE_EXIT_UNKNOWN');error.record=record;throw error;}
      let resources;
      try{resources=await this.cleanup();record.cleanupConfirmed=true;record.resourceAfter=resources;}
      catch(error){error.record=record;throw error;}
      let failure=child.failure;
      if(signal?.aborted)failure??=new EnhancerError('プロンプト補助を停止しました。','PE_CANCELLED');
      if(child.exitCode!==0){
        let rejected=false;try{const reported=JSON.parse(child.stdout);rejected=reported?.error?.code==='PE_OUTPUT_REJECTED';if(rejected)record.finishReason=['stop','length','abort'].includes(reported.finishReason)?reported.finishReason:null;}catch{}
        failure??=rejected?new EnhancerError('PE出力が未完了または思考文を含むため、生成へ渡しません。中核で原文の使用か再試行を選択してください。','PE_OUTPUT_REJECTED'):new EnhancerError('PE子プロセスが正常完了しませんでした。','PE_PROCESS_ERROR');
      }
      if(failure){failure.cleanupConfirmed=true;failure.record=record;throw failure;}
      let result;
      try{result=JSON.parse(child.stdout);}catch{const error=new EnhancerError('PE出力をJSONとして確認できません。','PE_INVALID_OUTPUT');error.cleanupConfirmed=true;error.record=record;throw error;}
      if(typeof result.prompt!=='string'||!result.prompt.trim()||result.prompt.length>4000||result.sourcePromptSha256!==sourcePromptSha256||result.model!==basename(this.modelPath)||result.error){const error=new EnhancerError('PE出力の内容または元依頼の識別情報が不正です。','PE_INVALID_OUTPUT');error.cleanupConfirmed=true;error.record=record;throw error;}
      const raw=result.prompt.trim();
      if(result.finishReason!=='stop'||result.thinkingDisabled!==true||/<\/?think\b|<\|(?:im_start|im_end|channel|message)\b|<tool_call\b/i.test(raw)||/(?:^|\n)\s*(?:analysis|reasoning|思考|分析)\s*:|^\s*I (?:first\b|need to\b|will\b|should\b|must\b|think\b)/i.test(raw)){
        const error=new EnhancerError('PE出力の完了・思考無効化を確認できないため、生成へ渡しません。中核で原文の使用か再試行を選択してください。','PE_INVALID_OUTPUT');error.cleanupConfirmed=true;error.record=record;throw error;
      }
      const suffix=normalized.invariants.length?'\n\nFixed visual requirements (must remain unchanged):\n'+normalized.invariants.map(item=>'- '+item.requirement).join('\n'):'';
      const prompt=raw+suffix;
      if(prompt.length>6000){const error=new EnhancerError('固定条件を含むPE出力が長すぎます。','PE_INVALID_OUTPUT');error.cleanupConfirmed=true;error.record=record;throw error;}
      Object.assign(record,{enhancedPrompt:raw,outputPromptSha256:sha256(prompt),fixedRequirementsAppended:normalized.invariants.length>0,templateSha256:typeof result.templateSha256==='string'?result.templateSha256:null,finishReason:result.finishReason,thinkingDisabled:true,settings:{n_gpu_layers:-1,n_ctx:4096,max_tokens:768,enable_thinking:false},elapsedMs:Date.now()-began});
      return {prompt,negativePrompt:normalized.negativePrompt,record};
    }catch(error){
      // No child was attempted: the caller still observes free resources before
      // ending the enhancer lease, but does not have an unknown child to reconcile.
      if(!childAttempted&&error instanceof Error)error.childStarted=false;
      throw error;
    }finally{if(safeToRelease)this.busy=false;}
  }
}
