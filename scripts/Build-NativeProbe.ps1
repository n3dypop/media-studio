#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$RuntimeRoot,
    [string]$BuildDirectory,
    [switch]$AllowNetwork,
    [switch]$ReplaceExisting
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows -or -not [Environment]::Is64BitOperatingSystem) { throw 'The native probe requires Windows x64.' }
$sourceRoot = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$sourceDirectory = Join-Path $sourceRoot 'apps/controller/native/system-probe'

function Get-AbsoluteLocalPath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -ne $Value.Trim() -or -not [IO.Path]::IsPathFullyQualified($Value) -or $Value.StartsWith('\\') -or $Value.Contains('*') -or $Value.Contains('?')) { throw 'Paths must be explicit absolute local paths without wildcards.' }
    $result = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($Value))
    if ($result -eq [IO.Path]::GetPathRoot($result)) { throw 'A drive root cannot be used as a private runtime directory.' }
    return $result
}
function Test-Contained([string]$Root,[string]$Path) {
    return $Path.StartsWith($Root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)
}
function Assert-NoLinks([string]$Path) {
    $current = $Path
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked paths are not supported by the native probe builder.' }
        }
        $current = Split-Path $current -Parent
    }
}
function Assert-PrivatePath([string]$Path) {
    if (-not (Test-Contained $privateRoot $Path)) { throw 'Build and install paths must remain inside RuntimeRoot.' }
    if ($Path -eq $sourceRoot -or (Test-Contained $sourceRoot $Path) -or (Test-Contained $Path $sourceRoot)) { throw 'Build and install paths must not overlap the source repository.' }
    Assert-NoLinks $Path
}

$privateRoot = Get-AbsoluteLocalPath $RuntimeRoot
if ($privateRoot -eq $sourceRoot -or (Test-Contained $sourceRoot $privateRoot) -or (Test-Contained $privateRoot $sourceRoot)) { throw 'RuntimeRoot must be private and must not overlap the source repository.' }
Assert-NoLinks $privateRoot
if (Test-Path -LiteralPath $privateRoot -PathType Leaf) { throw 'RuntimeRoot must be a directory.' }
$buildRoot = if ($BuildDirectory) { Get-AbsoluteLocalPath $BuildDirectory } else { Join-Path $privateRoot 'cache/native-probe-build' }
$installRoot = Join-Path $privateRoot 'apps/media-studio-probe'
$executable = Join-Path $installRoot 'controller-native-probe.exe'
foreach ($path in @($buildRoot,$installRoot,$executable)) { Assert-PrivatePath $path }
if ($buildRoot -eq $installRoot -or (Test-Contained $buildRoot $installRoot) -or (Test-Contained $installRoot $buildRoot)) { throw 'BuildDirectory must not overlap the installed helper directory.' }
foreach ($path in @('Cargo.toml','Cargo.lock','src/main.rs','LICENSE','THIRD_PARTY_NOTICES.md','licenses/windows-MIT.txt','licenses/serde-MIT.txt','licenses/memchr-MIT.txt')) {
    $candidate = Join-Path $sourceDirectory $path
    Assert-NoLinks $candidate
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw 'The native probe source or license material is missing.' }
}
$cargo = Get-Command cargo.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
Assert-PrivatePath $buildRoot
$previousTarget = $env:CARGO_TARGET_DIR
$previousOffline = $env:CARGO_NET_OFFLINE
try {
    $env:CARGO_TARGET_DIR = $buildRoot
    $env:CARGO_NET_OFFLINE = if ($AllowNetwork) { 'false' } else { 'true' }
    $cargoArguments = @('build','--release','--locked','--target','x86_64-pc-windows-msvc','--manifest-path',(Join-Path $sourceDirectory 'Cargo.toml'))
    if (-not $AllowNetwork) { $cargoArguments += '--offline' }
    & $cargo.Source @cargoArguments
    if ($LASTEXITCODE -ne 0) { throw 'Cargo build failed. Install was not attempted.' }
} finally {
    $env:CARGO_TARGET_DIR = $previousTarget
    $env:CARGO_NET_OFFLINE = $previousOffline
}
$built = Join-Path $buildRoot 'x86_64-pc-windows-msvc/release/controller-native-probe.exe'
Assert-PrivatePath $built
if (-not (Test-Path -LiteralPath $built -PathType Leaf)) { throw 'Cargo did not produce the expected native helper.' }
$builtHash = (Get-FileHash -LiteralPath $built -Algorithm SHA256).Hash.ToLowerInvariant()
New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
Assert-PrivatePath $installRoot
$existingHash = if (Test-Path -LiteralPath $executable -PathType Leaf) { (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null }
if ($existingHash -and $existingHash -ne $builtHash -and -not $ReplaceExisting) { throw 'A different helper is already installed. Stop the Controller, retain a recovery copy, then explicitly pass -ReplaceExisting to upgrade it.' }
$temporary = Join-Path $installRoot ('controller-native-probe.'+[guid]::NewGuid().ToString('N')+'.partial')
Assert-PrivatePath $temporary
try {
    if ($existingHash -ne $builtHash) {
        Copy-Item -LiteralPath $built -Destination $temporary
        if ((Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash.ToLowerInvariant() -ne $builtHash) { throw 'The staged helper hash differs from the build.' }
        [IO.File]::Move($temporary,$executable,$true)
    }
} finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
}
if ((Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $builtHash) { throw 'The installed helper hash differs from the build.' }
foreach ($relative in @('LICENSE','THIRD_PARTY_NOTICES.md','licenses/windows-MIT.txt','licenses/serde-MIT.txt','licenses/memchr-MIT.txt')) {
    $destination = Join-Path $installRoot $relative
    Assert-PrivatePath $destination
    if ((Test-Path -LiteralPath $destination) -and -not (Test-Path -LiteralPath $destination -PathType Leaf)) { throw 'The installed notice destination is not a regular file.' }
    New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $sourceDirectory $relative) -Destination $destination -Force
}
[ordered]@{schemaVersion=1;executable=$executable;sha256=$builtHash;bytes=(Get-Item -LiteralPath $executable).Length;buildDirectory=$buildRoot;target='x86_64-pc-windows-msvc';replacedExisting=[bool]($existingHash -and $existingHash -ne $builtHash);configurationChanged=$false;servicesChanged=$false} | ConvertTo-Json
