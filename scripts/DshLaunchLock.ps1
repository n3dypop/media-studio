function Enter-DshLaunchLock([string] $RuntimeHome) {
    if (-not [IO.Path]::IsPathFullyQualified($RuntimeHome)) { throw 'An absolute Media Studio runtime path is required.' }
    $root = [IO.Path]::GetFullPath($RuntimeHome)
    $current = [IO.Path]::GetPathRoot($root)
    foreach ($part in ($root.Substring($current.Length) -split '[\\/]' | Where-Object { $_ })) {
        $current = Join-Path $current $part
        $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'The DSH lock path contains a link.' }
    }
    $directory = Join-Path $root 'runtime'
    if (-not (Test-Path -LiteralPath $directory)) { [void](New-Item -ItemType Directory -Path $directory -ErrorAction Stop) }
    $item = Get-Item -LiteralPath $directory -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'The DSH lock directory is unsafe.' }
    $path = Join-Path $directory 'DSH-launch.lock'
    if (Test-Path -LiteralPath $path) {
        $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'The DSH lock file is unsafe.' }
    }
    try { return [IO.File]::Open($path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch { throw 'Another DSH launch or maintenance operation is in progress.' }
}

function Assert-DefaultDshDesktopStopped {
    if (-not $IsWindows -or [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { throw 'Desktop process observation is unavailable.' }
    $expected = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'))
    $name = [IO.Path]::GetFileName($expected).Replace("'", "''")
    try { $candidates = @(Get-CimInstance Win32_Process -Filter "Name = '$name'" -ErrorAction Stop) }
    catch { throw 'Desktop process observation is unavailable.' }
    foreach ($candidate in $candidates) {
        if ([string]::IsNullOrWhiteSpace([string]$candidate.ExecutablePath) -or -not [IO.Path]::IsPathFullyQualified([string]$candidate.ExecutablePath)) { throw 'Desktop process identity is unavailable.' }
        if ([string]::Equals([IO.Path]::GetFullPath([string]$candidate.ExecutablePath), $expected, [StringComparison]::OrdinalIgnoreCase)) { throw 'Desktop is running; stop it before starting Web DSH.' }
    }
}
