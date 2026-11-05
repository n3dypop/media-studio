# Explicit maintenance only: inspect -Plan, then pass its planSha256 to
# -Apply -ExpectedPlanSha256. Apply holds both launcher locks, pins the exact
# component files and preserves a hash-verified copy of an existing manifest.
# Neither normal startup nor readiness inspection calls this command.
[CmdletBinding(DefaultParameterSetName='Plan')]
param(
    [Parameter(Mandatory=$true)][string]$RuntimeRoot,
    [Parameter(ParameterSetName='Plan',Mandatory=$true)][switch]$Plan,
    [Parameter(ParameterSetName='Apply',Mandatory=$true)][switch]$Apply,
    [Parameter(ParameterSetName='Apply',Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedPlanSha256
)
$ErrorActionPreference='Stop'
if(-not [IO.Path]::IsPathFullyQualified($RuntimeRoot)){throw 'Runtime root must be absolute.'}
$root=[IO.Path]::GetFullPath($RuntimeRoot)
$install=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$namespace=Split-Path $install -Parent;$plugins=Split-Path $namespace -Parent;$runtimeBase=Split-Path $plugins -Parent
if((Split-Path $install -Leaf) -cne 'media-studio' -or (Split-Path $namespace -Leaf) -cne 'n3dypop' -or (Split-Path $plugins -Leaf) -cne 'plugins' -or (Split-Path $runtimeBase -Leaf) -cne '.runtime' -or -not [String]::Equals($root,(Join-Path $runtimeBase 'media-studio'),[StringComparison]::OrdinalIgnoreCase)){throw 'Installation and runtime roots differ.'}
$maint=Join-Path $root 'runtime/maintenance';$manifestPath=Join-Path $maint 'approved-cutover-components.json';$wrapper=Join-Path $PSScriptRoot 'Invoke-WebSearchCutover.ps1'
function Assert-SafeParents([string]$Path){$item=Get-Item -LiteralPath $Path -Force -ErrorAction Stop;while($item){if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or (-not $item.PSIsContainer)){throw 'Directory is unavailable or unsafe.'};$parent=Split-Path $item.FullName -Parent;if(-not $parent -or $parent -eq $item.FullName){break};$item=Get-Item -LiteralPath $parent -Force -ErrorAction Stop}}
function Assert-PrivateAcl([string]$Path){$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$system='S-1-5-18';$acl=Get-Acl -LiteralPath $Path;$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));if($rules.Count -ne 2){throw 'Backup ACL is not private.'};$directory=(Get-Item -LiteralPath $Path -Force).PSIsContainer;foreach($rule in $rules){if($directory -and ($rule.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ObjectInherit) -ne [Security.AccessControl.InheritanceFlags]::ObjectInherit){throw 'Backup ACL is not inherited by files.'};if($rule.IdentityReference.Value -notin @($sid,$system) -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl){throw 'Backup ACL is not private.'}};if(@($rules|Where-Object {$_.IdentityReference.Value -eq $sid}).Count -ne 1 -or @($rules|Where-Object {$_.IdentityReference.Value -eq $system}).Count -ne 1){throw 'Backup ACL identity differs.'}}
Assert-SafeParents $maint;Assert-SafeParents $install;Assert-SafeParents $namespace
. (Join-Path $PSScriptRoot 'Test-WebCutoverReadiness.ps1')
. (Join-Path $install 'scripts/DshLaunchLock.ps1')
$dsh=$null;$controller=$null;$old=$null;$journal=$null;$files=[Collections.Generic.List[IO.FileStream]]::new();$journalPath=Join-Path $maint 'approved-cutover-components.pending.json'
try{
 if($Apply){
  $dsh=Enter-DshLaunchLock $root
  $lockPath=Join-Path $root 'runtime/Controller-launch.lock';$item=Get-Item -LiteralPath $lockPath -Force -ErrorAction Stop;if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Controller launch lock is unsafe.'}
  try{$controller=[IO.File]::Open($lockPath,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}catch{throw 'Controller launch lock is unavailable.'}
  foreach($name in @('host-stop-attempt.json','controller-cutover-preopen.json','approved-cutover-components.pending.json')){if(Test-Path -LiteralPath (Join-Path $maint $name)){throw 'Prior maintenance evidence requires inspection.'}}
  $backupParent=Join-Path $root 'data/cutover-backups';Assert-SafeParents $backupParent;Assert-PrivateAcl $backupParent
 }
 $fixed=Get-FixedWebCutoverComponents $install $namespace $wrapper;$pins=[ordered]@{};$components=@()
 foreach($name in $fixed.Keys){$path=[IO.Path]::GetFullPath($fixed[$name]);Assert-SafeParents (Split-Path $path -Parent);$item=Get-Item -LiteralPath $path -Force -ErrorAction Stop;if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Component is unavailable or unsafe.'};$file=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);$files.Add($file);$sha=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($file)).ToLowerInvariant();$pins[$name]=$sha;$components+=[ordered]@{name=$name;path=$path;sha256=$sha}}
 $previous=$null;$oldBytes=$null
 if(Test-Path -LiteralPath $manifestPath){$item=Get-Item -LiteralPath $manifestPath -Force;if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Existing manifest is unsafe.'};$old=if($Apply){[IO.File]::Open($manifestPath,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}else{[IO.File]::Open($manifestPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)};if($old.Length -gt 32768){throw 'Existing manifest is too large.'};$buffer=[IO.MemoryStream]::new();try{$old.CopyTo($buffer);$oldBytes=$buffer.ToArray()}finally{$buffer.Dispose()};$previous=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($oldBytes)).ToLowerInvariant()}
 $target=[ordered]@{version=1;runtimeRoot=$root;pins=$pins};$body=($target|ConvertTo-Json -Compress -Depth 8);$encoder=[Text.UTF8Encoding]::new($false);$bytes=$encoder.GetBytes($body+"`n")
 $planData=[ordered]@{version=1;runtimeRoot=$root;previousSha256=$previous;targetSha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant();components=$components}
 $planHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($encoder.GetBytes(($planData|ConvertTo-Json -Compress -Depth 8)))).ToLowerInvariant()
 if($Plan){[ordered]@{mode='plan';planSha256=$planHash;plan=$planData}|ConvertTo-Json -Depth 8;return}
 if($planHash -cne $ExpectedPlanSha256){throw 'Components or existing manifest changed since the explicit plan.'}
 $backup=$null
 if($old){$backup=Join-Path $backupParent ('approved-cutover-components.backup-'+[Guid]::NewGuid().ToString('N')+'.json');$out=[IO.File]::Open($backup,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$out.Write($oldBytes,0,$oldBytes.Length);$out.Flush($true)}finally{$out.Dispose()};Assert-PrivateAcl $backup;if((Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash.ToLowerInvariant() -cne $previous){throw 'Manifest backup differs.'}}
 Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles;
public static class MediaStudioApprovalJournal {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern SafeFileHandle CreateFile(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
 [StructLayout(LayoutKind.Sequential)] public struct Disposition { [MarshalAs(UnmanagedType.U1)] public bool DeleteFile; }
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool SetFileInformationByHandle(SafeFileHandle handle,int kind,ref Disposition info,uint size);
}
'@
 $handle=[MediaStudioApprovalJournal]::CreateFile($journalPath,[uint32]3221291008,0,[IntPtr]::Zero,1,0x80,[IntPtr]::Zero);if($handle.IsInvalid){$handle.Dispose();throw 'Approval journal is unavailable.'};$journal=[IO.FileStream]::new($handle,[IO.FileAccess]::ReadWrite)
 $backupName=if($backup){Split-Path $backup -Leaf}else{$null};$pending=$encoder.GetBytes((([ordered]@{version=1;state='pending';previousSha256=$previous;targetSha256=$planData.targetSha256;backupName=$backupName}|ConvertTo-Json -Compress)+"`n"));$journal.Write($pending,0,$pending.Length);$journal.Flush($true)
 if(-not $old){$old=[IO.File]::Open($manifestPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}
 $old.Position=0;$old.SetLength(0);$old.Write($bytes,0,$bytes.Length);$old.Flush($true);$old.Position=0
 $actual=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($old)).ToLowerInvariant();if($actual -cne $planData.targetSha256){throw 'Written manifest differs; retain the journal and backup for inspection.'}
 $disposition=[MediaStudioApprovalJournal+Disposition]::new();$disposition.DeleteFile=$true;if(-not [MediaStudioApprovalJournal]::SetFileInformationByHandle($journal.SafeFileHandle,4,[ref]$disposition,1)){throw 'Approval journal cleanup failed; retain evidence for inspection.'};$journal.Dispose();$journal=$null
 [ordered]@{mode='applied';planSha256=$planHash;manifestSha256=$planData.targetSha256;backup=$backup}|ConvertTo-Json -Depth 4
}finally{if($journal){$journal.Dispose()};if($old){$old.Dispose()};foreach($file in $files){$file.Dispose()};if($controller){$controller.Dispose()};if($dsh){$dsh.Dispose()}}
