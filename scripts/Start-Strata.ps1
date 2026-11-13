#Requires -Version 7.4
param([switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
$taskRoot = if ($env:MEDIA_STUDIO_HOME) { if (-not [IO.Path]::IsPathFullyQualified($env:MEDIA_STUDIO_HOME)) { throw 'MEDIA_STUDIO_HOME must be absolute' }; [IO.Path]::GetFullPath($env:MEDIA_STUDIO_HOME) } else { [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent)) }
function ProjectPath([string]$Relative) {
    $p = [IO.Path]::GetFullPath((Join-Path $taskRoot $Relative))
    if (-not $p.StartsWith($taskRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Strata path escapes workspace.' }
    $cursor=$p
    while ($cursor -and $cursor -ne $taskRoot) {
        if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Strata path is a reparse point: $cursor" }
        $cursor=Split-Path $cursor -Parent
    }
    return $p
}
function PortOpen([int]$Port) {
    $client=[Net.Sockets.TcpClient]::new()
    try { $pending=$client.ConnectAsync('127.0.0.1',$Port); if (-not $pending.Wait(3000)) { throw 'Port probe timed out.' }; return $client.Connected }
    catch { $cause=$_.Exception.GetBaseException(); if ($cause -is [Net.Sockets.SocketException] -and $cause.SocketErrorCode -eq [Net.Sockets.SocketError]::ConnectionRefused) { return $false }; throw 'Unable to determine local port ownership.' }
    finally { $client.Dispose() }
}
function ProductPath([string]$Relative) {
    $p=[IO.Path]::GetFullPath((Join-Path $productRoot $Relative))
    if (-not $p.StartsWith($productRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Strata path escapes the named product directory.' }
    $cursor=$p
    while ($cursor -and $cursor.Length -ge $productRoot.Length) {
        if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Strata product path is a reparse point.' }
        $cursor=Split-Path $cursor -Parent
    }
    return $p
}
function WriteState($Value,[string]$Path) {
    $temporary="$Path.$([guid]::NewGuid().ToString('N')).partial"
    [IO.File]::WriteAllText($temporary,($Value | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
    [IO.File]::Move($temporary,$Path,$true)
}
function Status {
    $status=Invoke-RestMethod -Uri ($url+'/v1/status') -Headers @{Authorization=('Bearer '+$token)} -TimeoutSec 3
    if ($status.service -ne 'strata' -or $status.model -ne 'qwen3.8-flash-next' -or $status.started -lt 1 -or $status.activity.in_flight -lt 0 -or $null -eq $status.activity.in_flight -or $status.loaded -isnot [bool]) { throw 'Unexpected Strata status contract.' }
    return $status
}
$receiptPath=ProjectPath 'data/strata/installation.json'
if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) { throw 'Strata is not prepared. Run the approved Install-Strata.ps1 -Install first.' }
$receipt=Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
. (Join-Path $PSScriptRoot 'Service-Paths.ps1')
$environment=Get-Content -LiteralPath (ProjectPath 'config/environment.json') -Raw | ConvertFrom-Json
$productRoot=[IO.Path]::GetFullPath([string]$(if ($environment.strataDirectory) { $environment.strataDirectory } else { $receipt.productRoot }))
$control=ProductPath ([IO.Path]::GetRelativePath($productRoot,[string]$receipt.control))
$engine=ProductPath ([IO.Path]::GetRelativePath($productRoot,[string]$receipt.engine))
if (-not $control.StartsWith((Join-Path $productRoot '.runtime/terminal/') ,[StringComparison]::OrdinalIgnoreCase) -or -not $engine.StartsWith((Join-Path $productRoot '.runtime/components/engine/'),[StringComparison]::OrdinalIgnoreCase)) { throw 'Strata component paths differ from the prepared product layout.' }
$data=ProjectPath 'data/strata'
$executable=Get-StrataPythonExecutable $environment $receipt
$configuration=if ($receipt.config -eq (Join-Path $data 'serve-config.json')) {
    Join-Path $data 'serve-config.json'
} else {
    ProductPath '.runtime/local-serve/serve-config.json'
}
. (Join-Path $PSScriptRoot 'Strata-ConfigComparison.ps1')
if ($receipt.workspace -ne $taskRoot -or $receipt.productRoot -ne $productRoot -or $receipt.control -ne $control -or $receipt.engine -ne $engine -or $receipt.config -ne $configuration -or $receipt.mtp -ne 'off' -or -not $receipt.prepared) { throw 'Installation identity does not match this workspace and product root.' }
foreach ($path in @($executable,$configuration,(Join-Path $control 'serve/server.py'),(Join-Path $engine 'engine-component.json'),(Join-Path $data 'api-token'))) { if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Strata required file is missing: $path" } }
$desiredHash=(Get-FileHash -LiteralPath $configuration -Algorithm SHA256).Hash.ToLowerInvariant()
$desiredReceiptHash=(Get-FileHash -LiteralPath $receiptPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($desiredHash -ne $receipt.configSha256) { throw 'Strata configuration changed after preparation; review it before starting.' }
$cfg=Get-Content -LiteralPath $configuration -Raw | ConvertFrom-Json
if ($cfg.host -ne '127.0.0.1' -or $cfg.port -ne 8190 -or $cfg.model_name -ne 'qwen3.8-flash-next' -or $cfg.mtp -ne $false -or $cfg.lazy_load -ne $true -or $cfg.parallel -ne 1) { throw 'Unexpected Strata isolation settings.' }
$espValidated=$false
if ($receipt.esp -and $receipt.esp.configured -eq $true) {
    # The source checkout can be updated independently of this managed runtime.
    # Re-verify the exact pinned control vector before admitting a future launch.
    $vector=ProductPath 'data/experimental-speed-projection/Qwen3.8-Flash-Next-experimental-speed-projection.gguf'
    $expectedHash='ef0724c5b79297e481017be85769832bc26eb220c984ecba2b0e1b0c8426312b'
    if ($receipt.esp.vectorPath -ne $vector -or $receipt.esp.vectorSha256 -ne $expectedHash -or -not (Test-Path -LiteralPath $vector -PathType Leaf)) { throw 'ESP vector identity is missing or differs; no service was started.' }
    if ((Get-Item -LiteralPath $vector).Length -ne 483520 -or (Get-FileHash -LiteralPath $vector -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) { throw 'ESP vector content differs; no service was started.' }
    $argsList=@($cfg.args)
    $expectedESP=@('--control-vector-scaled',($vector+':1.0'),'--control-vector-layer-range','4','44','--cvec-mode','project','--cvec-dir','per-layer')
    if ($argsList.Count -lt $expectedESP.Count -or (@($argsList | Where-Object { $_ -match '^--(?:control-vector(?:-|=|$)|cvec(?:-|=|$))' }).Count -ne 4)) { throw 'ESP engine flags differ; no service was started.' }
    $offset=$argsList.Count-$expectedESP.Count
    for($i=0;$i -lt $expectedESP.Count;$i++) { if($argsList[$offset+$i] -ne $expectedESP[$i]) { throw 'ESP engine flags differ; no service was started.' } }
    $espValidated=$true
}
$url='http://127.0.0.1:8190'
$statePath=ProjectPath 'runtime/Strata.json'
if ($ValidateOnly) {
    $record=$null
    if (Test-Path -LiteralPath $statePath -PathType Leaf) {
        try { $record=Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } catch { $record=$null }
    }
    [ordered]@{service='Strata';executable=$executable;config=$configuration;url=$url;model=$cfg.model_name;lazy=$true;offline=$true;mtp='off';espVectorVerified=$espValidated;started=$false;validation='files and installation receipt only; model load not tested';configComparison=(Compare-StrataConfigHash $desiredHash $record)} | ConvertTo-Json -Depth 5
    return
}
$token=$null; $launchLock=$null
New-Item -ItemType Directory -Path (ProjectPath 'runtime') -Force | Out-Null
try {
    $launchLock=[IO.File]::Open((ProjectPath 'runtime/Strata-launch.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    # Config preparation uses this same lock. Refuse a stale pre-lock read,
    # otherwise a concurrent change could launch with the wrong recorded hash.
    $lockedReceipt=Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    $lockedHash=(Get-FileHash -LiteralPath $configuration -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($lockedHash -ne $desiredHash -or (Get-FileHash -LiteralPath $receiptPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $desiredReceiptHash -or $lockedReceipt.configSha256 -ne $desiredHash) { throw 'Strata configuration changed during startup; retry validation. No service was started.' }
    if ($espValidated -and ((Get-Item -LiteralPath $vector).Length -ne 483520 -or (Get-FileHash -LiteralPath $vector -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash)) { throw 'ESP vector changed during startup; no service was started.' }
    $token=([IO.File]::ReadAllText((Join-Path $data 'api-token'))).Trim()
    if ($token -notmatch '^[a-f0-9]{64}$') { throw 'Strata API token is invalid.' }
    if (Test-Path -LiteralPath $statePath) {
        $saved=Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        if ($saved.executable -ne $executable -or $saved.url -ne $url -or $saved.workspace -ne $taskRoot) { throw 'Existing Strata record differs. No process was changed.' }
        $existing=Get-Process -Id $saved.processId -ErrorAction SilentlyContinue
        if ($null -ne $existing) {
            if (-not $existing.Path -or $existing.Path -ne $executable -or $existing.StartTime.ToUniversalTime().Ticks.ToString() -ne $saved.startTimeUtcTicks) { throw 'Existing Strata process identity is unavailable or differs. Record retained.' }
            $status=Status
            if ($null -eq $saved.started -or $status.started -ne $saved.started) { throw 'Strata running epoch differs or startup never completed. Record retained for diagnosis.' }
            Write-Output "Strata already ready: $url (PID $($existing.Id), loaded=$($status.loaded))"
            $comparison=Compare-StrataConfigHash $desiredHash $saved
            if ($null -eq $comparison.recordMatchesDesired) {
                Write-Output "The running process launch configuration hash is unavailable. Desired configuration hash: $desiredHash. Applied settings are not confirmed."
            } elseif (-not $comparison.recordMatchesDesired) {
                Write-Output "The running process launch configuration differs from the configuration prepared for the next start. Launch hash: $($comparison.recordedLaunchConfigSha256); desired hash: $desiredHash. No process was stopped or restarted."
            } else {
                Write-Output "The running process launch configuration hash matches the desired hash: $desiredHash. This does not establish loaded model behavior."
            }
            return
        }
        if (PortOpen 8190) { throw 'Strata port is occupied without its verified process. Record retained.' }
        throw 'The recorded Strata API process exited unexpectedly. Its engine/image-reader cleanup is unknown; retain the record and reconcile resources before starting another instance.'
    }
    if (PortOpen 8190) { throw 'Port 8190 is already occupied; no existing process was changed.' }
    $runtimeDir=Join-Path $data 'runtime'
    $logDir=ProjectPath 'logs/strata'
    New-Item -ItemType Directory -Path $runtimeDir,$logDir -Force | Out-Null
    $readyPath=Join-Path $runtimeDir ('ready-'+[guid]::NewGuid().ToString('N')+'.json')
    $stamp=Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $outLog=Join-Path $logDir "$stamp.stdout.log"; $errLog=Join-Path $logDir "$stamp.stderr.log"
    $childEnv=@{STRATA_API_KEY=$token;STRATA_NO_ACQUIRE='1';PYTHONNOUSERSITE='1';PYTHONDONTWRITEBYTECODE='1';PYTHONHOME=$null;PYTHONPATH=$null;STRATA_COMPONENTS_DIR=(ProductPath '.runtime/components');STRATA_PROFILE_DIR=(Join-Path $data 'profiles');STRATA_RUNTIME_DIR=$runtimeDir;STRATA_PRESET_DIR=(Join-Path $data 'presets');STRATA_LAUNCH_PRESET_DIR=(Join-Path $data 'launch-presets');LOCALAPPDATA=(Join-Path $data 'local-appdata');APPDATA=(Join-Path $data 'appdata');HF_HUB_OFFLINE='1';TRANSFORMERS_OFFLINE='1';PIP_NO_INDEX='1'}
    foreach ($key in [Environment]::GetEnvironmentVariables('Process').Keys) { if ([string]$key -like 'STRATA_*' -and -not $childEnv.ContainsKey([string]$key)) { $childEnv[[string]$key]=$null } }
    $arguments=@('-m','serve.server','--engine','strata','--config',$configuration,'--host','127.0.0.1','--port','8190','--ready-file',$readyPath,'--offline','--lazy')
    $argumentLine=($arguments | ForEach-Object { if ($_ -match '["\r\n]') { throw 'Invalid process argument.' }; '"'+$_+'"' }) -join ' '
    $process=Start-Process -FilePath $executable -ArgumentList $argumentLine -WorkingDirectory $control -Environment $childEnv -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
    $saved=[ordered]@{service='Strata';workspace=$taskRoot;processId=$process.Id;executable=$executable;startTimeUtcTicks=$process.StartTime.ToUniversalTime().Ticks.ToString();url=$url;config=$configuration;configSha256=$receipt.configSha256;readyPath=$readyPath;stdout=$outLog;stderr=$errLog;started=$null;instanceId=$null;ready=$false}
    WriteState $saved $statePath
    $deadline=[DateTime]::UtcNow.AddSeconds(60)
    $ready=$null; $status=$null
    while ([DateTime]::UtcNow -lt $deadline) {
        $process.Refresh()
        if ($process.HasExited) { throw "Strata exited during startup (code $($process.ExitCode)); record retained. Inspect $logDir." }
        if (Test-Path -LiteralPath $readyPath) {
            $ready=Get-Content -LiteralPath $readyPath -Raw | ConvertFrom-Json
            if ([int]$ready.pid -ne $process.Id -or $ready.api_url -ne $url -or $ready.bound_host -ne '127.0.0.1' -or $ready.bound_port -ne 8190 -or $ready.api_state -ne 'ready' -or $ready.model_id -ne $cfg.model_name -or -not $ready.instance_id) { throw 'Strata ready record does not identify the managed child. Process retained.' }
            try { $status=Status } catch { $status=$null }
            if ($null -ne $status) { break }
        }
        Start-Sleep -Milliseconds 250
    }
    if ($null -eq $status) { throw 'Strata did not become ready within 60 seconds. Process and record retained; inspect logs/strata.' }
    if ($status.loaded -or $status.activity.in_flight -ne 0) { throw 'Strata is not idle and unloaded after lazy startup. Process retained for inspection.' }
    $saved.started=[long]$status.started; $saved.instanceId=[string]$ready.instance_id; $saved.ready=$true
    WriteState $saved $statePath
    Write-Output "Strata API ready, model unloaded: $url (PID $($process.Id)). The resource controller owns model loading."
} finally { $token=$null; if ($null -ne $launchLock) { $launchLock.Dispose() } }
