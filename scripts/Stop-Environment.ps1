#Requires -Version 7.0
param([ValidateSet('All', 'DSH', 'ComfyUI')][string]$Service = 'All')
$ErrorActionPreference = 'Stop'
$taskRoot = if ($env:MEDIA_STUDIO_HOME) { if (-not [IO.Path]::IsPathFullyQualified($env:MEDIA_STUDIO_HOME)) { throw 'MEDIA_STUDIO_HOME must be absolute' }; [IO.Path]::GetFullPath($env:MEDIA_STUDIO_HOME) } else { Split-Path $PSScriptRoot -Parent }
$settings = Get-Content -LiteralPath (Join-Path $taskRoot 'config\environment.json') -Raw -Encoding UTF8 | ConvertFrom-Json
# Resolve the controller first; its shutdown API refuses active or uncertain runs.
# This also prevents stopping DSH first and only later discovering a busy generator.
if ($Service -in @('All', 'ComfyUI') -and (Test-Path -LiteralPath (Join-Path $taskRoot 'runtime/Controller.json'))) {
    & (Join-Path $PSScriptRoot 'Stop-Controller.ps1')
}
$selected = if ($Service -eq 'All') { @('DSH', 'ComfyUI') } else { @($Service) }
foreach ($name in $selected) {
    $statePath = Join-Path $taskRoot "runtime\$name.json"
    if (-not (Test-Path -LiteralPath $statePath)) { Write-Output "$name has no managed process record"; continue }
    $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($name -eq 'ComfyUI') {
        if (-not [IO.Path]::IsPathFullyQualified([string]$settings.comfyPythonExecutable)) { throw 'ComfyUI executable must be an absolute path.' }
        $expectedExecutable = [IO.Path]::GetFullPath($settings.comfyPythonExecutable)
    } else {
        $expectedExecutable = [IO.Path]::GetFullPath((Join-Path $taskRoot (Join-Path $settings.nodeDirectory 'node.exe')))
        if (-not $expectedExecutable.StartsWith($taskRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'DSH executable must be inside this project.' }
    }
    if ($state.executable -ne $expectedExecutable) { throw "$name process record does not match the configured executable. Inspect $statePath before stopping." }
    $process = Get-Process -Id $state.processId -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        $reachable = $false
        $client = [Net.Sockets.TcpClient]::new()
        try {
            $port = ([uri]$state.url).Port
            $pending = $client.ConnectAsync('127.0.0.1', $port)
            # Windows can take about two seconds to report a refused loopback connection.
            if (-not $pending.Wait(5000)) { throw "Timed out probing port $port." }
            if (-not $client.Connected) { throw "Port $port did not report a connection result." }
            $reachable = $true
        } catch {
            $cause = $_.Exception.GetBaseException()
            if (-not ($cause -is [Net.Sockets.SocketException] -and $cause.SocketErrorCode -eq [Net.Sockets.SocketError]::ConnectionRefused)) {
                throw "Cannot determine whether $name is stopped; its process record was retained. $($cause.Message)"
            }
        }
        finally { $client.Dispose() }
        if ($reachable) { throw "$name is reachable, but its process identity cannot be verified in this terminal. Use the terminal that started it." }
        Remove-Item -LiteralPath $statePath
        Write-Output "$name is already stopped"
        continue
    }
    if ($process.Path -ne $expectedExecutable -or $process.StartTime.ToUniversalTime().Ticks.ToString() -ne $state.startTimeUtcTicks) {
        throw "Refusing to stop a different process using PID $($state.processId)."
    }
    if ($name -eq 'ComfyUI') {
        $queue = Invoke-RestMethod -Uri ($state.url + '/queue') -TimeoutSec 5
        if (@($queue.queue_running).Count -gt 0 -or @($queue.queue_pending).Count -gt 0) {
            throw 'ComfyUI has active or queued jobs. Stop them in ComfyUI before shutting down.'
        }
    }
    # This baseline shutdown is for idle services. It is not the future generation controller.
    $process.Kill($true)
    if (-not $process.WaitForExit(10000)) { throw "$name did not exit after stopping its process tree." }
    Remove-Item -LiteralPath $statePath
    Write-Output "$name stopped (PID $($process.Id))"
}
