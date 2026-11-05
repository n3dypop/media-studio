# Fixed installation-local verifier. Not connected to a live route while the
# corresponding production wrapper and pipe contract are being finalized.
param([string]$Root,[int]$ExpectedPid,[string]$ExpectedTicks,[string]$ExpectedExe,[switch]$HostExited)
$ErrorActionPreference='Stop'
try {
  $Info=Join-Path $Root 'runtime\maintenance\fence-ready.json'
  $ExpectedScript=Join-Path $PSScriptRoot 'Invoke-WebSearchCutover.ps1'
  $RequireHost=$true
  $ExpectedNonce=if($HostExited){[Console]::In.ReadLine()}else{$null}
  $readyItem=Get-Item -LiteralPath $Info -Force -ErrorAction Stop;if($readyItem.PSIsContainer -or ($readyItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $readyItem.Length -gt 16384){throw 'maintenance identity file differs'}
  $file=[IO.File]::Open($Info,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete));try{$reader=[IO.StreamReader]::new($file,[Text.UTF8Encoding]::new($false,$true));try{$v=$reader.ReadToEnd() | ConvertFrom-Json}finally{$reader.Dispose()}}finally{$file.Dispose()}
  if($ExpectedPid -lt 1 -or $ExpectedTicks -cnotmatch '^[0-9]+$' -or [string]::IsNullOrEmpty($ExpectedExe) -or $v.targetPid -ne $ExpectedPid -or $v.targetTicks -cne $ExpectedTicks -or -not [string]::Equals($v.targetExe,$ExpectedExe,[StringComparison]::OrdinalIgnoreCase)){throw 'target is not the requesting Host'}
  if($v.pid -lt 1 -or $v.ticks -notmatch '^[0-9]+$' -or $v.pipe -notmatch '^media-studio-cutover-[a-f0-9]{32}$' -or $v.hostPipe -notmatch '^media-studio-host-[a-f0-9]{32}$' -or $v.nonceHash -cnotmatch '^[a-f0-9]{64}$' -or $v.dshHandle -notmatch '^[1-9][0-9]*$' -or $v.controllerHandle -notmatch '^[1-9][0-9]*$'){throw 'invalid maintenance identity'}
  if($HostExited){if($ExpectedNonce -cnotmatch '^[a-f0-9]{64}$' -or [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($ExpectedNonce))).ToLowerInvariant() -cne $v.nonceHash){throw 'observer nonce differs'}}
  Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class FixtureFenceNative {
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetNamedPipeServerProcessId(IntPtr pipe,out uint pid);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool DuplicateHandle(IntPtr src,IntPtr handle,IntPtr dst,out IntPtr copy,uint access,bool inherit,uint options);
 [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern uint GetFinalPathNameByHandle(IntPtr handle,StringBuilder name,uint size,uint flags);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern uint GetProcessId(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetProcessTimes(IntPtr handle,out long created,out long exited,out long kernel,out long user);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool QueryFullProcessImageName(IntPtr handle,uint flags,StringBuilder name,ref uint size);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
 [DllImport("shell32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr CommandLineToArgvW(string command,out int argc);
 [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr ptr);
}
'@
  $p=Get-Process -Id $v.pid -ErrorAction Stop;$c=Get-CimInstance Win32_Process -Filter ('ProcessId='+$v.pid) -ErrorAction Stop
  $self=(Get-Process -Id $PID -ErrorAction Stop).Path
  if($p.StartTime.ToUniversalTime().Ticks.ToString() -cne $v.ticks -or $p.Path -ine $v.exe -or $p.Path -ine $self){throw 'process identity differs'}
  [int]$argc=0;$argv=[FixtureFenceNative]::CommandLineToArgvW($c.CommandLine,[ref]$argc);if($argv -eq [IntPtr]::Zero){throw 'process arguments unavailable'}
  try{$argsList=@();for($i=0;$i -lt $argc;$i++){$argsList += [Runtime.InteropServices.Marshal]::PtrToStringUni([Runtime.InteropServices.Marshal]::ReadIntPtr($argv,$i*[IntPtr]::Size))};if($argsList.Count -ne 12 -or $argsList[1] -ine '-NoLogo' -or $argsList[2] -ine '-NoProfile' -or $argsList[3] -ine '-NonInteractive' -or $argsList[4] -ine '-File' -or -not [String]::Equals([IO.Path]::GetFullPath($argsList[5]),[IO.Path]::GetFullPath($ExpectedScript),[StringComparison]::OrdinalIgnoreCase) -or $argsList[6] -ine '-RuntimeRoot' -or -not [String]::Equals([IO.Path]::GetFullPath($argsList[7]),[IO.Path]::GetFullPath($Root),[StringComparison]::OrdinalIgnoreCase) -or $argsList[8] -ine '-NodeExecutable' -or -not [IO.Path]::IsPathFullyQualified($argsList[9]) -or $argsList[10] -ine '-Mode' -or $argsList[11] -ine 'web'){throw 'wrapper arguments differ'}}finally{[void][FixtureFenceNative]::LocalFree($argv)}
  $pipeName=if($HostExited){$v.pipe}else{$v.hostPipe};$pipe=[IO.Pipes.NamedPipeClientStream]::new('.',$pipeName,[IO.Pipes.PipeDirection]::InOut,[IO.Pipes.PipeOptions]::None)
  try {
    $pipe.Connect(3000);[uint32]$server=0
    if(-not [FixtureFenceNative]::GetNamedPipeServerProcessId($pipe.SafePipeHandle.DangerousGetHandle(),[ref]$server) -or $server -ne $v.pid){throw 'pipe owner differs'}
    if($HostExited){$writer=[IO.StreamWriter]::new($pipe);$writer.AutoFlush=$true;$reader=[IO.StreamReader]::new($pipe);$challenge=[guid]::NewGuid().ToString('N');$writer.WriteLine($challenge);$mac=[Security.Cryptography.HMACSHA256]::new([Convert]::FromHexString($ExpectedNonce));try{$expectedMac=[Convert]::ToHexString($mac.ComputeHash([Text.Encoding]::UTF8.GetBytes($challenge))).ToLowerInvariant()}finally{$mac.Dispose()};if($reader.ReadLine() -cne $expectedMac){throw 'pipe challenge differs'}}
    $source=[FixtureFenceNative]::OpenProcess(0x40,$false,$v.pid);if($source -eq [IntPtr]::Zero){throw 'process handle unavailable'}
    try {
      foreach($item in @(@($v.dshHandle,(Join-Path $Root 'runtime\DSH-launch.lock')),@($v.controllerHandle,(Join-Path $Root 'runtime\Controller-launch.lock')))){
        $copy=[IntPtr]::Zero
        try {
          if(-not [FixtureFenceNative]::DuplicateHandle($source,[IntPtr]([long]$item[0]),[FixtureFenceNative]::GetCurrentProcess(),[ref]$copy,0,$false,2)){throw 'lock handle unavailable'}
          $name=[Text.StringBuilder]::new(32768);$length=[FixtureFenceNative]::GetFinalPathNameByHandle($copy,$name,[uint32]$name.Capacity,0);if($length -eq 0 -or $length -ge $name.Capacity){throw 'lock path unavailable'}
          $path=$name.ToString();if($path.StartsWith('\\?\')){$path=$path.Substring(4)}
          if(-not [String]::Equals([IO.Path]::GetFullPath($path),[IO.Path]::GetFullPath($item[1]),[StringComparison]::OrdinalIgnoreCase)){throw 'lock path differs'}
          foreach($access in @([IO.FileAccess]::Read,[IO.FileAccess]::Write)){try{$f=[IO.File]::Open($item[1],[IO.FileMode]::Open,$access,[IO.FileShare]::ReadWrite);$f.Dispose();throw 'lock is not exclusive'}catch [IO.IOException]{if($_.Exception.HResult -ne -2147024864){throw}}}
        } finally {if($copy -ne [IntPtr]::Zero){[void][FixtureFenceNative]::CloseHandle($copy)}}
      }
      if($RequireHost){
        if($v.targetPid -lt 1 -or $v.targetTicks -notmatch '^[0-9]+$' -or $v.targetHandle -notmatch '^[1-9][0-9]*$' -or [string]::IsNullOrEmpty($v.targetExe)){throw 'target identity unavailable'}
        $copy=[IntPtr]::Zero
        try {
          if(-not [FixtureFenceNative]::DuplicateHandle($source,[IntPtr]([long]$v.targetHandle),[FixtureFenceNative]::GetCurrentProcess(),[ref]$copy,0,$false,2)){throw 'target handle unavailable'}
          [long]$created=0;[long]$exited=0;[long]$kernel=0;[long]$user=0;[uint32]$code=0
          if([FixtureFenceNative]::GetProcessId($copy) -ne $v.targetPid -or -not [FixtureFenceNative]::GetProcessTimes($copy,[ref]$created,[ref]$exited,[ref]$kernel,[ref]$user) -or [DateTime]::FromFileTimeUtc($created).Ticks.ToString() -cne $v.targetTicks -or -not [FixtureFenceNative]::GetExitCodeProcess($copy,[ref]$code)){throw 'target process generation differs'}
          if($HostExited){if($code -ne 0){throw 'target exit is not confirmed clean'}}else{if($code -ne 259){throw 'target is not running'};$name=[Text.StringBuilder]::new(32768);[uint32]$length=$name.Capacity;if(-not [FixtureFenceNative]::QueryFullProcessImageName($copy,0,$name,[ref]$length) -or -not [string]::Equals($name.ToString(),$v.targetExe,[StringComparison]::OrdinalIgnoreCase)){throw 'target executable differs'}}
        } finally {if($copy -ne [IntPtr]::Zero){[void][FixtureFenceNative]::CloseHandle($copy)}}
      }elseif($HostExited){throw 'target verification is required'}
    } finally {[void][FixtureFenceNative]::CloseHandle($source)}
    $again=Get-Process -Id $v.pid -ErrorAction Stop;if($again.StartTime.ToUniversalTime().Ticks.ToString() -cne $v.ticks){throw 'process generation changed'}
    if(-not $HostExited){$reader=[IO.StreamReader]::new($pipe);$task=$reader.ReadLineAsync();if(-not $task.Wait(3000)){throw 'Host proof pipe timed out'};$secret=$task.Result;try{if($secret -cnotmatch '^[a-f0-9]{64}$' -or [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($secret))).ToLowerInvariant() -cne $v.nonceHash){throw 'Host proof differs'}}finally{$secret=$null}}
  } finally {$pipe.Dispose()}
  Write-Output 'verified'
} catch {[Console]::Error.WriteLine($_.Exception.Message);exit 1}
