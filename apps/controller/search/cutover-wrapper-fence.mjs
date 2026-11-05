// Verify the *current parent* maintenance wrapper and the cooperative Windows
// launch lock it is required to own. This does not prove non-cooperating
// writers absent. The wrapper must acquire FileShare.None before spawning Node.
import {spawnSync} from 'node:child_process';
import {isAbsolute,win32} from 'node:path';

export function createWrapperFenceVerifier({lockPath,scriptPath,env=process.env,handleVariable='MEDIA_STUDIO_LEGACY_PARENT_HANDLE',otherLockPath=null,otherHandleVariable=null}={}){
 if(!['MEDIA_STUDIO_LEGACY_PARENT_HANDLE','MEDIA_STUDIO_DSH_PARENT_HANDLE'].includes(handleVariable))throw Error('Unexpected maintenance lock handle');
 const parent=Number(env.MEDIA_STUDIO_LEGACY_PARENT_PID),ticks=env.MEDIA_STUDIO_LEGACY_PARENT_TICKS,exe=env.MEDIA_STUDIO_LEGACY_PARENT_EXE,script=env.MEDIA_STUDIO_LEGACY_PARENT_SCRIPT,handle=env[handleVariable],otherHandle=otherHandleVariable===null?null:env[otherHandleVariable];
 if(process.platform!=='win32'||!isAbsolute(lockPath??'')||!isAbsolute(scriptPath??'')||!Number.isSafeInteger(parent)||parent<1||parent!==process.ppid||typeof ticks!=='string'||!/^[1-9][0-9]{16,18}$/.test(ticks)||typeof handle!=='string'||!/^[1-9][0-9]{0,19}$/.test(handle)||typeof exe!=='string'||!isAbsolute(exe)||typeof script!=='string'||!isAbsolute(script)||win32.normalize(script).toLowerCase()!==win32.normalize(scriptPath).toLowerCase())throw Error('Maintenance wrapper identity unavailable');
 if(otherLockPath!==null&&(otherHandleVariable!=='MEDIA_STUDIO_DSH_PARENT_HANDLE'||handleVariable!=='MEDIA_STUDIO_LEGACY_PARENT_HANDLE'||!isAbsolute(otherLockPath)||win32.normalize(otherLockPath).toLowerCase()===win32.normalize(lockPath).toLowerCase()||typeof otherHandle!=='string'||!/^[1-9][0-9]{0,19}$/.test(otherHandle)||otherHandle===handle))throw Error('Maintenance wrapper identity unavailable');
 if(otherLockPath===null&&otherHandleVariable!==null)throw Error('Maintenance wrapper identity unavailable');
 return ()=>{
  try{process.kill(parent,0);}catch{return false;}
  const command=`$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class FenceHandleProof {
 [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool DuplicateHandle(IntPtr src,IntPtr handle,IntPtr dst,out IntPtr copy,uint access,bool inherit,uint options);
 [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern uint GetFinalPathNameByHandle(IntPtr h,StringBuilder name,uint len,uint flags);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
}
'@
$p=Get-Process -Id ([int]$env:MS_PARENT_PID) -ErrorAction Stop
$c=Get-CimInstance Win32_Process -Filter ('ProcessId='+$env:MS_PARENT_PID) -ErrorAction Stop
if(-not $p.Path -or $p.Path -ine $env:MS_PARENT_EXE -or $p.StartTime.ToUniversalTime().Ticks.ToString() -cne $env:MS_PARENT_TICKS -or -not $c -or -not $c.CommandLine.Contains($env:MS_PARENT_SCRIPT)){exit 2}
$source=[FenceHandleProof]::OpenProcess(0x40,$false,$p.Id);if($source -eq [IntPtr]::Zero){exit 2}
try {
 $items=@(@{Path=$env:MS_LOCK_PATH;Handle=$env:MS_PARENT_HANDLE});if($env:MS_OTHER_LOCK_PATH){$items+=@{Path=$env:MS_OTHER_LOCK_PATH;Handle=$env:MS_OTHER_PARENT_HANDLE}}
 foreach($item in $items){$copy=[IntPtr]::Zero
 try {
 if(-not [FenceHandleProof]::DuplicateHandle($source,[IntPtr]([long]$item.Handle),[FenceHandleProof]::GetCurrentProcess(),[ref]$copy,0,$false,2)){exit 2}
 $name=[Text.StringBuilder]::new(32768);$length=[FenceHandleProof]::GetFinalPathNameByHandle($copy,$name,[uint32]$name.Capacity,0);if($length -eq 0 -or $length -ge $name.Capacity){exit 2}
 $actual=$name.ToString();if($actual.StartsWith('\\\\?\\')){$actual=$actual.Substring(4)}
 if(-not [String]::Equals([IO.Path]::GetFullPath($actual),[IO.Path]::GetFullPath($item.Path),[StringComparison]::OrdinalIgnoreCase)){exit 2}
 $again=Get-Process -Id ([int]$env:MS_PARENT_PID) -ErrorAction Stop;if($again.StartTime.ToUniversalTime().Ticks.ToString() -cne $env:MS_PARENT_TICKS){exit 2}
 foreach($access in @([IO.FileAccess]::Read,[IO.FileAccess]::Write)){try{$f=[IO.File]::Open($item.Path,[IO.FileMode]::Open,$access,[IO.FileShare]::ReadWrite);$f.Dispose();exit 1}catch [IO.IOException]{if($_.Exception.HResult -ne -2147024864){exit 2}}}
 } finally {if($copy -ne [IntPtr]::Zero){[void][FenceHandleProof]::CloseHandle($copy)}}}
 exit 0
} finally {[void][FenceHandleProof]::CloseHandle($source)}`;
  const result=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{env:{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,PATH:process.env.PATH,MS_LOCK_PATH:lockPath,MS_PARENT_PID:String(parent),MS_PARENT_TICKS:ticks,MS_PARENT_EXE:exe,MS_PARENT_SCRIPT:script,MS_PARENT_HANDLE:handle,MS_OTHER_LOCK_PATH:otherLockPath??'',MS_OTHER_PARENT_HANDLE:otherHandle??''},windowsHide:true,timeout:8000,stdio:'ignore'});return result.status===0&&!result.error;
 };
}

export function createCombinedWrapperFenceVerifier({controllerLockPath,dshLockPath,scriptPath,env=process.env}={}){
 return createWrapperFenceVerifier({lockPath:controllerLockPath,otherLockPath:dshLockPath,otherHandleVariable:'MEDIA_STUDIO_DSH_PARENT_HANDLE',scriptPath,env});
}
