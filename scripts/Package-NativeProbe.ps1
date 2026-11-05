#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$RuntimeRoot,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [string]$BuildDirectory,
    [string]$SourceCommit,
    [switch]$AllowNetwork,
    [switch]$ReplaceExisting
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'Native Windows packages must be built on Windows.' }
$sourceRoot = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$nativePath = 'apps/controller/native/system-probe'
$target = 'x86_64-pc-windows-msvc'
function Test-Contained([string]$Root,[string]$Path) { return $Path.StartsWith($Root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) }
function Assert-NoLinks([string]$Path) {
    $current = $Path
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            if (((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked paths cannot be packaged.' }
        }
        $current = Split-Path $current -Parent
    }
}
function Get-PrivateDirectory([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -ne $Value.Trim() -or -not [IO.Path]::IsPathFullyQualified($Value) -or $Value.StartsWith('\\') -or $Value.Contains('*') -or $Value.Contains('?')) { throw 'Package paths must be absolute local paths without wildcards.' }
    $path = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($Value))
    if ($path -eq [IO.Path]::GetPathRoot($path) -or $path -eq $sourceRoot -or (Test-Contained $sourceRoot $path) -or (Test-Contained $path $sourceRoot)) { throw 'Package paths must not overlap the source repository or a drive root.' }
    Assert-NoLinks $path
    if (Test-Path -LiteralPath $path -PathType Leaf) { throw 'A package directory cannot be a file.' }
    return $path
}
function Get-SourceHashes {
    $paths = @('Cargo.toml','Cargo.lock','src/main.rs','LICENSE','THIRD_PARTY_NOTICES.md','licenses/windows-MIT.txt','licenses/serde-MIT.txt','licenses/memchr-MIT.txt') | ForEach-Object { $nativePath+'/'+$_ }
    $paths += @('scripts/Build-NativeProbe.ps1','scripts/Package-NativeProbe.ps1','.github/workflows/build-native.yml')
    return @($paths | ForEach-Object {
        $path = Join-Path $sourceRoot $_
        Assert-NoLinks $path
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'A required package source input is missing.' }
        [ordered]@{path=$_;sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}
    })
}
$privateRoot = Get-PrivateDirectory $RuntimeRoot
$outputRoot = Get-PrivateDirectory $OutputDirectory
if ((Test-Path -LiteralPath $outputRoot) -and @(Get-ChildItem -LiteralPath $outputRoot -Force).Count -ne 0) { throw 'OutputDirectory must be fresh or empty.' }
$git = Get-Command git.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
$actualCommit = (& $git.Source -C $sourceRoot rev-parse --verify HEAD | Out-String).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0 -or $actualCommit -notmatch '^[0-9a-f]{40}$') { throw 'Cannot identify the checked-out source commit.' }
if ($SourceCommit -and $SourceCommit.ToLowerInvariant() -ne $actualCommit) { throw 'SourceCommit differs from the checked-out commit.' }
$dirtyText = (& $git.Source -C $sourceRoot status --porcelain --untracked-files=normal | Out-String)
if ($LASTEXITCODE -ne 0) { throw 'Cannot identify the source worktree state.' }
$sourceDirty = -not [string]::IsNullOrWhiteSpace($dirtyText)
$sourceHashes = Get-SourceHashes
$rustc = Get-Command rustc.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
$cargo = Get-Command cargo.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
$rustcVersion = (& $rustc.Source --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $rustcVersion -notmatch '^rustc [0-9]+\.[0-9]+\.[0-9]+') { throw 'Cannot identify the Rust compiler.' }
$cargoVersion = (& $cargo.Source --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $cargoVersion -notmatch '^cargo [0-9]+\.[0-9]+\.[0-9]+') { throw 'Cannot identify Cargo.' }
$archiveName = 'media-studio-probe-'+$target+'-'+$actualCommit+'.zip'
$archivePath = Join-Path $outputRoot $archiveName
$checksumPath = $archivePath+'.sha256'
$receiptPath = $archivePath+'.build-receipt.json'
foreach ($path in @($archivePath,$checksumPath,$receiptPath)) {
    Assert-NoLinks $path
    if (Test-Path -LiteralPath $path) { throw 'Package output already exists; choose a fresh OutputDirectory.' }
}
$buildArguments = @{RuntimeRoot=$privateRoot;AllowNetwork=$AllowNetwork;ReplaceExisting=$ReplaceExisting}
if ($BuildDirectory) { $buildArguments.BuildDirectory=$BuildDirectory }
$build = (& (Join-Path $PSScriptRoot 'Build-NativeProbe.ps1') @buildArguments | Out-String | ConvertFrom-Json)
if ($build.schemaVersion -ne 1 -or $build.target -ne $target -or $build.sha256 -notmatch '^[0-9a-f]{64}$') { throw 'The builder did not return the expected receipt.' }
$installRoot = Join-Path $privateRoot 'apps/media-studio-probe'
$expectedExecutable = Join-Path $installRoot 'controller-native-probe.exe'
if ($build.executable -ne $expectedExecutable) { throw 'The builder returned a different installation path.' }
$files = [ordered]@{}
foreach ($name in @('controller-native-probe.exe','LICENSE','THIRD_PARTY_NOTICES.md','licenses/windows-MIT.txt','licenses/serde-MIT.txt','licenses/memchr-MIT.txt')) {
    $path = Join-Path $installRoot $name
    Assert-NoLinks $path
    $item = Get-Item -LiteralPath $path -Force
    if ($item.PSIsContainer -or $item.Length -gt 4194304) { throw 'A package input is not a bounded regular file.' }
    $files[$name] = [IO.File]::ReadAllBytes($path)
}
$sha256 = { param([byte[]]$Bytes) [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant() }
$binaryHash = & $sha256 $files['controller-native-probe.exe']
if ($binaryHash -ne $build.sha256) { throw 'The installed executable changed after build verification.' }
$sysroot = (& $rustc.Source --print sysroot | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or -not [IO.Path]::IsPathFullyQualified($sysroot)) { throw 'Cannot locate the active Rust toolchain notices.' }
$rustDocs = Join-Path $sysroot 'share/doc/rust'
$rustCopyright = Join-Path $rustDocs 'COPYRIGHT-library.html'
$rustLicenses = Join-Path $rustDocs 'licenses'
foreach ($path in @($rustDocs,$rustCopyright,$rustLicenses)) { Assert-NoLinks $path }
if (-not (Test-Path -LiteralPath $rustCopyright -PathType Leaf) -or -not (Test-Path -LiteralPath $rustLicenses -PathType Container)) { throw 'Rust standard library notices are missing. Install rust-docs for the active toolchain before packaging.' }
$toolchainFiles = @([ordered]@{source=$rustCopyright;path='licenses/rust/COPYRIGHT-library.html'})
$licenseEntries = @(Get-ChildItem -LiteralPath $rustLicenses -File -Filter '*.txt' | Sort-Object Name)
if ($licenseEntries.Count -lt 2 -or $licenseEntries.Count -gt 64 -or -not ($licenseEntries.Name -contains 'MIT.txt') -or -not ($licenseEntries.Name -contains 'Apache-2.0.txt')) { throw 'The active Rust toolchain has an unexpected license set.' }
foreach ($license in $licenseEntries) {
    if ($license.Name -cnotmatch '^[A-Za-z0-9_.-]+\.txt$') { throw 'An unexpected Rust license filename was found.' }
    $toolchainFiles += [ordered]@{source=$license.FullName;path='licenses/rust/licenses/'+$license.Name}
}
$toolchainReceipts = @($toolchainFiles | ForEach-Object {
    Assert-NoLinks $_.source
    $item = Get-Item -LiteralPath $_.source -Force
    if ($item.PSIsContainer -or $item.Length -gt 4194304) { throw 'A Rust notice is not a bounded regular file.' }
    $files[$_.path] = [IO.File]::ReadAllBytes($_.source)
    [ordered]@{path=$_.path;sha256=(& $sha256 $files[$_.path]);bytes=$files[$_.path].Length}
})
if (($sourceHashes | ConvertTo-Json -Depth 8 -Compress) -ne ((Get-SourceHashes) | ConvertTo-Json -Depth 8 -Compress)) { throw 'Source inputs changed during the build.' }
$finalCommit = (& $git.Source -C $sourceRoot rev-parse --verify HEAD | Out-String).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0 -or $finalCommit -ne $actualCommit) { throw 'The source commit changed during the build.' }
$finalDirty = (& $git.Source -C $sourceRoot status --porcelain --untracked-files=normal | Out-String)
if ($LASTEXITCODE -ne 0) { throw 'Cannot verify the final source worktree state.' }
$sourceDirty = $sourceDirty -or -not [string]::IsNullOrWhiteSpace($finalDirty)
$receipt = [ordered]@{
    schemaVersion=1;artifact='media-studio-probe';sourceCommit=$actualCommit;sourceDirty=$sourceDirty
    target=$target;profile='release';rustcVersion=$rustcVersion;cargoVersion=$cargoVersion
    packagedAtUtc=[DateTime]::UtcNow.ToString('o');binary=[ordered]@{file='controller-native-probe.exe';sha256=$binaryHash;bytes=$files['controller-native-probe.exe'].Length}
    sourceInputs=$sourceHashes;toolchainLicenseFiles=$toolchainReceipts
}
$utf8 = [Text.UTF8Encoding]::new($false)
$receiptBytes = $utf8.GetBytes(($receipt | ConvertTo-Json -Depth 8)+"`n")
$files['build-receipt.json'] = $receiptBytes
$checksums = @($files.Keys | ForEach-Object { (& $sha256 $files[$_])+'  '+$_ }) -join "`n"
$files['SHA256SUMS'] = $utf8.GetBytes($checksums+"`n")
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
Assert-NoLinks $outputRoot
$temporary = Join-Path $outputRoot ($archiveName+'.'+[guid]::NewGuid().ToString('N')+'.partial')
try {
    $stream = [IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {
        $zip = [IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create,$true)
        try {
            foreach ($name in $files.Keys) {
                $entry = $zip.CreateEntry($name,[IO.Compression.CompressionLevel]::Optimal)
                $entryStream = $entry.Open()
                try { $entryStream.Write($files[$name],0,$files[$name].Length) } finally { $entryStream.Dispose() }
            }
        } finally { $zip.Dispose() }
    } finally { $stream.Dispose() }
    [IO.File]::Move($temporary,$archivePath,$false)
} finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
}
$archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
foreach ($output in @(@{path=$checksumPath;bytes=$utf8.GetBytes($archiveHash+'  '+$archiveName+"`n")},@{path=$receiptPath;bytes=$receiptBytes})) {
    $stream = [IO.File]::Open($output.path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $stream.Write($output.bytes,0,$output.bytes.Length) } finally { $stream.Dispose() }
}
[ordered]@{schemaVersion=1;archive=$archivePath;sha256=$archiveHash;checksumFile=$checksumPath;receiptFile=$receiptPath;sourceCommit=$actualCommit;sourceDirty=$sourceDirty;target=$target} | ConvertTo-Json
