#Requires -Version 7.4
param([switch]$Apply)
$ErrorActionPreference='Stop'
$root=if ($env:MEDIA_STUDIO_HOME) { if (-not [IO.Path]::IsPathFullyQualified($env:MEDIA_STUDIO_HOME)) { throw 'MEDIA_STUDIO_HOME must be absolute' }; [IO.Path]::GetFullPath($env:MEDIA_STUDIO_HOME) } else { [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..')) }
$locks=@()
try {
    # These are the same locks held by the production start/stop scripts.
    foreach($name in @('Strata','Controller')) {
        $locks += [IO.File]::Open((Join-Path $root "runtime/$name-launch.lock"),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    }
    $oldMarker=$env:LOCAL_MEDIA_RECOVERY_LOCKS
    $env:LOCAL_MEDIA_RECOVERY_LOCKS='held-by-Repair-RebootGate'
    try {
        . (Join-Path $PSScriptRoot '../Service-Paths.ps1')
        $environment=Get-Content -LiteralPath (Join-Path $root 'config/environment.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        $node=Get-ControllerNodeExecutable $root $environment
        [void](Test-ControllerNodeRuntime $node)
        $argsList=@('--disable-warning=ExperimentalWarning',(Join-Path $PSScriptRoot 'repair-reboot-gate.mjs'))
        if($Apply) { $argsList+='--apply' }
        & $node @argsList
        if($LASTEXITCODE -ne 0){throw 'Reboot reconciliation failed; check the output above.'}
    } finally { $env:LOCAL_MEDIA_RECOVERY_LOCKS=$oldMarker }
} finally { foreach($lock in $locks){$lock.Dispose()} }
