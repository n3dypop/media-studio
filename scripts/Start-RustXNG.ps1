#Requires -Version 7.4
param([switch]$ValidateOnly)
$ErrorActionPreference='Stop'
$taskRoot=if ($env:MEDIA_STUDIO_HOME) { if (-not [IO.Path]::IsPathFullyQualified($env:MEDIA_STUDIO_HOME)) { throw 'MEDIA_STUDIO_HOME must be absolute' }; [IO.Path]::GetFullPath($env:MEDIA_STUDIO_HOME) } else { [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent)) }
$settings=Get-Content -LiteralPath (Join-Path $taskRoot 'config/rustxng.json') -Raw|ConvertFrom-Json
if($null -eq $settings -or $settings -isnot [PSCustomObject]){throw 'Invalid search configuration'}
if($null -ne $settings.PSObject.Properties['enabled'] -and $settings.enabled -isnot [bool]){throw 'Search enabled must be boolean'}
if($settings.enabled -eq $false){throw 'Search is disabled; no RustXNG process was started'}
$executable=[IO.Path]::GetFullPath($settings.executable,$taskRoot)
$configuration=[IO.Path]::GetFullPath((Join-Path $taskRoot $settings.settings))
$url='http://127.0.0.1:29483'
if($settings.baseUrl -ne $url -or $settings.engine -ne 'duckduckgo' -or -not $settings.approvalRequired -or $settings.automaticPageFetch){throw 'Unsupported search boundary settings'}
if((Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $settings.executableSha256){throw 'RustXNG executable differs from the installed release'}
if(-not $configuration.StartsWith($taskRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'RustXNG settings escaped workspace'}
if($ValidateOnly){[ordered]@{service='RustXNG';executable=$executable;configuration=$configuration;url=$url;validation='files only';started=$false}|ConvertTo-Json;return}
$record=Join-Path $taskRoot 'runtime/RustXNG.json'
New-Item -ItemType Directory -Path (Join-Path $taskRoot 'runtime') -Force|Out-Null
$lock=[IO.File]::Open((Join-Path $taskRoot 'runtime/RustXNG-launch.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try{
    if(Test-Path -LiteralPath $record){
        $savedText=Get-Content -LiteralPath $record -Raw
        $saved=$savedText|ConvertFrom-Json
        if($saved.service -ne 'RustXNG' -or $saved.workspace -ne $taskRoot -or $saved.executable -ne $executable -or $saved.url -ne $url -or $saved.config -ne $configuration -or -not ($saved.processId -is [long] -or $saved.processId -is [int]) -or $saved.processId -lt 1 -or $saved.processId -gt [uint32]::MaxValue -or $saved.startTimeUtcTicks -notmatch '^[1-9][0-9]{16,18}$'){throw 'RustXNG management record differs; no process was changed'}
        if($saved.configSha256 -ne (Get-FileHash -LiteralPath $configuration -Algorithm SHA256).Hash.ToLowerInvariant()){throw 'Running RustXNG configuration changed; inspect before applying'}
        # A missing PID is a normal stale receipt after shutdown/reboot. A
        # failed process query is not absence and must preserve the record.
        $observed=Get-CimInstance Win32_Process -Filter ('ProcessId='+$saved.processId) -ErrorAction Stop
        if($null -eq $observed){
            $oldListeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object LocalPort -eq 29483)
            $observedAgain=Get-CimInstance Win32_Process -Filter ('ProcessId='+$saved.processId) -ErrorAction Stop
            if($oldListeners.Count -or $null -ne $observedAgain -or $savedText -ne (Get-Content -LiteralPath $record -Raw)){throw 'RustXNG stale record is not proven idle; no process was changed'}
            Remove-Item -LiteralPath $record
        }else{
            $existing=Get-Process -Id $saved.processId -ErrorAction Stop
            if($existing.Path -ne $executable -or $existing.StartTime.ToUniversalTime().Ticks.ToString() -ne $saved.startTimeUtcTicks){throw 'RustXNG ownership differs; no process was changed'}
            $health=Invoke-WebRequest -Uri ($url+'/healthz') -TimeoutSec 3
            if($health.StatusCode -ne 200){throw 'Existing RustXNG health check failed'}
            Write-Output "RustXNG already ready: $url (PID $($existing.Id))";return
        }
    }
    $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object LocalPort -eq 29483)
    if($listeners.Count){throw 'RustXNG port is occupied without a verified management record'}
    $logs=Join-Path $taskRoot 'logs/rustxng';New-Item -ItemType Directory -Path $logs -Force|Out-Null
    $stamp=Get-Date -Format 'yyyyMMdd-HHmmss-fff';$stdout=Join-Path $logs "$stamp.stdout.log";$stderr=Join-Path $logs "$stamp.stderr.log"
    $childEnv=@{SEARXNG_SETTINGS_PATH=$null;SEARXNG_BIND_ADDRESS='127.0.0.1';SEARXNG_PORT='29483';SEARXNG_BASE_URL=$url;SEARXNG_ENABLE_METRICS='0';SEARXNG_DEBUG='0';RUST_LOG='warn';RUSTXNG_IDLE_TIMEOUT='0'}
    $process=Start-Process -FilePath $executable -ArgumentList @('--config',('"'+$configuration+'"'),'--bind','127.0.0.1','--port','29483') -WorkingDirectory $taskRoot -Environment $childEnv -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    $state=[ordered]@{service='RustXNG';processId=$process.Id;workspace=$taskRoot;executable=$executable;startTimeUtcTicks=$process.StartTime.ToUniversalTime().Ticks.ToString();url=$url;config=$configuration;configSha256=(Get-FileHash -LiteralPath $configuration -Algorithm SHA256).Hash.ToLowerInvariant();stdout=$stdout;stderr=$stderr;ready=$false}
    $state|ConvertTo-Json|Set-Content -LiteralPath $record -Encoding utf8
    $ready=$false;$deadline=[DateTime]::UtcNow.AddSeconds(12)
    while([DateTime]::UtcNow -lt $deadline){$process.Refresh();if($process.HasExited){throw 'RustXNG exited; management record retained for inspection'};try{$response=Invoke-WebRequest -Uri ($url+'/healthz') -TimeoutSec 2;if($response.StatusCode -eq 200){$ready=$true;break}}catch{};Start-Sleep -Milliseconds 150}
    if(-not $ready){throw 'RustXNG did not become ready; record retained'}
    $bound=@(Get-NetTCPConnection -State Listen -LocalPort 29483)
    if($bound.Count -ne 1 -or $bound[0].LocalAddress -ne '127.0.0.1' -or $bound[0].OwningProcess -ne $process.Id){throw 'RustXNG listener ownership differs'}
    $state.ready=$true;$state.readyAt=[DateTime]::UtcNow.ToString('o');$state|ConvertTo-Json|Set-Content -LiteralPath $record -Encoding utf8
    Write-Output "RustXNG ready: $url (PID $($process.Id)); no search was sent"
}finally{$lock.Dispose()}
