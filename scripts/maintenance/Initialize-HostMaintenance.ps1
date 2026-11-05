#Requires -Version 7.0
param([Parameter(Mandatory)][string]$RuntimeRoot)
$ErrorActionPreference='Stop'
if(-not [IO.Path]::IsPathFullyQualified($RuntimeRoot)){throw 'Runtime root must be absolute.'}
$root=[IO.Path]::GetFullPath($RuntimeRoot)
$directory=Get-Item -LiteralPath $root -Force -ErrorAction Stop
while($directory){if($directory.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Redirected runtime paths are not supported.'};$directory=$directory.Parent}
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'DshLaunchLock.ps1')
$launchLock=Enter-DshLaunchLock $root
try{
Assert-DefaultDshDesktopStopped
$recordPath=Join-Path $root 'runtime/DSH.json'
if(-not(Test-Path -LiteralPath $recordPath -PathType Leaf)){throw 'A managed DSH process record is required; absence is not proof of shutdown.'}
if(Test-Path -LiteralPath $recordPath){$recordItem=Get-Item -LiteralPath $recordPath -Force;if($recordItem.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'DSH process record is redirected.'};$record=Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json;$recordId=0;if(-not [int]::TryParse([string]$record.processId,[ref]$recordId) -or $recordId -lt 1){throw 'DSH process record is ambiguous.'};if(Get-CimInstance Win32_Process -Filter ('ProcessId='+$recordId) -ErrorAction Stop){throw 'Recorded DSH PID is still present; maintenance provisioning is held.'}}
$pwsh=(Get-Process -Id $PID -ErrorAction Stop).Path
$helper=Join-Path $PSScriptRoot 'Verify-WebHostOwner.ps1';$wrapper=Join-Path $PSScriptRoot 'Invoke-WebSearchCutover.ps1'
foreach($path in @($pwsh,$helper,$wrapper)){$item=Get-Item -LiteralPath $path -Force -ErrorAction Stop;if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Maintenance component is unsafe.'};$parent=$item.Directory;while($parent){$p=Get-Item -LiteralPath $parent.FullName -Force -ErrorAction Stop;if($p.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Maintenance component parent is redirected.'};$parent=$parent.Parent}}
$dir=Join-Path $root 'runtime/maintenance';[void][IO.Directory]::CreateDirectory($dir);$item=Get-Item -LiteralPath $dir -Force;if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Maintenance directory is unsafe.'}
$runtimeItem=Get-Item -LiteralPath (Join-Path $root 'runtime') -Force;if($runtimeItem.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Runtime directory is unsafe.'}
if((Test-Path -LiteralPath (Join-Path $dir 'approved-host-helper.json')) -or (Test-Path -LiteralPath (Join-Path $dir 'route-policy.json'))){throw 'Maintenance approval already exists or is incomplete; inspection is required.'}
$helperDigest=(Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant();$wrapperDigest=(Get-FileHash -LiteralPath $wrapper -Algorithm SHA256).Hash.ToLowerInvariant();$pwshDigest=(Get-FileHash -LiteralPath $pwsh -Algorithm SHA256).Hash.ToLowerInvariant()
$items=@(@((Join-Path $dir 'approved-host-helper.json'),@{path=$helper;sha256=$helperDigest}),@((Join-Path $dir 'route-policy.json'),@{version=1;pwshPath=$pwsh;pwshSha256=$pwshDigest;wrapperSha256=$wrapperDigest}))
foreach($entry in $items){$bytes=[Text.Encoding]::UTF8.GetBytes(($entry[1]|ConvertTo-Json -Compress));$file=[IO.File]::Open($entry[0],[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$file.Write($bytes,0,$bytes.Length);$file.Flush($true)}finally{$file.Dispose()}}
Write-Output 'Host maintenance approvals created. Provision the separate ledger before enabling the route.'
}finally{if($launchLock){$launchLock.Dispose()}}
