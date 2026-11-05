// Read-only monitor. Device totals, per-process allocations and the cooperative
// lease are distinct observations; missing driver data is never interpreted as 0.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {freemem,totalmem} from 'node:os';
import {win32} from 'node:path';
import {fileURLToPath} from 'node:url';

const execute=promisify(execFile);
const validPid=n=>Number.isSafeInteger(n)&&n>0&&n<=0xffffffff;
const number=n=>Number.isSafeInteger(n)&&n>=0?n:null;
const identity=e=>e&&validPid(e.pid)&&validPid(e.listenerPid)&&typeof e.startTimeUtcTicks==='string'&&typeof e.listenerStartTimeUtcTicks==='string';
const ids=e=>[...new Set([e.pid,e.listenerPid])];
const equalEpoch=(a,b)=>identity(a)&&identity(b)&&a.pid===b.pid&&a.listenerPid===b.listenerPid&&a.startTimeUtcTicks===b.startTimeUtcTicks&&a.listenerStartTimeUtcTicks===b.listenerStartTimeUtcTicks&&a.recordSha256===b.recordSha256&&a.instanceId===b.instanceId;
const validTicks=value=>typeof value==='string'&&/^[1-9][0-9]{16,18}$/.test(value)&&BigInt(value)<=3155378975999999999n;
function childSnapshot(epoch,children){
  if(!Array.isArray(children))throw new Error('Native child observation unavailable');
  const seen=new Set(ids(epoch));
  return children.map(child=>{
    if(!validPid(child?.pid)||seen.has(child.pid)||child.parentPid!==epoch.pid||!validTicks(child.startTimeUtcTicks)||!validTicks(epoch.startTimeUtcTicks)||BigInt(child.startTimeUtcTicks)<BigInt(epoch.startTimeUtcTicks)||typeof child.executable!=='string'||!win32.isAbsolute(child.executable))throw new Error('Native child identity unavailable');
    seen.add(child.pid);return {pid:child.pid,parentPid:child.parentPid,startTimeUtcTicks:child.startTimeUtcTicks,executable:win32.normalize(child.executable).toLowerCase()};
  }).sort((a,b)=>a.pid-b.pid);
}

// A single NVIDIA DXGI adapter and single nvidia-smi GPU are required. Do not
// guess between multiple devices, software adapters or incompatible capacities.
export function systemAdapterKey(system,adapters){
  if(number(system?.totalBytes)===null||system.totalBytes===0||!Array.isArray(adapters))return null;
  const candidates=adapters.filter(a=>a?.vendorId===0x10de&&a.software===false);
  if(candidates.length!==1)return null;
  const a=candidates[0];
  return /^[a-f0-9]{8}:[a-f0-9]{8}:0$/.test(a.adapterKey??'')&&number(a.dedicatedBytes)!==null&&Math.abs(a.dedicatedBytes-system.totalBytes)<=Math.min(system.totalBytes*.05,512*1048576)?a.adapterKey:null;
}
let adapterCache=null;
async function gpuAdapters(){
  if(process.platform!=='win32')return [];
  if(adapterCache&&Date.now()-adapterCache.at<300000)return adapterCache.rows;
  const script=fileURLToPath(new URL('../../scripts/Get-GpuAdapters.ps1',import.meta.url));
  const result=await execute('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',script],{windowsHide:true,timeout:6000,maxBuffer:65536,encoding:'utf8'});
  const value=JSON.parse(result.stdout.trim().replace(/^\uFEFF/,''));
  const rows=Array.isArray(value)?value:[value];adapterCache={at:Date.now(),rows};return rows;
}

export function parseGpuMemory(totalText,processText){
  const lines=String(totalText??'').trim().split(/\r?\n/).filter(Boolean);
  const m=lines.length===1?lines[0].match(/^\s*(\d+)\s*,\s*(\d+)\s*$/):null;
  let system=null;
  if(m){const total=Number(m[1])*1048576,free=Number(m[2])*1048576;if(number(total)!==null&&number(free)!==null&&free<=total)system={totalBytes:total,freeBytes:free,usedBytes:total-free};}
  const processes=new Map();
  for(const line of String(processText??'').split(/\r?\n/)){
    const row=line.match(/^\s*(\d+)\s*,\s*(\d+|N\/A|\[Not Supported\])\s*$/i);
    if(!row)continue;
    const pid=Number(row[1]);if(!validPid(pid))continue;
    const value=/^\d+$/.test(row[2])?Number(row[2])*1048576:null;
    // Multiple contexts on the same PID cannot be assumed to be additive.
    if(processes.has(pid))processes.set(pid,null);else processes.set(pid,number(value));
  }
  return {system,processes};
}

// Windows exposes one process-memory instance per PID / adapter. A repeated
// identical instance is deduplicated; conflicting duplicates or multiple
// adapter identities cannot safely be mapped to the selected NVIDIA device.
export function parseWindowsGpuMemory(rows){
  if(!Array.isArray(rows))return new Map();
  const found=new Map();
  for(const row of rows){
    if(!row||typeof row.Name!=='string')return new Map();
    const prefix=/^pid_(\d+)_/i.exec(row.Name);
    if(!prefix)return new Map();
    const pid=Number(prefix[1]);if(!validPid(pid))return new Map();
    const match=/^pid_\d+_luid_0x([0-9a-f]{8})_0x([0-9a-f]{8})_phys_(\d+)$/i.exec(row.Name);
    let item=found.get(pid);if(!item){item={invalid:false,adapters:new Map()};found.set(pid,item);}
    const raw=row.DedicatedUsage;
    const value=typeof raw==='string'&&/^\d+$/.test(raw)?Number(raw):raw;
    if(!match||number(value)===null){item.invalid=true;continue;}
    const adapter=`${match[1].toLowerCase()}:${match[2].toLowerCase()}:${match[3]}`;
    if(item.adapters.has(adapter)&&item.adapters.get(adapter)!==value)item.invalid=true;
    else item.adapters.set(adapter,value);
  }
  return new Map([...found].map(([pid,item])=>{
    if(item.invalid||item.adapters.size!==1)return [pid,null];
    const [adapter,usedBytes]=[...item.adapters.entries()][0];return [pid,{adapter,usedBytes}];
  }));
}

async function gpuSample(){
  const options={windowsHide:true,timeout:6000,maxBuffer:65536,encoding:'utf8'};
  let totals='',processes='';
  try{totals=(await execute('nvidia-smi.exe',['--query-gpu=memory.total,memory.free','--format=csv,noheader,nounits'],options)).stdout;}catch{}
  try{processes=(await execute('nvidia-smi.exe',['--query-compute-apps=pid,used_gpu_memory','--format=csv,noheader,nounits'],options)).stdout;}catch{}
  return parseGpuMemory(totals,processes);
}

async function windowsGpuProcesses(){
  if(process.platform!=='win32')return new Map();
  const command="$ErrorActionPreference='Stop'; @(Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory -ErrorAction Stop | ForEach-Object { [ordered]@{Name=$_.Name;DedicatedUsage=$_.DedicatedUsage.ToString()} }) | ConvertTo-Json -Compress";
  const ps=win32.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const result=await execute(ps,['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:6000,maxBuffer:1048576,encoding:'utf8'});
  const parsed=JSON.parse(result.stdout.trim().replace(/^\uFEFF/,''));
  return parseWindowsGpuMemory(Array.isArray(parsed)?parsed:[parsed]);
}

async function workingSets(pids){
  if(!pids.length||pids.some(pid=>!validPid(pid)))throw new Error('Invalid process IDs');
  const command=`$ErrorActionPreference='Stop'; $ids=@(${pids.join(',')}); $privateSets=@{}; try { Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter ($ids.ForEach({ 'IDProcess='+$_ }) -join ' OR ') -ErrorAction Stop | ForEach-Object { if($null -eq $_.WorkingSetPrivate -or $privateSets.ContainsKey([int]$_.IDProcess)) { $privateSets[[int]$_.IDProcess]=$null } else { $privateSets[[int]$_.IDProcess]=[long]$_.WorkingSetPrivate } } } catch {}; @($ids | ForEach-Object { $p=Get-Process -Id $_ -ErrorAction Stop; [ordered]@{pid=$p.Id;workingSetBytes=[long]$p.WorkingSet64;privateBytes=[long]$p.PrivateMemorySize64;residentPrivateBytes=$privateSets[$p.Id];startTimeUtcTicks=$p.StartTime.ToUniversalTime().Ticks.ToString()} }) | ConvertTo-Json -Compress`;
  const ps=win32.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const result=await execute(ps,['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:6000,maxBuffer:65536,encoding:'utf8'});
  const parsed=JSON.parse(result.stdout.trim()),rows=Array.isArray(parsed)?parsed:[parsed];
  if(rows.length!==pids.length||rows.some(row=>!pids.includes(row.pid)||number(row.workingSetBytes)===null||number(row.privateBytes)===null||typeof row.startTimeUtcTicks!=='string'))throw new Error('Process memory observation unavailable');
  return rows;
}

function serviceResult(epoch,after,rows,gpu,windowsGpu,children=null){
  if(!equalEpoch(epoch,after))return {status:'unavailable',ram:null,vram:null};
  const pids=[...ids(epoch),...(children??[]).map(child=>child.pid)],byPid=new Map(rows.map(row=>[row.pid,row])),childTicks=new Map((children??[]).map(child=>[child.pid,child.startTimeUtcTicks]));
  if(rows.length!==pids.length||byPid.size!==pids.length)return {status:'unavailable',ram:null,vram:null};
  for(const pid of pids){const p=byPid.get(pid),ticks=childTicks.get(pid)??(pid===epoch.pid?epoch.startTimeUtcTicks:epoch.listenerStartTimeUtcTicks);if(!p||p.startTimeUtcTicks!==ticks||number(p.workingSetBytes)===null||number(p.privateBytes)===null)return {status:'unavailable',ram:null,vram:null};}
  const scope=children===null?'verified-managed-and-listener-processes':'verified-managed-listener-and-owned-native-children';
  const ram={workingSetBytes:pids.reduce((sum,pid)=>sum+byPid.get(pid).workingSetBytes,0),privateBytes:pids.reduce((sum,pid)=>sum+byPid.get(pid).privateBytes,0),scope};
  if(number(ram.workingSetBytes)===null||number(ram.privateBytes)===null)return {status:'unavailable',ram:null,vram:null};
  if(pids.every(pid=>number(byPid.get(pid).residentPrivateBytes)!==null)){
    const resident=pids.reduce((sum,pid)=>sum+byPid.get(pid).residentPrivateBytes,0);if(number(resident)!==null)ram.residentPrivateBytes=resident;
  }
  const nvidia=pids.map(pid=>gpu.processes.get(pid));
  const observedPids=pids.filter(pid=>windowsGpu.has(pid)),windows=observedPids.map(pid=>windowsGpu.get(pid));
  // A PID absent from Windows counters is unknown, not zero. Existing but
  // invalid/ambiguous entries invalidate the entire lower-bound observation.
  const validWindows=windows.length>0&&windows.every(value=>value&&number(value.usedBytes)!==null&&typeof value.adapter==='string')&&new Set(windows.map(value=>value.adapter)).size===1;
  const completeNvidia=nvidia.every(value=>number(value)!==null);
  const source=completeNvidia?'nvidia-smi':validWindows?'windows-gpu-process-memory':null;
  const complete=completeNvidia||observedPids.length===pids.length;
  const allocations=completeNvidia?nvidia:windows.map(value=>value?.usedBytes);
  const sum=allocations.reduce((a,b)=>a+(number(b)??0),0);
  const vram=source&&number(sum)!==null?{usedBytes:sum,scope:complete?scope:'observed-'+scope,source,complete,observedPids:completeNvidia?pids:observedPids,expectedPids:pids}:null;
  if(vram){vram.adapterKey=completeNvidia?gpu.system?.adapterKey??null:windows[0].adapter;vram.comparableToSystem=Boolean(gpu.system)&&(completeNvidia||Boolean(gpu.system.adapterKey)&&vram.adapterKey===gpu.system.adapterKey);}
  return {status:'observed',ram,vram};
}

export function createResourceObserver({verifyComfy,verifyStrata,readStrataChildren=null,readGpu=gpuSample,readWindowsGpu=windowsGpuProcesses,readAdapters=gpuAdapters,readProcesses=workingSets,systemMemory=()=>({totalBytes:totalmem(),freeBytes:freemem()}),clock=()=>new Date(),ttlMs=12000}={}){
  if(typeof verifyComfy!=='function'||readStrataChildren!==null&&typeof readStrataChildren!=='function'||typeof readGpu!=='function'||typeof readWindowsGpu!=='function'||typeof readProcesses!=='function'||!Number.isSafeInteger(ttlMs)||ttlMs<1000)throw new TypeError('Invalid telemetry dependencies');
  let cache=null,inflight=null;
  async function sample(){
    const checks={comfyui:verifyComfy,strata:verifyStrata},epochs={};
    await Promise.all(Object.entries(checks).map(async([name,verify])=>{try{epochs[name]=typeof verify==='function'?await verify():null;}catch{epochs[name]=null;}}));
    let strataChildren=null;
    if(identity(epochs.strata)&&readStrataChildren){try{strataChildren=childSnapshot(epochs.strata,await readStrataChildren(epochs.strata));}catch{epochs.strata=null;}}
    let gpu;try{gpu=await readGpu();if(!gpu||!(gpu.processes instanceof Map))throw Error();}catch{gpu={system:null,processes:new Map()};}
    if(gpu.system){let key=null;try{key=systemAdapterKey(gpu.system,await readAdapters());}catch{}gpu={...gpu,system:{...gpu.system,adapterKey:key}};}
    let windowsGpu=new Map();
    if(Object.entries(epochs).some(([name,epoch])=>identity(epoch)&&[...ids(epoch),...(name==='strata'?strataChildren??[]:[]).map(child=>child.pid)].some(pid=>number(gpu.processes.get(pid))===null))){
      try{const result=await readWindowsGpu();if(result instanceof Map)windowsGpu=result;}catch{}
    }
    const services={};
    await Promise.all(Object.entries(checks).map(async([name,verify])=>{
      const first=epochs[name];if(!identity(first)||typeof verify!=='function'){services[name]={status:'unavailable',ram:null,vram:null};return;}
      try{
        const children=name==='strata'?strataChildren:null,pids=[...ids(first),...(children??[]).map(child=>child.pid)],rows=await readProcesses(pids);
        if(children!==null&&JSON.stringify(children)!==JSON.stringify(childSnapshot(first,await readStrataChildren(first))))throw new Error('Native children changed during observation');
        const last=await verify();services[name]=serviceResult(first,last,rows,gpu,windowsGpu,children);
      }catch{services[name]={status:'unavailable',ram:null,vram:null};}
    }));
    let ram=null;try{const x=systemMemory();if(number(x?.totalBytes)!==null&&number(x?.freeBytes)!==null&&x.freeBytes<=x.totalBytes)ram={...x,usedBytes:x.totalBytes-x.freeBytes};}catch{}
    return {observedAt:clock().toISOString(),system:{ram,vram:gpu.system??null},services,
      notes:['RAMは専用常駐メモリを優先し、未取得時はワーキングセットです。管理・待受プロセスとStrataの配置・親PID・開始時刻を照合したnative engineのみを含み、全子プロセスの総量ではありません。','VRAMはnvidia-smiまたはWindows専用GPUメモリのPID別観測です。共有GPUメモリは加算せず、未取得は0ではありません。']};
  }
  return async()=>{
    const now=clock().getTime();if(cache&&now-cache.at<ttlMs)return {...structuredClone(cache.value),cached:true};
    if(!inflight)inflight=sample().then(value=>{cache={at:clock().getTime(),value};return value;}).finally(()=>{inflight=null;});
    return {...structuredClone(await inflight),cached:false};
  };
}
