import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { win32 } from 'node:path';
import { digest } from './store.mjs';

const executeFile=promisify(execFile);
const fail=message=>{throw new Error('ComfyUI再起動後の復旧を確認できません。 '+message);};
const pid=value=>Number.isSafeInteger(value)&&value>0&&value<=0xffffffff;
const ticks=value=>typeof value==='string'&&/^[1-9][0-9]{16,18}$/.test(value)&&BigInt(value)<=3155378975999999999n;
const executable=value=>{
  if(typeof value!=='string'||!win32.isAbsolute(value)||/[\u0000-\u001f]/.test(value))fail('実行ファイルの絶対パスがありません。');
  return win32.normalize(value).toLowerCase();
};
function identities(epoch) {
  if(!epoch||!pid(epoch.pid)||!pid(epoch.listenerPid)||!ticks(epoch.startTimeUtcTicks)||!ticks(epoch.listenerStartTimeUtcTicks)||!/^[a-f0-9]{64}$/.test(epoch.recordSha256??''))fail('保存済み実行世代の証拠が不足しています。');
  executable(epoch.executable);executable(epoch.listenerExecutable);
  let url;try{url=new URL(epoch.url);}catch{fail('実行世代のURLが不正です。');}
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.search||url.hash||url.pathname!=='/')fail('実行世代のURLが不正です。');
  if(BigInt(epoch.listenerStartTimeUtcTicks)<BigInt(epoch.startTimeUtcTicks))fail('保存済み子プロセスの開始時刻が不正です。');
  const result=[{pid:epoch.pid,startTimeUtcTicks:epoch.startTimeUtcTicks,executable:executable(epoch.executable)}];
  if(epoch.listenerPid===epoch.pid) {
    if(epoch.listenerStartTimeUtcTicks!==epoch.startTimeUtcTicks||executable(epoch.listenerExecutable)!==result[0].executable)fail('同一PIDの証拠が矛盾しています。');
  } else result.push({pid:epoch.listenerPid,startTimeUtcTicks:epoch.listenerStartTimeUtcTicks,executable:executable(epoch.listenerExecutable)});
  return result;
}

// Read-only OS observations. Only validated numeric PIDs enter the fixed script.
// CIM errors or inaccessible process identity are never treated as process exit.
export async function probeRetiredWindowsProcesses(pids) {
  if(process.platform!=='win32'||!Array.isArray(pids)||pids.length<1||pids.length>2||pids.some(value=>!pid(value)))fail('Windowsプロセス照合引数が不正です。');
  const script=`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$rows = foreach ($targetPid in @(${pids.join(',')})) {
  $process = $null
  try { $process = Get-Process -Id $targetPid -ErrorAction Stop }
  catch { if ($_.FullyQualifiedErrorId -notlike 'NoProcessFoundForGivenId*') { throw } }
  $observed = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $targetPid) -ErrorAction Stop
  if (($null -eq $process) -ne ($null -eq $observed)) { throw 'Process observations disagree; exit unproven' }
  if ($null -eq $process -and $null -eq $observed) { [ordered]@{pid=$targetPid;exists=$false} }
  else {
    if (-not $process.Path) { throw 'Process identity inaccessible' }
    [ordered]@{pid=$targetPid;exists=$true;startTimeUtcTicks=$process.StartTime.ToUniversalTime().Ticks.ToString();executable=$process.Path}
  }
}
[ordered]@{observedAt=[DateTime]::UtcNow.ToString('o');processes=@($rows)} | ConvertTo-Json -Compress -Depth 4
`;
  const powershell=win32.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  let result;
  try{result=await executeFile(powershell,['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:8000,maxBuffer:65536,encoding:'utf8'});}
  catch{fail('旧親子プロセスの終了をWindowsで確認できません。');}
  try{return JSON.parse(result.stdout.trim().replace(/^\uFEFF/,''));}catch{fail('プロセス照合結果が不正です。');}
}

export function createRetiredEpochVerifier({expectedExecutable,baseUrl,probe=probeRetiredWindowsProcesses}) {
  const expected=executable(expectedExecutable),expectedUrl=new URL(baseUrl).origin;
  return async(oldEpoch,currentEpoch)=>{
    const old=identities(oldEpoch);identities(currentEpoch);
    if(executable(oldEpoch.executable)!==expected||executable(currentEpoch.executable)!==expected||oldEpoch.url!==expectedUrl||currentEpoch.url!==expectedUrl)fail('旧・新世代と管理設定が一致しません。');
    if(digest(oldEpoch)===digest(currentEpoch))fail('ComfyUIは元の実行世代です。通常の再照合を使用してください。');
    const observations=[];
    for(let pass=0;pass<2;pass++) {
      const observed=await probe(old.map(item=>item.pid));
      if(!observed||!Array.isArray(observed.processes)||observed.processes.length!==old.length||typeof observed.observedAt!=='string'||!Number.isFinite(Date.parse(observed.observedAt)))fail('旧プロセスの終了観測が不足しています。');
      const processes=old.map(saved=>{
        const matches=observed.processes.filter(item=>item.pid===saved.pid);
        if(matches.length!==1||typeof matches[0].exists!=='boolean')fail('旧プロセスの観測が不正です。');
        const live=matches[0];
        if(!live.exists)return {...saved,absent:true};
        if(!ticks(live.startTimeUtcTicks))fail('再利用PIDの開始時刻が不明です。');
        const actualExecutable=executable(live.executable);
        if(BigInt(live.startTimeUtcTicks)<=BigInt(saved.startTimeUtcTicks))fail('旧親または旧子プロセスがまだ存在するか、開始時刻が矛盾しています。');
        return {...saved,absent:false,reused:true,observedStartTimeUtcTicks:live.startTimeUtcTicks,observedExecutable:actualExecutable};
      });
      observations.push({observedAt:observed.observedAt,processes});
    }
    return {confirmed:true,oldEpoch,currentEpoch,observations};
  };
}

export async function recoverCancelledServer(engine,id) {
  const run=engine.store.get(id),attempt={startedAt:new Date().toISOString(),oldEpoch:run.serverEpoch};
  engine.store.update(id,{phase:'recovery_required',release:null,serverRecovery:attempt},'server_recovery_started');
  try {
    const currentEpoch=await engine.verifyEpoch();
    const retirement=await engine.verifyRetiredEpoch(run.serverEpoch,currentEpoch);
    if(retirement?.confirmed!==true||digest(retirement.oldEpoch)!==digest(run.serverEpoch)||digest(retirement.currentEpoch)!==digest(currentEpoch))fail('旧世代の終了証拠がありません。');
    const assertCurrent=async()=>{
      if(digest(await engine.verifyEpoch())!==digest(currentEpoch))fail('復旧の途中でComfyUIの実行世代が変わりました。');
    };
    const assertIdle=async()=>{
      await assertCurrent();
      // Recovery never executes or revalidates the failed draft. A newly added
      // draft guard must not prevent cleanup of the draft that exposed it.
      const preflight=await engine.adapter.preflight({modelProfile:run.spec.modelProfile});
      if(preflight.queueEmpty!==true||preflight.ready!==true)fail('新ComfyUIの空キューと構成を確認できません。');
      const snapshot=await engine.adapter.inspect(run.promptId);
      if(snapshot.running||snapshot.queued||snapshot.history)fail('新ComfyUIに旧prompt_idの記録があります。');
      await assertCurrent();
      return preflight;
    };
    await assertIdle();
    Object.assign(attempt,{retirement,currentEpoch,verifiedAt:new Date().toISOString()});
    engine.store.update(id,{serverRecovery:attempt},'server_retirement_verified');
    const coreBefore=await engine.gate.state();
    if(coreBefore.activity.in_flight!==0)fail('中核に実行中の推論があります。');
    let release;
    if(coreBefore.loaded) {
      // The core can already be loaded if the controller crashed after restoring
      // it, before committing the terminal run. Requiring generator-era free VRAM
      // again would deadlock that recovery. Reuse only a durable release for this
      // exact server generation, plus fresh empty-queue/low-reservation evidence.
      const saved=run.serverRecoveryRelease;
      if(saved?.release?.released!==true||!saved.currentEpoch||saved.oldEpochDigest!==digest(run.serverEpoch)||digest(saved.currentEpoch)!==digest(currentEpoch))fail('中核ロード前に保存した同一ComfyUI世代の解放証拠がありません。');
      const observations=[];
      for(let i=0;i<3;i++) {
        const memory=(await assertIdle()).details?.memory;
        if(!memory||!Number.isFinite(memory.torchReservedBytes)||memory.torchReservedBytes<0||memory.torchReservedBytes>=512*1024**2)fail('再開時のComfyUI予約メモリ解放を確認できません。');
        observations.push(memory);
      }
      release={...saved.release,resumedWithCoreLoaded:true,resumeMemoryObservations:observations};
    } else release=await engine.adapter.release({assertEpoch:assertCurrent});
    if(release?.released!==true)fail('新ComfyUIの資源解放を確認できません。');
    await assertIdle();
    Object.assign(attempt,{release,releasedAt:new Date().toISOString()});
    const serverRecoveryRelease={oldEpochDigest:digest(run.serverEpoch),currentEpoch,release,at:new Date().toISOString()};
    engine.store.update(id,{release,serverRecovery:attempt,serverRecoveryRelease,phase:'restoring_core'},'server_recovery_released');
    const core=await engine.gate.returnToCore(id,{signalcleanup:AbortSignal.timeout(300000),assertGeneratorIdle:assertIdle,resumeRecovery:true});
    engine.store.update(id,{coreRestored:core,serverRecovery:{...attempt,completedAt:new Date().toISOString()}},'server_recovery_core_restored');
    return await engine.finish(id,'cancelled');
  } catch(error) {
    await engine.gate.block(error);
    engine.store.update(id,{serverRecovery:{...attempt,failedAt:new Date().toISOString(),error:String(error?.message??error).slice(0,1200)}},'server_recovery_failed');
    return engine.finish(id,'recovery_required',String(error?.message??error).slice(0,1200));
  }
}
