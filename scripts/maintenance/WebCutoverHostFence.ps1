# Read-only host fence probe only. The cutover execution route remains disabled.
function Start-WebCutoverHostFence([string]$Root,[string]$Nonce,[IO.FileStream]$DshLock,[IO.FileStream]$ControllerLock,[string]$ApprovedHelperHash='') {
    $recordPath=Join-Path $Root 'runtime/DSH.json'
    $recordItem=Get-Item -LiteralPath $recordPath -Force -ErrorAction Stop
    if($recordItem.PSIsContainer -or ($recordItem.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Host record is unsafe.'}
    $record=Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
    if($record.processId -lt 1 -or [string]$record.startTimeUtcTicks -notmatch '^[0-9]+$' -or -not [IO.Path]::IsPathFullyQualified([string]$record.executable)){throw 'Host record is incomplete.'}
    $target=Get-Process -Id $record.processId -ErrorAction Stop;$helperFile=$null;$stream=$null
    try {
        if($target.HasExited -or $target.StartTime.ToUniversalTime().Ticks.ToString() -cne [string]$record.startTimeUtcTicks -or $target.Path -ine $record.executable){throw 'Host generation differs from record.'}
        $handle=$target.Handle;if($handle -eq [IntPtr]::Zero -or $target.HasExited){throw 'Host process handle unavailable.'}
        Add-Type -TypeDefinition @'
using System; using System.IO; using System.IO.Pipes; using System.Threading; using System.Text; using System.Security.Cryptography; using System.Diagnostics; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles;
public static class MediaStudioProbePipe {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern SafeFileHandle CreateFile(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
 [StructLayout(LayoutKind.Sequential)] public struct Disposition { [MarshalAs(UnmanagedType.U1)] public bool DeleteFile; }
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool SetFileInformationByHandle(SafeFileHandle handle,int kind,ref Disposition info,uint size);
 public static void Start(string name,byte[] key) { var thread=new Thread(()=>{ for(;;) { try { using(var pipe=new NamedPipeServerStream(name,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.CurrentUserOnly|PipeOptions.Asynchronous)) { pipe.WaitForConnection(); using(var reader=new StreamReader(pipe)) using(var writer=new StreamWriter(pipe){AutoFlush=true}) using(var mac=new HMACSHA256(key)) { var clock=Stopwatch.StartNew();var text=new StringBuilder();var buffer=new char[1];while(text.Length<=32){int remaining=1500-(int)clock.ElapsedMilliseconds;if(remaining<=0)throw new TimeoutException();var read=reader.ReadAsync(buffer,0,1);if(!read.Wait(remaining)||read.Result!=1)throw new EndOfStreamException();if(buffer[0]=='\n')break;if(buffer[0]=='\r'&&text.Length==32)continue;text.Append(buffer[0]);}string challenge=text.ToString();if(challenge.Length==32&&System.Text.RegularExpressions.Regex.IsMatch(challenge,"^[a-f0-9]{32}$"))writer.WriteLine(Convert.ToHexString(mac.ComputeHash(Encoding.UTF8.GetBytes(challenge))).ToLowerInvariant()); } } } catch {} } }); thread.IsBackground=true;thread.Start(); }
}
'@
        # Separate Host-verifier pipe: the old challenge pipe remains for the
        # fixed cutover entry. This does not register a DSH management route.
        Add-Type -AssemblyName System.Management
        Add-Type -TypeDefinition @'
using System;using System.IO;using System.IO.Pipes;using System.Threading;using System.Runtime.InteropServices;using System.Text;using System.Collections;
public static class MediaStudioHostProofPipe {
 [StructLayout(LayoutKind.Sequential)] struct PBI { public IntPtr Reserved1,Peb,Reserved2a,Reserved2b,Id,Parent; }
 [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr p,int cls,out PBI info,int len,out int ret);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeClientProcessId(IntPtr pipe,out uint pid);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr p,out long c,out long e,out long k,out long u);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr p,out uint code);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr p,uint flags,StringBuilder text,ref uint len);
 [DllImport("shell32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CommandLineToArgvW(string command,out int argc);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr ptr);
 [StructLayout(LayoutKind.Sequential)] struct FileInfo { public uint attr,ct1,ct2,at1,at2,wt1,wt2,vol,sizehi,sizelo,links,indexhi,indexlo; }
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr h,out FileInfo info);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(IntPtr h,StringBuilder text,uint size,uint flags);
 static bool FileProof(IntPtr handle,string path,string expected){FileInfo info;var name=new StringBuilder(32768);uint size=GetFinalPathNameByHandle(handle,name,(uint)name.Capacity,0);if(!GetFileInformationByHandle(handle,out info)||info.links!=1||size==0||size>=name.Capacity)return false;string resolved=name.ToString();if(resolved.StartsWith(@"\\?\"))resolved=resolved.Substring(4);if(!String.Equals(Path.GetFullPath(resolved),Path.GetFullPath(path),StringComparison.OrdinalIgnoreCase))return false;using(var stream=File.OpenRead(path))return Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(stream)).ToLowerInvariant()==expected;}
 static bool Args(uint pid,string script,string root,int host,long ticks,string hostExe){string line=null;Type type=Type.GetType("System.Management.ManagementObjectSearcher, System.Management",true);using(var search=(IDisposable)Activator.CreateInstance(type,"SELECT CommandLine FROM Win32_Process WHERE ProcessId="+pid))using(var rows=(IDisposable)type.GetMethod("Get",Type.EmptyTypes).Invoke(search,null))foreach(object row in (IEnumerable)rows){if(line!=null)return false;line=row.GetType().GetProperty("Item",new[]{typeof(string)}).GetValue(row,new object[]{"CommandLine"}) as string;}if(line==null)return false;int n;IntPtr raw=CommandLineToArgvW(line,out n);if(raw==IntPtr.Zero)return false;try{if(n!=14)return false;string[] a=new string[n];for(int i=0;i<n;i++)a[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(raw,i*IntPtr.Size));return a[1]=="-NoLogo"&&a[2]=="-NoProfile"&&a[3]=="-NonInteractive"&&a[4]=="-File"&&String.Equals(Path.GetFullPath(a[5]),Path.GetFullPath(script),StringComparison.OrdinalIgnoreCase)&&a[6]=="-Root"&&String.Equals(Path.GetFullPath(a[7]),Path.GetFullPath(root),StringComparison.OrdinalIgnoreCase)&&a[8]=="-ExpectedPid"&&a[9]==host.ToString()&&a[10]=="-ExpectedTicks"&&a[11]==ticks.ToString()&&a[12]=="-ExpectedExe"&&String.Equals(a[13],hostExe,StringComparison.OrdinalIgnoreCase);}finally{LocalFree(raw);}}
 public static bool Start(string name,string key,int host,IntPtr hostHandle,long hostTicks,string clientExe,string script,IntPtr scriptHandle,string scriptHash,string root,string hostExe) { var ready=new ManualResetEvent(false);var thread=new Thread(()=>{for(;;){try{using(var pipe=new NamedPipeServerStream(name,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.CurrentUserOnly|PipeOptions.Asynchronous)){ready.Set();pipe.WaitForConnection();uint client;if(!GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out client))continue;IntPtr proc=OpenProcess(0x1000,false,(int)client);if(proc==IntPtr.Zero)continue;try{PBI info;int ret;long c,e,k,u;uint code;var path=new StringBuilder(32768);uint size=(uint)path.Capacity;if(NtQueryInformationProcess(proc,0,out info,Marshal.SizeOf<PBI>(),out ret)!=0||info.Parent.ToInt64()!=host||!GetProcessTimes(hostHandle,out c,out e,out k,out u)||DateTime.FromFileTimeUtc(c).Ticks!=hostTicks||!GetExitCodeProcess(hostHandle,out code)||code!=259||!QueryFullProcessImageName(proc,0,path,ref size)||!String.Equals(path.ToString(),clientExe,StringComparison.OrdinalIgnoreCase)||!Args(client,script,root,host,hostTicks,hostExe)||!FileProof(scriptHandle,script,scriptHash)||!GetExitCodeProcess(proc,out code)||code!=259)continue;using(var writer=new StreamWriter(pipe){AutoFlush=true})writer.WriteLine(key);}finally{CloseHandle(proc);}}}catch{}}});thread.IsBackground=true;thread.Start();return ready.WaitOne(5000); }
}
'@
        $directory=Join-Path $Root 'runtime/maintenance';[void][IO.Directory]::CreateDirectory($directory)
        $item=Get-Item -LiteralPath $directory -Force;if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Maintenance directory is unsafe.'}
        $ready=Join-Path $directory 'fence-ready.json';$name='media-studio-cutover-'+[guid]::NewGuid().ToString('N');$hostPipe='media-studio-host-'+[guid]::NewGuid().ToString('N')
        $me=Get-Process -Id $PID
        $info=@{pid=$PID;ticks=$me.StartTime.ToUniversalTime().Ticks.ToString();exe=$me.Path;pipe=$name;hostPipe=$hostPipe;nonceHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Nonce))).ToLowerInvariant();dshHandle=$DshLock.SafeFileHandle.DangerousGetHandle().ToInt64().ToString();controllerHandle=$ControllerLock.SafeFileHandle.DangerousGetHandle().ToInt64().ToString();targetPid=$target.Id;targetTicks=$target.StartTime.ToUniversalTime().Ticks.ToString();targetExe=$target.Path;targetHandle=$handle.ToInt64().ToString()}
        [MediaStudioProbePipe]::Start($name,[Convert]::FromHexString($Nonce))
        if($ApprovedHelperHash){
          if($ApprovedHelperHash -cnotmatch '^[a-f0-9]{64}$'){throw 'Approved Host verifier hash is invalid.'}
          $helperPath=Join-Path $PSScriptRoot 'Verify-WebHostOwner.ps1';$helperItem=Get-Item -LiteralPath $helperPath -Force -ErrorAction Stop
          if($helperItem.PSIsContainer -or ($helperItem.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Host verifier is unsafe.'}
          $helperFile=[IO.File]::Open($helperPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);$helperDigest=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($helperFile)).ToLowerInvariant();$helperFile.Position=0;if($helperDigest -cne $ApprovedHelperHash){throw 'Host verifier hash differs.'}
          if(-not [MediaStudioHostProofPipe]::Start($hostPipe,$Nonce,$target.Id,$handle,[long]$info.targetTicks,$me.Path,$helperPath,$helperFile.SafeFileHandle.DangerousGetHandle(),$ApprovedHelperHash,$Root,$target.Path)){throw 'Host proof pipe did not become ready.'}
        }
        $file=[MediaStudioProbePipe]::CreateFile($ready,[uint32]3221291008,1,[IntPtr]::Zero,1,0,[IntPtr]::Zero)
        if($file.IsInvalid){$file.Dispose();throw 'Host fence evidence could not be created exclusively.'}
        $stream=[IO.FileStream]::new($file,[IO.FileAccess]::ReadWrite)
        try {$bytes=[Text.Encoding]::UTF8.GetBytes(($info|ConvertTo-Json -Compress));$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)} catch {$stream.Dispose();throw}
        return @{Target=$target;Ready=$ready;Stream=$stream;Helper=$helperFile;Hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()}
    } catch {if($stream){$stream.Dispose()};if($helperFile){$helperFile.Dispose()};$target.Dispose();throw}
}
function Complete-WebCutoverHostFence($Fence) {
    # The owned, exclusively-created handle identifies the same regular file;
    # no path-based delete or replacement race is used.
    $stream=$Fence.Stream;$stream.Position=0
    $hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant()
    if($hash -cne $Fence.Hash){throw 'Host fence evidence changed; retained.'}
    $info=[MediaStudioProbePipe+Disposition]::new();$info.DeleteFile=$true
    if(-not [MediaStudioProbePipe]::SetFileInformationByHandle($stream.SafeFileHandle,4,[ref]$info,1)){throw 'Host fence evidence cleanup failed; retained.'}
}
