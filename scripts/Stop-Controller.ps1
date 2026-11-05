#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
$taskRoot = if ($env:MEDIA_STUDIO_HOME) { if (-not [IO.Path]::IsPathFullyQualified($env:MEDIA_STUDIO_HOME)) { throw 'MEDIA_STUDIO_HOME must be absolute' }; [IO.Path]::GetFullPath($env:MEDIA_STUDIO_HOME) } else { Split-Path $PSScriptRoot -Parent }
$environment = Get-Content -LiteralPath (Join-Path $taskRoot 'config/environment.json') -Raw -Encoding UTF8 | ConvertFrom-Json
. (Join-Path $PSScriptRoot 'Service-Paths.ps1')
$expectedExecutable = Get-ControllerNodeExecutable $taskRoot $environment
$statePath = Join-Path $taskRoot 'runtime/Controller.json'
if (-not (Test-Path -LiteralPath $statePath)) { Write-Output 'Controller has no managed process record.'; return }

function Test-LocalPort([int]$Port) {
    $client = [Net.Sockets.TcpClient]::new()
    try {
        $pending = $client.ConnectAsync('127.0.0.1', $Port)
        if (-not $pending.Wait(5000)) { throw "Timed out probing port $Port." }
        if (-not $client.Connected) { throw "Port $Port did not report a connection result." }
        return $true
    } catch {
        $cause = $_.Exception.GetBaseException()
        if ($cause -is [Net.Sockets.SocketException] -and $cause.SocketErrorCode -eq [Net.Sockets.SocketError]::ConnectionRefused) { return $false }
        throw 'Cannot determine whether Controller is stopped. Its process record was retained.'
    } finally { $client.Dispose() }
}

$launchLock = $null
$token = $null
try {
    try { $launchLock = [IO.File]::Open((Join-Path $taskRoot 'runtime/Controller-launch.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch { throw 'Another Controller launch or shutdown is in progress.' }
    if (-not (Test-Path -LiteralPath $statePath)) { Write-Output 'Controller is already stopped.'; return }
    $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($state.executable -ne $expectedExecutable) { throw 'Controller process record differs from the configured executable. No process was stopped.' }
    $uri = [uri]$state.url
    if ($uri.Scheme -ne 'http' -or $uri.Host -ne '127.0.0.1') { throw 'Controller process record contains an unexpected address.' }
    $process = Get-Process -Id $state.processId -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        if (Test-LocalPort $uri.Port) { throw 'Controller is reachable but its process identity cannot be verified in this terminal. Its process record was retained.' }
        Remove-Item -LiteralPath $statePath
        Write-Output 'Controller is already stopped.'
        return
    }
    if (-not $process.Path -or $process.Path -ne $expectedExecutable -or $process.StartTime.ToUniversalTime().Ticks.ToString() -ne $state.startTimeUtcTicks) {
        throw "Refusing to stop an unverified or different process using PID $($state.processId)."
    }
    try { $health = Invoke-RestMethod -Uri ($state.url + '/health') -TimeoutSec 3 }
    catch { throw 'Controller is running but its health endpoint is unavailable. Process retained; inspect logs/controller.' }
    if ($health.service -ne 'local-image-controller' -or $health.ready -ne $true -or [int]$health.pid -ne $process.Id -or ($state.controllerId -and $state.controllerId -ne $health.controllerId)) {
        throw 'Controller health identity differs from its process record. No process was stopped.'
    }
    try { $token = (Get-Content -LiteralPath (Join-Path $taskRoot 'data/controller/auth-token') -Raw -Encoding UTF8).Trim() }
    catch { throw 'Controller authentication token is unavailable. No process was stopped.' }
    if ($token -notmatch '^[a-f0-9]{64}$') { throw 'Controller authentication token is invalid. No process was stopped.' }
    try {
        Invoke-RestMethod -Method Post -Uri ($state.url + '/api/shutdown') -Headers @{ Authorization=('Bearer ' + $token) } -ContentType 'application/json' -Body '{}' -TimeoutSec 5 | Out-Null
    } catch {
        if ([int]$_.Exception.Response.StatusCode -eq 409) { throw 'Controller has an active or unresolved run. Resolve or stop it through the managed DSH interface before shutting down.' }
        throw 'Controller declined shutdown or its response was unavailable. No process was forcibly stopped; inspect logs/controller.'
    }
    if (-not $process.WaitForExit(10000)) { throw 'Controller has not exited after its shutdown request. Process retained for diagnosis.' }
    if (Test-LocalPort $uri.Port) { throw 'The old Controller exited but its port remains occupied. Its process record was retained for inspection.' }
    Remove-Item -LiteralPath $statePath
    Write-Output "Controller stopped (PID $($process.Id))."
} finally {
    $token = $null
    if ($null -ne $launchLock) { $launchLock.Dispose() }
}
