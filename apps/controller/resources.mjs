import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {statfs} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
const execute=promisify(execFile);
export async function observeWindowsResources({signal,readMemory}={}, {executeFile=execute}={}) {
  if(readMemory!==undefined&&typeof readMemory!=='function'||typeof executeFile!=='function')throw new TypeError('Invalid resource observation dependencies');
  signal?.throwIfAborted();
  const options={windowsHide:true,timeout:10000,maxBuffer:65536,encoding:'utf8',signal};
  const powershell=join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const [gpu,ram]=await Promise.all([
    executeFile('nvidia-smi.exe',['--query-gpu=memory.free','--format=csv,noheader,nounits'],options),
    readMemory?readMemory({signal}):executeFile(powershell,['-NoLogo','-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; $ramInfo=Get-CimInstance Win32_OperatingSystem; $commitInfo=Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory; [ordered]@{ramAvailableBytes=([long]$ramInfo.FreePhysicalMemory*1024);commitUsedBytes=[long]$commitInfo.CommittedBytes;commitLimitBytes=[long]$commitInfo.CommitLimit} | ConvertTo-Json -Compress"],options).then(result=>JSON.parse(result.stdout.trim())),
  ]);
  signal?.throwIfAborted();
  const lines=gpu.stdout.trim().split(/\r?\n/);
  if(lines.length!==1||!/^\d+$/.test(lines[0])) throw new Error('GPU/RAM observation unavailable');
  const freeBytes=Number(lines[0])*1024**2,{ramAvailableBytes,commitUsedBytes,commitLimitBytes}=ram??{};
  if([freeBytes,ramAvailableBytes,commitUsedBytes,commitLimitBytes].some(n=>!Number.isSafeInteger(n)||n<0)||commitLimitBytes<commitUsedBytes
    ||ram?.ramTotalBytes!==undefined&&(!Number.isSafeInteger(ram.ramTotalBytes)||ram.ramTotalBytes<ramAvailableBytes)
    ||ram?.commitAvailableBytes!==undefined&&ram.commitAvailableBytes!==commitLimitBytes-commitUsedBytes) throw new Error('Invalid GPU/RAM observation');
  return {freeBytes,ramAvailableBytes,commitUsedBytes,commitLimitBytes,commitAvailableBytes:commitLimitBytes-commitUsedBytes,observedAt:new Date().toISOString()};
}

// A measurement, not a prediction that the generated files will fit.
export async function observeOutputDisks(locations) {
  if(!Array.isArray(locations)||!locations.length)throw new Error('Output disk locations are required');
  const volumes=[];
  for(const location of locations){
    if(!location||typeof location.label!=='string'||!location.label||typeof location.path!=='string'||!isAbsolute(location.path))throw new Error('Invalid output disk location');
    const stats=await statfs(location.path,{bigint:true});
    const bytes=stats.bavail*stats.bsize;
    if(bytes<0n||bytes>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('Output disk availability is outside the supported range');
    volumes.push({label:location.label,path:location.path,availableBytes:Number(bytes)});
  }
  return {observedAt:new Date().toISOString(),volumes,estimatedOutputBytes:null,sufficiency:volumes.some(volume=>volume.availableBytes===0)?'insufficient':'unknown'};
}
