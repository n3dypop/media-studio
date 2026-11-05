// Read-only attribution of Strata's two native engines. This deliberately does
// not walk an arbitrary process tree or claim every child of the API server.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {win32} from 'node:path';

const execute=promisify(execFile);
const validPid=value=>Number.isSafeInteger(value)&&value>0&&value<=0xffffffff;
const validTicks=value=>typeof value==='string'&&/^[1-9][0-9]{16,18}$/.test(value)&&BigInt(value)<=3155378975999999999n;
const fail=()=>{throw new Error('Strata native process ownership could not be verified');};
const path=value=>{
  if(typeof value!=='string'||!win32.isAbsolute(value)||/[\u0000-\u001f]/.test(value))fail();
  return win32.normalize(value).toLowerCase();
};
const inside=(directory,target)=>target.startsWith(directory.endsWith('\\')?directory:directory+'\\');

export function strataEngineIdentity(receipt,root,expectedExecutable){
  if(receipt?.schemaVersion!==1||path(receipt.workspace)!==path(root))fail();
  const executable=path(expectedExecutable),control=path(receipt.control),engine=path(receipt.engine),product=path(receipt.productRoot);
  if(path(win32.join(control,'python','python.exe'))!==executable||!inside(path(win32.join(product,'.runtime','terminal')),control)||!inside(path(win32.join(product,'.runtime','components','engine')),engine))fail();
  return {executable,engine,allowed:[path(win32.join(engine,'strata.exe')),path(win32.join(engine,'strata-vision.exe'))]};
}

export function validateStrataChildren(epoch,evidence,installation){
  if(!validPid(epoch?.pid)||epoch.listenerPid!==epoch.pid||!validTicks(epoch.startTimeUtcTicks)||path(epoch.executable)!==installation.executable)fail();
  const parent=evidence?.parent;
  if(!parent||parent.pid!==epoch.pid||parent.startTimeUtcTicks!==epoch.startTimeUtcTicks||path(parent.executable)!==installation.executable||!Array.isArray(evidence.children))fail();
  const children=[],seen=new Set();
  for(const row of evidence.children){
    // Conhost, updater and other unrelated children are outside our scope.
    if(!['strata.exe','strata-vision.exe'].includes(String(row?.name??'').toLowerCase()))continue;
    const executable=path(row.executable);
    if(!installation.allowed.includes(executable))continue;
    if(!validPid(row.pid)||row.pid===epoch.pid||seen.has(row.pid)||row.parentPid!==epoch.pid||!validTicks(row.startTimeUtcTicks)||BigInt(row.startTimeUtcTicks)<BigInt(epoch.startTimeUtcTicks)||win32.basename(executable)!==row.name.toLowerCase())fail();
    // CIM CreationDate has microsecond precision; Get-Process StartTime retains
    // 100ns ticks. Match the CIM microsecond, then retain the precise value so
    // subsequent Get-Process memory measurements can use exact epoch equality.
    if(path(row.cimExecutable)!==executable||!validTicks(row.cimStartTimeUtcTicks)||BigInt(row.cimStartTimeUtcTicks)/10n!==BigInt(row.startTimeUtcTicks)/10n)fail();
    seen.add(row.pid);children.push({pid:row.pid,parentPid:row.parentPid,executable,startTimeUtcTicks:row.startTimeUtcTicks});
  }
  return children.sort((a,b)=>a.pid-b.pid);
}

export async function probeWindowsStrataChildren({pid}){
  if(process.platform!=='win32'||!validPid(pid))fail();
  // Only a validated numeric PID enters the fixed script. Paths/receipt text
  // remain data, never PowerShell source.
  const command=`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$p=Get-Process -Id ${pid} -ErrorAction Stop
if(-not $p.Path){throw 'Parent path unavailable'}
$ticks=$p.StartTime.ToUniversalTime().Ticks.ToString()
$rows=@(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' -ErrorAction Stop | ForEach-Object {
  $cim=$_
  $cimTicks=if($null -ne $cim.CreationDate){$cim.CreationDate.ToUniversalTime().Ticks.ToString()}else{$null}
  $childPath=$cim.ExecutablePath
  $childTicks=$cimTicks
  if($cim.Name -in @('strata.exe','strata-vision.exe')){
    $native=Get-Process -Id $cim.ProcessId -ErrorAction Stop
    if(-not $native.Path){throw 'Native process path unavailable'}
    $childPath=$native.Path
    $childTicks=$native.StartTime.ToUniversalTime().Ticks.ToString()
    $nativeAgain=Get-Process -Id $native.Id -ErrorAction Stop
    if($nativeAgain.StartTime.ToUniversalTime().Ticks.ToString() -ne $childTicks -or $nativeAgain.Path -ne $childPath){throw 'Native process changed'}
  }
  [ordered]@{pid=[int]$cim.ProcessId;parentPid=[int]$cim.ParentProcessId;name=$cim.Name;executable=$childPath;startTimeUtcTicks=$childTicks;cimExecutable=$cim.ExecutablePath;cimStartTimeUtcTicks=$cimTicks}
})
$again=Get-Process -Id ${pid} -ErrorAction Stop
if($again.StartTime.ToUniversalTime().Ticks.ToString() -ne $ticks -or $again.Path -ne $p.Path){throw 'Parent changed'}
[ordered]@{parent=[ordered]@{pid=$p.Id;executable=$p.Path;startTimeUtcTicks=$ticks};children=$rows} | ConvertTo-Json -Compress -Depth 4
`;
  const powershell=win32.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const result=await execute(powershell,['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:6000,maxBuffer:1048576,encoding:'utf8'});
  return JSON.parse(result.stdout.trim().replace(/^\uFEFF/,''));
}

export function createStrataOwnedChildReader({root,expectedExecutable,read=readFile,probe=probeWindowsStrataChildren}){
  path(root);path(expectedExecutable);
  if(typeof read!=='function'||typeof probe!=='function')throw new TypeError('Invalid Strata child reader dependencies');
  const receiptPath=win32.join(root,'data','strata','installation.json');
  let pinned=null;
  return async epoch=>{
    const before=await read(receiptPath,'utf8'),installation=strataEngineIdentity(JSON.parse(before),root,expectedExecutable);
    const key=JSON.stringify(installation);
    if(pinned!==null&&pinned!==key)fail();
    const children=validateStrataChildren(epoch,await probe({pid:epoch.pid}),installation);
    if(before!==await read(receiptPath,'utf8'))fail();
    pinned=key;return children;
  };
}
