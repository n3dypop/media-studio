#Requires -Version 7.0
param(
    [ValidateSet('All', 'DSH', 'ComfyUI')][string]$Service = 'All',
    [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'
$taskRoot = if ($env:MEDIA_STUDIO_HOME) { if (-not [IO.Path]::IsPathFullyQualified($env:MEDIA_STUDIO_HOME)) { throw 'MEDIA_STUDIO_HOME must be absolute' }; [IO.Path]::GetFullPath($env:MEDIA_STUDIO_HOME) } else { Split-Path $PSScriptRoot -Parent }
$settings = Get-Content -LiteralPath (Join-Path $taskRoot 'config\environment.json') -Raw -Encoding UTF8 | ConvertFrom-Json
. (Join-Path $PSScriptRoot 'DshLaunchLock.ps1')
$dshLaunchLock = $null

function Get-ProjectPath([string]$RelativePath) {
    $result = [IO.Path]::GetFullPath((Join-Path $taskRoot $RelativePath))
    if (-not $result.StartsWith($taskRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside the project: $RelativePath"
    }
    return $result
}

function Get-DshPath {
    if (-not [IO.Path]::IsPathFullyQualified([string]$settings.dshDirectory)) { return Get-ProjectPath $settings.dshDirectory }
    $repository = [IO.Path]::GetFullPath([string]$settings.dshRepositoryDirectory)
    $runtime = [IO.Path]::GetFullPath([string]$settings.dshDirectory)
    if (-not $runtime.StartsWith($repository+'\.runtime\host\',[StringComparison]::OrdinalIgnoreCase)) { throw 'DSH runtime must be inside its configured Git clone.' }
    if (-not (Test-Path -LiteralPath (Join-Path $repository '.git') -PathType Container)) { throw 'DSH Git clone is missing.' }
    $cursor=$runtime
    while ($cursor.Length -ge $repository.Length) {
        if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'DSH runtime cannot use redirected directories.' }
        $cursor=Split-Path $cursor -Parent
    }
    return $runtime
}
$dshRuntime=if ($Service -ne 'ComfyUI') { Get-DshPath }

function Test-LocalPort([int]$Port) {
    $client = [Net.Sockets.TcpClient]::new()
    try {
        $pending = $client.ConnectAsync('127.0.0.1', $Port)
        # Windows can take about two seconds to report a refused loopback connection.
        if (-not $pending.Wait(5000)) { throw "Timed out probing port $Port." }
        if (-not $client.Connected) { throw "Port $Port did not report a connection result." }
        return $true
    } catch {
        $cause = $_.Exception.GetBaseException()
        if ($cause -is [Net.Sockets.SocketException] -and $cause.SocketErrorCode -eq [Net.Sockets.SocketError]::ConnectionRefused) { return $false }
        throw "Cannot determine whether port $Port is free; process records were retained. $($cause.Message)"
    }
    finally { $client.Dispose() }
}

function Test-ServiceReady([string]$Name, [string]$BaseUrl, [string]$LogPath) {
    try {
        $healthUrl = $BaseUrl + '/system_stats'
        if ($Name -eq 'DSH') {
            $startupLog = Get-Content -LiteralPath $LogPath -Raw -Encoding UTF8 -ErrorAction Stop
            $launchMatch = [regex]::Match([string]$startupLog, [regex]::Escape($BaseUrl) + '/\?token=[A-Za-z0-9_-]+')
            if (-not $launchMatch.Success) { return $false }
            $healthUrl = $launchMatch.Value
        }
        return (Invoke-WebRequest -Uri $healthUrl -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop).StatusCode -eq 200
    } catch { return $false } # Authenticated URLs must not appear in errors.
}

$savedEnvironment = @{}
try {
    if (-not $ValidateOnly) {
        if ($Service -in @('All','DSH')) { $dshLaunchLock = Enter-DshLaunchLock $taskRoot; Assert-DefaultDshDesktopStopped }
        $childEnvironment = @{
            HF_HOME = Get-ProjectPath 'runtime/cache/huggingface'
            HF_HUB_OFFLINE = '1'
            TRANSFORMERS_OFFLINE = '1'
            PYTHONNOUSERSITE = '1'
            PYTHONUTF8 = '1'
        }
        if ($dshRuntime) {
            $childEnvironment += @{
                DSH_HOME = Get-ProjectPath $settings.dshHome
                DSH_TELEMETRY_MODE = 'DISABLED'
                DSH_TELEMETRY_DISABLED = '1'
                DSH_PERMISSION_MODE = 'workspace-write'
                NPM_CONFIG_USERCONFIG = Get-ProjectPath 'config/npmrc'
                NPM_CONFIG_CACHE = Get-ProjectPath 'runtime/cache/npm'
                PATH = (Get-ProjectPath $settings.nodeDirectory) + ';' + (Join-Path $dshRuntime 'node_modules/.bin') + ';' + $env:PATH
            }
        }
        foreach ($key in $childEnvironment.Keys) {
            $savedEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
            [Environment]::SetEnvironmentVariable($key, $childEnvironment[$key], 'Process')
        }
    }

    $selected = if ($Service -eq 'All') { @('ComfyUI', 'DSH') } else { @($Service) }
    foreach ($name in $selected) {
        if ($name -eq 'ComfyUI') {
            foreach ($field in @('comfyDirectory', 'comfyPythonExecutable', 'comfyUserDirectory', 'modelsDirectory', 'inputDirectory', 'outputDirectory')) {
                if (-not [IO.Path]::IsPathFullyQualified([string]$settings.$field)) { throw "ComfyUI setting must be an absolute path: $field" }
                $pathType = if ($field -eq 'comfyPythonExecutable') { 'Leaf' } else { 'Container' }
                if (-not (Test-Path -LiteralPath $settings.$field -PathType $pathType)) { throw "ComfyUI path missing: $($settings.$field)" }
            }
            $workingDirectory = [IO.Path]::GetFullPath($settings.comfyDirectory)
            $executable = [IO.Path]::GetFullPath($settings.comfyPythonExecutable)
            $entry = Join-Path $workingDirectory 'main.py'
            $port = [int]$settings.comfyPort
            $arguments = @('-s', $entry, '--disable-auto-launch', '--listen', '127.0.0.1', '--port', "$port", '--offline', '--enable-manager', '--models-directory', $settings.modelsDirectory, '--user-directory', $settings.comfyUserDirectory, '--input-directory', $settings.inputDirectory, '--output-directory', $settings.outputDirectory)
            # ComfyUI appends "temp" to this option. The configuration names the final folder.
            if (-not [IO.Path]::IsPathFullyQualified([string]$settings.tempDirectory)) { throw 'ComfyUI tempDirectory must be an absolute path.' }
            $tempDirectory = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($settings.tempDirectory))
            if ((Split-Path $tempDirectory -Leaf) -ne 'temp') { throw 'ComfyUI tempDirectory must name the final folder ending in temp.' }
            # ComfyUI owns the final directory and can remove it during cleanup.
            # Validate its parent and any existing entry without precreating it.
            if (-not (Test-Path -LiteralPath (Split-Path $tempDirectory -Parent) -PathType Container)) { throw 'ComfyUI tempDirectory parent is missing.' }
            $tempEntry = Get-Item -LiteralPath $tempDirectory -Force -ErrorAction SilentlyContinue
            if ($tempEntry -and (-not $tempEntry.PSIsContainer -or ($tempEntry.Attributes -band [IO.FileAttributes]::ReparsePoint))) { throw 'ComfyUI tempDirectory must be a regular directory.' }
            if ($tempDirectory -ne (Join-Path $workingDirectory 'temp')) {
                $arguments += @('--temp-directory', (Split-Path $tempDirectory -Parent))
            }
        } else {
            $workingDirectory = $taskRoot
            $executable = Join-Path (Get-ProjectPath $settings.nodeDirectory) 'node.exe'
            $entry = Join-Path $dshRuntime 'node_modules\@deepseek-ai\dsh\lib\bin.js'
            $port = [int]$settings.dshPort
            $arguments = @($entry, 'web', '--host', '127.0.0.1', '--port', "$port", '--no-open')
        }
        if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw "Runtime missing: $executable" }
        if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw "Entry point missing: $entry" }
        $url = "http://127.0.0.1:$port"
        if ($ValidateOnly) {
            [ordered]@{ service=$name; executable=$executable; workingDirectory=$workingDirectory; url=$url; arguments=$arguments; fileCheck='passed'; started=$false } | ConvertTo-Json -Depth 4
            continue
        }

        $statePath = Get-ProjectPath "runtime/$name.json"
        if (Test-Path -LiteralPath $statePath) {
            $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($state.executable -ne $executable) { throw "$name process record uses a different executable. Inspect $statePath before starting." }
            $existing = Get-Process -Id $state.processId -ErrorAction SilentlyContinue
            if ($null -ne $existing) {
                if (-not $existing.Path) { throw "$name process identity is unavailable. Inspect $statePath before starting." }
                if ($existing.Path -eq $executable -and $existing.StartTime.ToUniversalTime().Ticks.ToString() -eq $state.startTimeUtcTicks) {
                    if ($state.url -ne $url) { throw "$name is running with a different port. Stop it before changing configuration." }
                    if (-not (Test-ServiceReady $name $url $state.stdout)) { throw "$name process is running but its HTTP endpoint is not ready. Inspect its local logs; no new process was started." }
                    Write-Output "$name is already running and ready: $url (PID $($state.processId))"
                    continue
                }
                # A reused PID is never stopped. Clear its old record only if both old/new ports are idle.
            }
            if (Test-LocalPort ([uri]$state.url).Port) { throw "$name has a stale process record but its port is occupied. No process was changed." }
            if (Test-LocalPort $port) { throw "Port $port is occupied. No existing process was changed." }
            Remove-Item -LiteralPath $statePath
        }

        if (Test-LocalPort $port) { throw "Port $port is occupied. No existing process was changed." }
        if ($name -eq 'DSH') {
            # The public DSH API does not own permanent session disposal. Apply only
            # explicit, cancellable Session Library requests before any Host writer exists.
            $sessionDeletionHelper = if ($settings.dshPluginsDirectory) { Join-Path ([IO.Path]::GetFullPath([string]$settings.dshPluginsDirectory)) 'scripts/maintenance/Apply-SessionDeletions.mjs' } else { Get-ProjectPath 'scripts/maintenance/Apply-SessionDeletions.mjs' }
            if (-not (Test-Path -LiteralPath $sessionDeletionHelper -PathType Leaf)) { throw 'Session Library startup helper is missing.' }
            & $executable $sessionDeletionHelper --root $taskRoot
            if ($LASTEXITCODE -ne 0) { throw 'Session Library deletion check failed; DSH was not started.' }
        }
        $logDir = Get-ProjectPath ('logs/' + $name.ToLowerInvariant())
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
        New-Item -ItemType Directory -Path (Split-Path $statePath -Parent) -Force | Out-Null
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
        $outLog = Join-Path $logDir "$stamp.stdout.log"
        $errLog = Join-Path $logDir "$stamp.stderr.log"
        $nativeArguments = ($arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
        $process = Start-Process -FilePath $executable -ArgumentList $nativeArguments -WorkingDirectory $workingDirectory -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
        [ordered]@{ service=$name; processId=$process.Id; executable=$executable; startTimeUtcTicks=$process.StartTime.ToUniversalTime().Ticks.ToString(); url=$url; stdout=$outLog; stderr=$errLog } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
        $ready = $false
        $deadline = [DateTime]::UtcNow.AddSeconds(150)
        while ([DateTime]::UtcNow -lt $deadline) {
            $process.Refresh()
            if ($process.HasExited) {
                if ($name -ne 'DSH') { Get-Content -LiteralPath $errLog -Tail 35 -Encoding UTF8 | Write-Output }
                throw "$name exited during startup (code $($process.ExitCode)). Logs: $logDir"
            }
            if (Test-ServiceReady $name $url $outLog) { $ready = $true; break }
            Start-Sleep -Milliseconds 500
        }
        if (-not $ready) { throw "$name did not become ready. Process retained for diagnosis; logs: $logDir" }
        Write-Output "$name ready: $url (PID $($process.Id))"
        if ($name -eq 'DSH') { Write-Output 'Open the authorized browser session with Open-DSH.cmd.' }
    }
} finally {
    if ($dshLaunchLock) { $dshLaunchLock.Dispose() }
    foreach ($key in $savedEnvironment.Keys) {
        if ($null -eq $savedEnvironment[$key]) {
            Remove-Item -LiteralPath ("Env:\" + $key) -ErrorAction SilentlyContinue
        } else {
            [Environment]::SetEnvironmentVariable($key, $savedEnvironment[$key], 'Process')
        }
    }
}
