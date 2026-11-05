#Requires -Version 7.4
$ErrorActionPreference='Stop'
$taskRoot=if ($env:MEDIA_STUDIO_HOME) { if (-not [IO.Path]::IsPathFullyQualified($env:MEDIA_STUDIO_HOME)) { throw 'MEDIA_STUDIO_HOME must be absolute' }; [IO.Path]::GetFullPath($env:MEDIA_STUDIO_HOME) } else { [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent)) }
$record=Join-Path $taskRoot 'runtime/RustXNG.json'
if(-not(Test-Path -LiteralPath $record)){Write-Output 'RustXNG has no managed process';return}
$lock=[IO.File]::Open((Join-Path $taskRoot 'runtime/RustXNG-launch.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try{
    foreach($grant in @(Get-ChildItem -LiteralPath (Join-Path $taskRoot 'data/search') -Filter '*.json' -File -ErrorAction SilentlyContinue)){if((Get-Content -LiteralPath $grant.FullName -Raw|ConvertFrom-Json).phase -eq 'running'){throw 'Cancel the active search and wait for its terminal state first'}}
    $saved=Get-Content -LiteralPath $record -Raw|ConvertFrom-Json
    $configuration=Get-Content -LiteralPath (Join-Path $taskRoot 'config/rustxng.json') -Raw|ConvertFrom-Json
    $expected=[IO.Path]::GetFullPath($configuration.executable,$taskRoot)
    if($saved.workspace -ne $taskRoot -or $saved.executable -ne $expected){throw 'RustXNG management identity differs'}
    $process=Get-Process -Id $saved.processId -ErrorAction Stop
    if($process.Path -ne $saved.executable -or $process.StartTime.ToUniversalTime().Ticks.ToString() -ne $saved.startTimeUtcTicks){throw 'RustXNG process ownership differs'}
    Stop-Process -Id $process.Id -ErrorAction Stop
    if(-not $process.WaitForExit(5000)){throw 'RustXNG stop was not confirmed'}
    if(@(Get-NetTCPConnection -State Listen -LocalPort 29483 -ErrorAction SilentlyContinue).Count){throw 'RustXNG port is still occupied; record retained'}
    Remove-Item -LiteralPath $record
    Write-Output 'Managed RustXNG stopped'
}finally{$lock.Dispose()}
