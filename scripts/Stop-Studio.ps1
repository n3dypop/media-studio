#Requires -Version 7.4
$ErrorActionPreference = 'Stop'
$taskRoot = if ($env:MEDIA_STUDIO_HOME) { if (-not [IO.Path]::IsPathFullyQualified($env:MEDIA_STUDIO_HOME)) { throw 'MEDIA_STUDIO_HOME must be absolute' }; [IO.Path]::GetFullPath($env:MEDIA_STUDIO_HOME) } else { [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent)) }
$settings = Get-Content -LiteralPath (Join-Path $taskRoot 'config/environment.json') -Raw -Encoding UTF8 | ConvertFrom-Json

function Test-DshPortClosed([int]$Port) {
    $client = [Net.Sockets.TcpClient]::new()
    try {
        $pending = $client.ConnectAsync('127.0.0.1', $Port)
        if (-not $pending.Wait(5000)) { throw 'DSH port probe timed out.' }
        if ($client.Connected) { return $false }
        throw 'DSH port state is unavailable.'
    } catch {
        $cause = $_.Exception.GetBaseException()
        if ($cause -is [Net.Sockets.SocketException] -and $cause.SocketErrorCode -eq [Net.Sockets.SocketError]::ConnectionRefused) { return $true }
        throw 'DSH process/port ownership could not be confirmed. No later stop was requested.'
    } finally { $client.Dispose() }
}

function Get-DshIdleCounts {
    $recordPath = Join-Path $taskRoot 'runtime/DSH.json'
    if (-not (Test-Path -LiteralPath $recordPath)) { return [pscustomobject]@{ total=0; running=0 } }
    $record = Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($settings.dshPort -isnot [long] -and $settings.dshPort -isnot [int]) { throw 'DSH port configuration is invalid.' }
    $port = [int]$settings.dshPort
    if ($port -lt 1 -or $port -gt 65535) { throw 'DSH port configuration is invalid.' }
    $baseUrl = "http://127.0.0.1:$port"
    $expected = [IO.Path]::GetFullPath((Join-Path $taskRoot ($settings.nodeDirectory + '/node.exe')))
    if (-not $expected.StartsWith($taskRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or $record.executable -ne $expected -or $record.url -ne $baseUrl -or ($record.processId -isnot [long] -and $record.processId -isnot [int]) -or $record.processId -le 0) { throw 'DSH managed process record does not match this installation.' }
    $process = Get-Process -Id $record.processId -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        if (Test-DshPortClosed $port) { return [pscustomobject]@{ total=0; running=0 } }
        throw 'DSH is reachable without verified process ownership. No stop was requested.'
    }
    if (-not $process.Path -or $process.Path -ne $expected -or $process.StartTime.ToUniversalTime().Ticks.ToString() -ne $record.startTimeUtcTicks) { throw 'DSH process identity is unavailable or changed. No stop was requested.' }
    $logPath = [IO.Path]::GetFullPath([string]$record.stdout)
    if (-not $logPath.StartsWith($taskRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'DSH launch log is outside this workspace.' }
    $handler=$null; $client=$null; $authentication=$null; $response=$null; $content=$null; $token=$null; $launchLog=$null
    try {
        $launchLog = Get-Content -LiteralPath $logPath -Raw -Encoding UTF8
        $match = [regex]::Match($launchLog,[regex]::Escape($baseUrl)+'/\?token=([A-Za-z0-9_-]+)')
        if (-not $match.Success) { throw 'Missing DSH launch authentication.' }
        $token=$match.Groups[1].Value
        $handler=[Net.Http.HttpClientHandler]::new()
        $handler.AllowAutoRedirect=$false; $handler.UseCookies=$true; $handler.CookieContainer=[Net.CookieContainer]::new()
        $client=[Net.Http.HttpClient]::new($handler)
        $client.Timeout=[TimeSpan]::FromSeconds(10); $client.MaxResponseContentBufferSize=4MB
        $authentication=$client.GetAsync($baseUrl+'/connect?token='+$token+'&interactions=none').GetAwaiter().GetResult()
        if ([int]$authentication.StatusCode -ne 302 -or $handler.CookieContainer.GetCookies([uri]$baseUrl).Count -eq 0) { throw 'DSH authentication was not confirmed.' }
        $rpcId=[guid]::NewGuid().ToString()
        $envelope=@{type='client-request';rpcId=$rpcId;method='session/list';payload=@{args=@{_request=@{}}}}
        $content=[Net.Http.StringContent]::new(($envelope | ConvertTo-Json -Depth 6 -Compress),[Text.Encoding]::UTF8,'application/json')
        $response=$client.PostAsync($baseUrl+'/api/session/list',$content).GetAwaiter().GetResult()
        if ([int]$response.StatusCode -ne 200) { throw 'DSH session state was unavailable.' }
        $result=$response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json -AsHashtable
        if ($result.type -ne 'server-response' -or $result.rpcId -ne $rpcId -or $result.result.ok -isnot [bool] -or $result.result.ok -ne $true -or $result.result.value.items -isnot [array]) { throw 'DSH session response did not match the verified contract.' }
        $items=$result.result.value.items
        if (@($items | Where-Object { $_.running -isnot [bool] }).Count -gt 0) { throw 'DSH running state was ambiguous.' }
        return [pscustomobject]@{ total=$items.Count; running=@($items | Where-Object running -eq $true).Count }
    } catch {
        # HTTP exceptions can contain the authenticated URL. Never print them or
        # session projections, prompts, cookies, or business-result payloads.
        throw 'Could not confirm DSH idle state through its authenticated local API. No later stop was requested.'
    } finally {
        if ($null -ne $response) { $response.Dispose() }
        if ($null -ne $authentication) { $authentication.Dispose() }
        if ($null -ne $content) { $content.Dispose() }
        if ($null -ne $client) { $client.Dispose() } elseif ($null -ne $handler) { $handler.Dispose() }
        $token=$null; $launchLog=$null; $result=$null; $items=$null
    }
}

function Assert-DshIdle {
    $counts=Get-DshIdleCounts
    Write-Output "DSH sessions: total=$($counts.total), running=$($counts.running)."
    if ($counts.running -gt 0) { throw 'DSH has running work. Stop that work in DSH before stopping the studio.' }
}
function Invoke-StudioStop([string]$Name,[hashtable]$Parameters=@{}) {
    & (Join-Path $PSScriptRoot $Name) @Parameters
    if (-not $?) { throw "$Name did not complete successfully. Later services were retained." }
}

# DSH's read-only snapshot is not an admission lock. Keep the existing operational
# requirement that no new DSH work is started during shutdown.
Assert-DshIdle
Write-Output 'Do not start new DSH work during shutdown; the idle check is a point-in-time observation.'
if (Test-Path -LiteralPath (Join-Path $taskRoot 'runtime/Controller.json')) {
    Invoke-StudioStop 'Stop-Controller.ps1'
    if (Test-Path -LiteralPath (Join-Path $taskRoot 'runtime/Controller.json')) { throw 'Controller shutdown did not resolve its process record. Later services were retained.' }
}
if (Test-Path -LiteralPath (Join-Path $taskRoot 'runtime/Strata.json')) { Invoke-StudioStop 'Stop-Strata.ps1' }
if (Test-Path -LiteralPath (Join-Path $taskRoot 'runtime/RustXNG.json')) { Invoke-StudioStop 'Stop-RustXNG.ps1' }
Assert-DshIdle
# Controller has already exited and its record is gone, so the existing All path
# does not repeat its stop. It retains the Comfy queue and process identity guards.
Invoke-StudioStop 'Stop-Environment.ps1' @{Service='All'}
