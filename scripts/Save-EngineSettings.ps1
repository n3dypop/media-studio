#Requires -Version 7.4
param([Parameter(Mandatory)][ValidateSet('Strata','ComfyUI')][string]$Engine,
      [Parameter(Mandatory)][string]$RuntimeRoot)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Service-Paths.ps1')
$root=[IO.Path]::GetFullPath($RuntimeRoot)
$settings=Get-Content -LiteralPath (Join-Path $root 'config/environment.json') -Raw | ConvertFrom-Json
$node=Get-ControllerNodeExecutable $root $settings
$module=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../apps/dsh-plugins/studio-services/engine-settings.mjs'))
$body=[Console]::In.ReadToEnd()
$lockPath=Join-Path $root "runtime/$Engine-launch.lock"
if((Test-Path -LiteralPath $lockPath) -and ((Get-Item -LiteralPath $lockPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){
    throw 'Engine launch lock is redirected.'
}
try {
    $lock=[IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
} catch [IO.IOException] {
    '{"status":409,"error":"サービスの起動・停止が進行中です。完了後に再読込してください。"}'
    exit
}
try {
    $body | & $node $module $Engine $root
    if($LASTEXITCODE){throw 'Engine settings writer failed.'}
} finally {
    $lock.Dispose()
}
