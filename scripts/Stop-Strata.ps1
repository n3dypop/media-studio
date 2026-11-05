#Requires -Version 7.4
$ErrorActionPreference='Stop'
$taskRoot=if ($env:MEDIA_STUDIO_HOME) { if (-not [IO.Path]::IsPathFullyQualified($env:MEDIA_STUDIO_HOME)) { throw 'MEDIA_STUDIO_HOME must be absolute' }; [IO.Path]::GetFullPath($env:MEDIA_STUDIO_HOME) } else { [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent)) }
$statePath=Join-Path $taskRoot 'runtime/Strata.json'
if (-not (Test-Path -LiteralPath $statePath)) { Write-Output 'Strata has no managed process record.'; return }
function PortOpen([int]$Port) {
    $client=[Net.Sockets.TcpClient]::new()
    try { $pending=$client.ConnectAsync('127.0.0.1',$Port); if (-not $pending.Wait(3000)) { throw 'Port probe timed out.' }; return $client.Connected }
    catch { $cause=$_.Exception.GetBaseException(); if ($cause -is [Net.Sockets.SocketException] -and $cause.SocketErrorCode -eq [Net.Sockets.SocketError]::ConnectionRefused) { return $false }; throw 'Unable to determine local port ownership.' }
    finally { $client.Dispose() }
}
function GetStatus {
    $value=Invoke-RestMethod -Uri 'http://127.0.0.1:8190/v1/status' -Headers @{Authorization=('Bearer '+$token)} -TimeoutSec 5
    if ($value.service -ne 'strata' -or $value.model -ne 'qwen3.8-flash-next' -or $value.started -ne $saved.started -or $value.loaded -isnot [bool] -or $null -eq $value.activity.in_flight) { throw 'Strata identity or epoch differs. No process stopped.' }
    return $value
}
$launchLock=$null; $controllerLock=$null; $token=$null
try {
    $launchLock=[IO.File]::Open((Join-Path $taskRoot 'runtime/Strata-launch.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    $controllerLock=[IO.File]::Open((Join-Path $taskRoot 'runtime/Controller-launch.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    $saved=Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    . (Join-Path $PSScriptRoot 'Service-Paths.ps1')
    $environment=Get-Content -LiteralPath (Join-Path $taskRoot 'config/environment.json') -Raw | ConvertFrom-Json
    $receipt=Get-Content -LiteralPath (Join-Path $taskRoot 'data/strata/installation.json') -Raw | ConvertFrom-Json
    if ($receipt.workspace -ne $taskRoot -or -not $receipt.productRoot -or -not $receipt.prepared) { throw 'Strata installation identity differs.' }
    $expected=Get-StrataPythonExecutable $environment $receipt
    if ($saved.workspace -ne $taskRoot -or $saved.executable -ne $expected -or $saved.url -ne 'http://127.0.0.1:8190') { throw 'Strata process record does not belong to this installation.' }
    $process=Get-Process -Id $saved.processId -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        if (PortOpen 8190) { throw 'Strata port is occupied without its managed process. Record retained.' }
        throw 'The recorded Strata API process is absent, but engine/image-reader cleanup is unknown. Record retained for resource reconciliation; no process was stopped.'
    }
    if (-not $process.Path -or $process.Path -ne $expected -or $process.StartTime.ToUniversalTime().Ticks.ToString() -ne $saved.startTimeUtcTicks -or -not $saved.ready -or -not $saved.started) { throw 'Managed Strata ownership/startup could not be verified. Process retained.' }
    $readyPath=[IO.Path]::GetFullPath([string]$saved.readyPath)
    $allowedReadyRoot=(Join-Path $taskRoot 'data/strata/runtime')+[IO.Path]::DirectorySeparatorChar
    if (-not $readyPath.StartsWith($allowedReadyRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected Strata ready record path.' }
    $ready=Get-Content -LiteralPath $readyPath -Raw | ConvertFrom-Json
    if ($ready.instance_id -ne $saved.instanceId -or [int]$ready.pid -ne $process.Id) { throw 'Strata ready record ownership changed.' }
    # A live controller can admit a new request immediately after a status check.
    # Require it stopped and hold its launch lock throughout this shutdown.
    $controllerCfg=Get-Content -LiteralPath (Join-Path $taskRoot 'config/controller.json') -Raw | ConvertFrom-Json
    if (PortOpen ([int]$controllerCfg.port)) { throw 'Controller is running. Stop it with Stop-Controller.cmd after its active work is resolved, then stop Strata.' }
    $controllerState=Join-Path $taskRoot 'runtime/Controller.json'
    if (Test-Path -LiteralPath $controllerState) {
        $record=Get-Content -LiteralPath $controllerState -Raw | ConvertFrom-Json
        if ($null -ne (Get-Process -Id $record.processId -ErrorAction SilentlyContinue)) { throw 'Controller process remains present; resolve it before stopping Strata.' }
    }
    $db=Join-Path $taskRoot 'data/controller/controller.db'
    if (Test-Path -LiteralPath $db) {
        $envConfig=Get-Content -LiteralPath (Join-Path $taskRoot 'config/environment.json') -Raw | ConvertFrom-Json
        $node=Get-ControllerNodeExecutable $taskRoot $envConfig
        [void](Test-ControllerNodeRuntime $node)
        $check=@'
import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync(process.argv[2],{readOnly:true});
try {
  const active=db.prepare("SELECT count(*) n FROM runs WHERE phase NOT IN ('completed','failed','cancelled')").get().n;
  const row=db.prepare("SELECT value FROM meta WHERE key='resourceGate'").get();
  const gate=row?JSON.parse(row.value):null;
  if(active || (gate && (gate.activeCore!==0 || gate.generationRunId || gate.blocked || !['none','core'].includes(gate.owner)))) {
    console.error('Controller has active or unresolved GPU ownership. Resolve it in the controller first.');process.exitCode=3;
  }
} finally {db.close();}
'@
        $check | & $node --disable-warning=ExperimentalWarning --input-type=module - $db
        if ($LASTEXITCODE -ne 0) { throw 'Controller journal did not confirm an idle, resolved resource gate. Strata retained.' }
    }
    $token=([IO.File]::ReadAllText((Join-Path $taskRoot 'data/strata/api-token'))).Trim()
    if ($token -notmatch '^[a-f0-9]{64}$') { throw 'Strata API token is invalid.' }
    $status=GetStatus
    if ($status.activity.in_flight -ne 0) { throw 'Strata has running or queued inference. No unload or stop requested.' }
    if ($status.loaded) {
        $reply=Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8190/v1/unload' -Headers @{Authorization=('Bearer '+$token)} -ContentType 'application/json' -Body '{"model":"qwen3.8-flash-next"}' -TimeoutSec 30
        if ($reply.status -notin @('unloaded','not loaded') -or $reply.loaded -ne $false -or $reply.activity.in_flight -ne 0 -or $reply.started -ne $saved.started) { throw 'Strata unload was not confirmed. Process retained.' }
    }
    $status=GetStatus
    if ($status.loaded -or $status.activity.in_flight -ne 0) { throw 'Strata became busy or reloaded; process retained.' }
    # The model and image reader have been released; terminate only the exact API process.
    $process.Refresh()
    if ($process.StartTime.ToUniversalTime().Ticks.ToString() -ne $saved.startTimeUtcTicks) { throw 'Strata PID identity changed before stop.' }
    $process.Kill()
    if (-not $process.WaitForExit(10000)) { throw 'Strata API process did not exit. Record retained.' }
    if (PortOpen 8190) { throw 'Strata exited but port 8190 is occupied. Record retained.' }
    if (Test-Path -LiteralPath $readyPath) { Remove-Item -LiteralPath $readyPath }
    Remove-Item -LiteralPath $statePath
    Write-Output "Managed Strata stopped (PID $($process.Id)); model unload confirmed."
} finally { $token=$null; if ($null -ne $controllerLock) { $controllerLock.Dispose() }; if ($null -ne $launchLock) { $launchLock.Dispose() } }
