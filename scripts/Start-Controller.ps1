#Requires -Version 7.0
param([switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
$taskRoot = if ($env:MEDIA_STUDIO_HOME) { if (-not [IO.Path]::IsPathFullyQualified($env:MEDIA_STUDIO_HOME)) { throw 'MEDIA_STUDIO_HOME must be absolute' }; [IO.Path]::GetFullPath($env:MEDIA_STUDIO_HOME) } else { Split-Path $PSScriptRoot -Parent }
function Assert-NoControllerPreopenGuard {
    $path=Join-Path $taskRoot 'runtime/maintenance/controller-cutover-preopen.json'
    try { $null=Get-Item -LiteralPath $path -Force -ErrorAction Stop }
    catch [System.Management.Automation.ItemNotFoundException] { return }
    throw 'Controller cutover recovery is pending; preserve the database and backup.'
}
Assert-NoControllerPreopenGuard
$environment = Get-Content -LiteralPath (Join-Path $taskRoot 'config/environment.json') -Raw -Encoding UTF8 | ConvertFrom-Json
. (Join-Path $PSScriptRoot 'Service-Paths.ps1')
$settings = Get-Content -LiteralPath (Join-Path $taskRoot 'config/controller.json') -Raw -Encoding UTF8 | ConvertFrom-Json

function Get-ProjectPath([string]$RelativePath) {
    $result = [IO.Path]::GetFullPath((Join-Path $taskRoot $RelativePath))
    if (-not $result.StartsWith($taskRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Controller path is outside the project: $RelativePath"
    }
    return $result
}

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
        throw "Cannot determine whether port $Port is free. Process records were retained."
    } finally { $client.Dispose() }
}

function Get-ControllerHealth([string]$BaseUrl, [int]$ExpectedPid) {
    try {
        $health = Invoke-RestMethod -Uri ($BaseUrl + '/health') -TimeoutSec 2
        if ($health.service -eq 'local-image-controller' -and $health.ready -eq $true -and [int]$health.pid -eq $ExpectedPid) { return $health }
    } catch { }
    return $null
}

function Write-ControllerState($State, [string]$Path) {
    $temporary = "$Path.$([guid]::NewGuid().ToString('N')).partial"
    try {
        $State | ConvertTo-Json | Set-Content -LiteralPath $temporary -Encoding utf8
        [IO.File]::Move($temporary, $Path, $true)
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
    }
}

$port = [int]$settings.port
if ($port -lt 1024 -or $port -gt 65535) { throw 'Controller port must be between 1024 and 65535.' }
if ($port -eq [int]$environment.dshPort -or $port -eq [int]$environment.comfyPort) { throw 'Controller port must differ from DSH and ComfyUI.' }
$url = "http://127.0.0.1:$port"
$executable = Get-ControllerNodeExecutable $taskRoot $environment
$entry = Join-Path (Split-Path $PSScriptRoot -Parent) 'apps/controller/server.mjs'
foreach ($path in @($executable, $entry)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Controller runtime or entry point is missing: $path" }
}
$nodeRuntime = Test-ControllerNodeRuntime $executable
if ($ValidateOnly) {
    [ordered]@{ service='Controller'; executable=$executable; nodeVersion=$nodeRuntime.version; entry=$entry; workingDirectory=$taskRoot; url=$url; fileCheck='passed'; started=$false } | ConvertTo-Json
    return
}

$statePath = Get-ProjectPath 'runtime/Controller.json'
$lockPath = Get-ProjectPath 'runtime/Controller-launch.lock'
New-Item -ItemType Directory -Path (Split-Path $statePath -Parent) -Force | Out-Null
$launchLock = $null
try {
    try { $launchLock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch { throw 'Another Controller launch or shutdown is in progress. No new process was started.' }
    Assert-NoControllerPreopenGuard

    if (Test-Path -LiteralPath $statePath) {
        $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($state.executable -ne $executable) { throw 'Controller process record differs from the configured executable. No process was changed.' }
        $existing = Get-Process -Id $state.processId -ErrorAction SilentlyContinue
        if ($null -ne $existing) {
            if (-not $existing.Path) { throw 'Controller process identity is unavailable in this terminal. Its process record was retained.' }
            if ($existing.Path -eq $executable -and $existing.StartTime.ToUniversalTime().Ticks.ToString() -eq $state.startTimeUtcTicks) {
                if ($state.url -ne $url) { throw 'Controller is running with a different port. Stop it before changing configuration.' }
                $health = Get-ControllerHealth $url $existing.Id
                if ($null -eq $health) { throw 'Controller process is running but is not ready. Inspect logs/controller. No new process was started.' }
                if ($state.controllerId -and $state.controllerId -ne $health.controllerId) { throw 'Controller identity differs from its process record. No process was changed.' }
                Write-Output "Controller is already ready: $url (PID $($existing.Id))"
                return
            }
        }
        $oldUri = [uri]$state.url
        if ($oldUri.Scheme -ne 'http' -or $oldUri.Host -ne '127.0.0.1') { throw 'Controller process record contains an unexpected address.' }
        if (Test-LocalPort $oldUri.Port) { throw 'Controller port is occupied but its process identity cannot be verified. No process was changed.' }
        if (Test-LocalPort $port) { throw "Port $port is occupied. No process was changed." }
        Remove-Item -LiteralPath $statePath
    }
    if (Test-LocalPort $port) { throw "Port $port is occupied. No existing process was changed." }

    $logDir = Get-ProjectPath 'logs/controller'
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $outLog = Join-Path $logDir "$stamp.stdout.log"
    $errLog = Join-Path $logDir "$stamp.stderr.log"
    $arguments = '--disable-warning=ExperimentalWarning "' + $entry + '"'
    $oldNodeOptions=[Environment]::GetEnvironmentVariable('NODE_OPTIONS','Process')
    try {
        [Environment]::SetEnvironmentVariable('NODE_OPTIONS',$null,'Process')
        $process = Start-Process -FilePath $executable -ArgumentList $arguments -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
    } finally { [Environment]::SetEnvironmentVariable('NODE_OPTIONS',$oldNodeOptions,'Process') }
    $state = [ordered]@{ service='Controller'; processId=$process.Id; executable=$executable; startTimeUtcTicks=$process.StartTime.ToUniversalTime().Ticks.ToString(); url=$url; stdout=$outLog; stderr=$errLog }
    Write-ControllerState $state $statePath
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    $health = $null
    while ([DateTime]::UtcNow -lt $deadline) {
        $process.Refresh()
        if ($process.HasExited) { throw "Controller exited during startup (code $($process.ExitCode)). Inspect $logDir." }
        $health = Get-ControllerHealth $url $process.Id
        if ($null -ne $health) { break }
        Start-Sleep -Milliseconds 250
    }
    if ($null -eq $health) { throw "Controller did not become ready. Process retained for diagnosis; logs: $logDir" }
    $state.controllerId = [string]$health.controllerId
    Write-ControllerState $state $statePath
    Write-Output "Controller ready: $url (PID $($process.Id))"
    Write-Output 'The controller runs in the background; use media-studio in DSH.'
} finally {
    if ($null -ne $launchLock) { $launchLock.Dispose() }
}
