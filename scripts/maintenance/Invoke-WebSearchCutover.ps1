#Requires -Version 7.0
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$RuntimeRoot,
  [Parameter(Mandatory)][string]$NodeExecutable,
  [ValidateSet('web')][string]$Mode='web',
  [switch]$ProbeOnly,
  [switch]$HostFenceProbe,
  [switch]$DependencyPinProbe,
  [switch]$ReadinessOnly
)
$ErrorActionPreference='Stop'
# Inspection never starts a service, takes launch locks or writes a DB. It
# deliberately cannot make execution available while required proofs are absent.
if($ReadinessOnly){
 if($ProbeOnly -or $HostFenceProbe -or $DependencyPinProbe){throw 'Readiness inspection cannot be combined with probes.'}
 foreach($path in @($RuntimeRoot,$NodeExecutable)){if(-not [IO.Path]::IsPathFullyQualified($path)){throw 'Runtime and Node paths must be absolute.'}}
 $nodeHelper=Join-Path $PSScriptRoot 'ApprovedNode.ps1';$readiness=Join-Path $PSScriptRoot 'Test-WebCutoverReadiness.ps1'
 foreach($path in @($nodeHelper,$readiness)){if(-not(Test-Path -LiteralPath $path -PathType Leaf) -or ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Fixed readiness component is unavailable or unsafe.'}}
 . $nodeHelper;. $readiness
 Get-WebCutoverReadiness ([IO.Path]::GetFullPath($RuntimeRoot)) ([IO.Path]::GetFullPath($NodeExecutable)) $PSCommandPath | ConvertTo-Json -Depth 6 -Compress
 return
}
$executing=-not $ProbeOnly
if($executing -and ($HostFenceProbe -or $DependencyPinProbe)){throw 'Probe modes require ProbeOnly.'}
if($HostFenceProbe -and $DependencyPinProbe){throw 'Probe modes cannot be combined.'}
foreach($path in @($RuntimeRoot,$NodeExecutable)){if(-not [IO.Path]::IsPathFullyQualified($path)){throw 'Runtime and Node paths must be absolute.'}}
$root=[IO.Path]::GetFullPath($RuntimeRoot);$node=Get-Item -LiteralPath $NodeExecutable -Force -ErrorAction Stop
if($node.PSIsContainer -or ($node.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Node executable is unsafe.'}
$helper=Join-Path (Split-Path $PSScriptRoot -Parent) 'DshLaunchLock.ps1';$waitHelper=Join-Path $PSScriptRoot 'Wait-OwnedProbe.ps1';$hostHelper=Join-Path $PSScriptRoot 'WebCutoverHostFence.ps1';$nodeHelper=Join-Path $PSScriptRoot 'ApprovedNode.ps1';$readiness=Join-Path $PSScriptRoot 'Test-WebCutoverReadiness.ps1';$entry=Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) $(if($executing){'apps/controller/search/cutover-maintenance-execute.mjs'}else{'apps/controller/search/cutover-maintenance-probe.mjs'})
foreach($path in @($helper,$waitHelper,$hostHelper,$nodeHelper,$readiness,$entry)){if(-not(Test-Path -LiteralPath $path -PathType Leaf) -or ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Fixed maintenance component is unavailable or unsafe.'}}
$nonce=if($executing){[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()}else{[Console]::In.ReadLine()};if($nonce -cnotmatch '^[a-f0-9]{64}$'){throw 'A 64-character lowercase nonce is required on standard input.'}
. $helper
. $waitHelper
. $hostHelper
. $nodeHelper
. $readiness
$dsh=$null;$controller=$null;$child=$null;$childStarted=$false;$hostFence=$null;$hostFenceComplete=$false;$approvedNode=$null;$approvedHostHelper=$null;$approvedComponents=$null
try{
 $approvedNode=Enter-ApprovedMaintenanceNode $root $node.FullName
 if($executing -or $HostFenceProbe -or $DependencyPinProbe){$approvedHostHelper=Enter-ApprovedMaintenanceHostHelper $root (Join-Path $PSScriptRoot 'Verify-WebHostOwner.ps1')}
 if($executing -or $DependencyPinProbe){$approvedComponents=Enter-ApprovedWebCutoverComponents $root $node.FullName $PSCommandPath}
 if($executing){
  foreach($name in @('runtime/maintenance/controller-cutover-preopen.json','runtime/maintenance/host-stop-attempt.json')){if(Get-Item -LiteralPath (Join-Path $root $name) -Force -ErrorAction SilentlyContinue){throw 'Prior maintenance evidence requires inspection. No service was stopped.'}}
  foreach($name in @('runtime/maintenance/cutover-plan.json','runtime/maintenance/route-policy.json','runtime/DSH.json','runtime/Controller.json')){$item=Get-Item -LiteralPath (Join-Path $root $name) -Force -ErrorAction Stop;if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Maintenance input is unavailable or unsafe. No service was stopped.'}}
  $backup=Get-Item -LiteralPath (Join-Path $root 'data/cutover-backups') -Force -ErrorAction Stop;if(-not $backup.PSIsContainer -or ($backup.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Maintenance backup directory is unavailable. No service was stopped.'}
  $plan=Get-Content -LiteralPath (Join-Path $root 'runtime/maintenance/cutover-plan.json') -Raw | ConvertFrom-Json -AsHashtable
  if($plan.version -ne 1 -or @($plan.Keys).Count -ne 3 -or -not $plan.ContainsKey('sessionId') -or -not $plan.ContainsKey('turn') -or [string]$plan.sessionId -cnotmatch '^[\x21-\x7e]{1,150}$' -or $plan.turn -isnot [long] -or $plan.turn -lt 1){throw 'Maintenance plan differs. No service was stopped.'}
  Assert-DefaultDshDesktopStopped
 }
 $dsh=Enter-DshLaunchLock $root
 $controllerPath=Join-Path $root 'runtime/Controller-launch.lock';$info=Get-Item -LiteralPath $controllerPath -Force -ErrorAction Stop
 if($info.PSIsContainer -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Controller launch lock is unsafe.'}
 try{$controller=[IO.File]::Open($controllerPath,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}catch{throw 'Controller launch lock is unavailable.'}
 if($executing){Assert-DefaultDshDesktopStopped}
 if($executing -or $HostFenceProbe){$hostFence=Start-WebCutoverHostFence $root $nonce $dsh $controller $approvedHostHelper.Hash}
 $self=Get-Process -Id $PID -ErrorAction Stop
 $start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=$node.FullName;$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
 [void]$start.ArgumentList.Add($entry);if(-not $executing){[void]$start.ArgumentList.Add($(if($HostFenceProbe){'--host-fence-probe'}elseif($DependencyPinProbe){'--pin-probe'}else{'--probe'}));[void]$start.ArgumentList.Add($controllerPath);[void]$start.ArgumentList.Add((Join-Path $root 'runtime/DSH-launch.lock'));[void]$start.ArgumentList.Add($PSCommandPath)}else{$start.Environment['MEDIA_STUDIO_HOME']=$root}
 $start.Environment['MEDIA_STUDIO_LEGACY_PARENT_PID']=[string]$PID;$start.Environment['MEDIA_STUDIO_LEGACY_PARENT_TICKS']=$self.StartTime.ToUniversalTime().Ticks.ToString();$start.Environment['MEDIA_STUDIO_LEGACY_PARENT_EXE']=$self.Path;$start.Environment['MEDIA_STUDIO_LEGACY_PARENT_SCRIPT']=$PSCommandPath
 $start.Environment['MEDIA_STUDIO_LEGACY_PARENT_HANDLE']=$controller.SafeFileHandle.DangerousGetHandle().ToInt64().ToString();$start.Environment['MEDIA_STUDIO_DSH_PARENT_HANDLE']=$dsh.SafeFileHandle.DangerousGetHandle().ToInt64().ToString()
 $child=[Diagnostics.Process]::new();$child.StartInfo=$start;if(-not $child.Start()){throw 'Maintenance probe failed to start.'};$childStarted=$true;$stdout=$child.StandardOutput.ReadToEndAsync();$stderr=$child.StandardError.ReadToEndAsync();$child.StandardInput.WriteLine($nonce);$child.StandardInput.Close();$nonce=$null
 if($executing){while($true){try{if($child.WaitForExit(1000)){break}}catch{Start-Sleep -Seconds 1}}}else{Wait-OwnedProbe $child}
 if($child.ExitCode -ne 0){if($executing){if(-not(Get-Item -LiteralPath (Join-Path $root 'runtime/maintenance/host-stop-attempt.json') -Force -ErrorAction SilentlyContinue)){$hostFenceComplete=$true};[Console]::Error.Write($stderr.GetAwaiter().GetResult());throw 'Web cutover is on hold; retain its maintenance evidence.'}else{throw 'Maintenance probe failed; no service was stopped.'}};[Console]::Out.Write($stdout.GetAwaiter().GetResult());$hostFenceComplete=$true
} finally {
 $nonce=$null
 # This also covers failures after Start but before the normal wait, e.g.
 # a broken stdin pipe. Never release either lock while that child may live.
 if($childStarted){try{Wait-OwnedProbe $child -TimeoutMs 1}catch{}}
 if($child){$child.Dispose()};if($hostFence){if($hostFenceComplete){try{Complete-WebCutoverHostFence $hostFence}catch{[Console]::Error.WriteLine('Host fence evidence cleanup failed; evidence was retained.')}};if($hostFence.Helper){$hostFence.Helper.Dispose()};$hostFence.Stream.Dispose();$hostFence.Target.Dispose()};if($controller){$controller.Dispose()};if($dsh){$dsh.Dispose()};if($approvedComponents){foreach($stream in $approvedComponents.Files){$stream.Dispose()};$approvedComponents.Manifest.Dispose()};if($approvedHostHelper){$approvedHostHelper.File.Dispose();$approvedHostHelper.Manifest.Dispose()};if($approvedNode){$approvedNode.Executable.Dispose();$approvedNode.Manifest.Dispose()}
}
