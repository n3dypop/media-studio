#Requires -Version 7.2
<#
Launch the installed Desktop using the configured local runtime. This script
does not install a profile, start or stop other services, or modify user data.
The shared web host must be stopped before launch. A direct simultaneous launch
can race these checks; process creation is not proof of Desktop readiness.
#>
[CmdletBinding()]
param(
    [string] $RuntimeHome = $env:MEDIA_STUDIO_HOME,
    [string] $DesktopHome = (Join-Path $env:USERPROFILE '.dsh'),
    [string] $DesktopExecutable = (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe')
)
$ErrorActionPreference = 'Stop'
$phase = 'configuration'
$token = $null
$mutex = $null
$listener = $null
$locked = $false
$dshLaunchLock = $null
. (Join-Path $PSScriptRoot 'DshLaunchLock.ps1')
. (Join-Path $PSScriptRoot 'DesktopProfileGuard.ps1')
function Assert-NoReparse([string] $absolutePath) {
    if (-not [IO.Path]::IsPathFullyQualified($absolutePath)) { throw 'An absolute path is required.' }
    $full = [IO.Path]::GetFullPath($absolutePath)
    $root = [IO.Path]::GetPathRoot($full)
    $current = $root
    foreach ($part in ($full.Substring($root.Length) -split '[\\/]' | Where-Object { $_ })) {
        $current = Join-Path $current $part
        $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'A path component is a link.' }
    }
    return $full
}
try {
    if (-not $IsWindows) { throw 'Desktop requires Windows.' }
    $runtime = Assert-NoReparse $RuntimeHome
    $dshLaunchLock = Enter-DshLaunchLock $runtime
    $profileGuard = Read-DesktopProfileGuard $runtime
    if ($profileGuard.status.state -cne 'ready') { throw 'Desktop profile maintenance is incomplete.' }
    $desktopHomePath = Assert-NoReparse $DesktopHome
    $profile = Assert-NoReparse (Join-Path $desktopHomePath 'profiles\desktop\cordis.patch.yml')
    $exe = Assert-NoReparse $DesktopExecutable
    $config = Assert-NoReparse (Join-Path $runtime 'config\environment.json')
    # Desktop is a DSH client. Never hand the Controller's admin token to the
    # model provider: the restricted DSH token enforces inference ownership.
    $tokenFile = Assert-NoReparse (Join-Path $runtime 'data\controller\dsh-token')
    $helper = Assert-NoReparse (Join-Path $PSScriptRoot 'DesktopProcess.cs')
    $exeItem = Get-Item -LiteralPath $exe -Force
    $tokenItem = Get-Item -LiteralPath $tokenFile -Force
    if ($exeItem.PSIsContainer -or $exeItem.Extension -ine '.exe' -or $tokenItem.PSIsContainer -or $tokenItem.Length -gt 256) { throw 'Invalid executable or token file.' }
    $settings = Get-Content -LiteralPath $config -Raw | ConvertFrom-Json
    if ($settings.dshPort -isnot [long] -and $settings.dshPort -isnot [int]) { throw 'Invalid Web port.' }
    $port = [int] $settings.dshPort
    if ($port -lt 1024 -or $port -gt 65535) { throw 'Invalid Web port.' }
    $mutex = [Threading.Mutex]::new($false, 'Local\MediaStudioDesktopLaunch')
    try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Another Desktop launch is in progress.' }
    $phase = 'existing-desktop'
    $name = [IO.Path]::GetFileName($exe).Replace("'", "''")
    if (@(Get-CimInstance Win32_Process -Filter "Name = '$name'" -ErrorAction Stop).Count -ne 0) { throw 'Desktop is already running.' }
    $phase = 'web-host'
    $webRecord = Join-Path $runtime 'runtime\DSH.json'
    if (Test-Path -LiteralPath $webRecord) {
        $webRecord = Assert-NoReparse $webRecord
        $record = Get-Content -LiteralPath $webRecord -Raw | ConvertFrom-Json
        if ($record.service -ne 'DSH' -or ($record.processId -isnot [long] -and $record.processId -isnot [int]) -or $record.processId -lt 1 -or $record.startTimeUtcTicks -notmatch '^[0-9]+$' -or -not [IO.Path]::IsPathFullyQualified($record.executable)) { throw 'Invalid Web process record.' }
        $web = Get-Process -Id $record.processId -ErrorAction SilentlyContinue
        if ($web) {
            # An inaccessible process is unknown, not proof that Web exited.
            if (-not $web.Path) { throw 'Web process identity unavailable.' }
            if ($web.StartTime.ToUniversalTime().Ticks.ToString() -ceq $record.startTimeUtcTicks -and [string]::Equals($web.Path,$record.executable,[StringComparison]::OrdinalIgnoreCase)) { throw 'Managed Web is still running.' }
        }
    }
    # Holding the normal Web bind point excludes a concurrently listening Web
    # while the new Desktop is created. A separate launcher can race after the
    # listener is released, so this is not a permanent system-wide lock.
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
    $listener.ExclusiveAddressUse = $true
    $listener.Start()
    $phase = 'token'
    $token = [IO.File]::ReadAllText($tokenFile).Trim()
    if ($token -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid Controller token.' }
    $phase = 'start'
    Add-Type -LiteralPath $helper
    $pidValue = [MediaStudioDesktopProcess]::Start($exe, [IO.Path]::GetDirectoryName($exe), $token, $runtime, $desktopHomePath)
    if ($pidValue -le 0) { throw 'Desktop process was not created.' }
    Write-Output (ConvertTo-Json -Compress @{ pid=$pidValue; state='created' })
} catch {
    # Do not echo exception values, the process environment, or the token.
    $message = switch ($phase) {
        'configuration' { 'DesktopまたはMedia Studioの設定を確認できません。' }
        'existing-desktop' { 'Desktopが起動中、または起動状態を確認できません。' }
        'web-host' { 'ブラウザ版DSHが起動中、または待受と管理状態を確認できません。' }
        'token' { 'Controllerの接続情報を確認できません。' }
        default { 'Desktopを起動できません。' }
    }
    [Console]::Error.WriteLine($message)
    exit 1
} finally {
    if ($dshLaunchLock) { $dshLaunchLock.Dispose() }
    $token = $null
    if ($listener) { $listener.Stop() }
    if ($locked -and $mutex) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
