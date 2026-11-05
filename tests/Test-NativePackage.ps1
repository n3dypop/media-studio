#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Archive,
    [Parameter(Mandatory)][string]$ExpectedSourceCommit
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($ExpectedSourceCommit -notmatch '^[0-9a-fA-F]{40}$') { throw 'ExpectedSourceCommit must be a full Git commit.' }
$expected = @('controller-native-probe.exe','LICENSE','THIRD_PARTY_NOTICES.md','licenses/windows-MIT.txt','licenses/serde-MIT.txt','licenses/memchr-MIT.txt','build-receipt.json','SHA256SUMS')
$files = @{}
$zip = [IO.Compression.ZipFile]::OpenRead([IO.Path]::GetFullPath($Archive))
try {
    if ($zip.Entries.Count -gt 73) { throw 'The package contains too many entries.' }
    foreach ($entry in $zip.Entries) {
        if (($entry.FullName -cnotin $expected -and $entry.FullName -cnotmatch '^licenses/rust/(COPYRIGHT-library\.html|licenses/[A-Za-z0-9_.-]+\.txt)$') -or $files.ContainsKey($entry.FullName) -or $entry.Length -gt 4194304) { throw 'The package contains an invalid entry.' }
        $stream = $entry.Open()
        $buffer = [IO.MemoryStream]::new()
        try { $stream.CopyTo($buffer);$files[$entry.FullName]=$buffer.ToArray() } finally { $buffer.Dispose();$stream.Dispose() }
    }
} finally { $zip.Dispose() }
$utf8 = [Text.UTF8Encoding]::new($false,$true)
$receipt = $utf8.GetString($files['build-receipt.json']) | ConvertFrom-Json
if ($receipt.toolchainLicenseFiles.Count -lt 3 -or $receipt.toolchainLicenseFiles.Count -gt 65) { throw 'Rust standard library notices are missing.' }
$requiredRust = @('licenses/rust/COPYRIGHT-library.html','licenses/rust/licenses/MIT.txt','licenses/rust/licenses/Apache-2.0.txt')
foreach ($path in $requiredRust) { if ($path -cnotin $receipt.toolchainLicenseFiles.path) { throw 'A required Rust standard library notice is missing.' } }
foreach ($license in $receipt.toolchainLicenseFiles) {
    if ($license.path -cnotmatch '^licenses/rust/(COPYRIGHT-library\.html|licenses/[A-Za-z0-9_.-]+\.txt)$' -or $license.path -cin $expected -or -not $files.ContainsKey($license.path)) { throw 'A Rust notice receipt is invalid.' }
    $actual = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([byte[]]$files[$license.path])).ToLowerInvariant()
    if ($license.sha256 -cne $actual -or $license.bytes -ne $files[$license.path].Length) { throw 'A Rust notice differs from its receipt.' }
    $expected += $license.path
}
if ($files.Count -ne $expected.Count) { throw 'The package contains unexpected or missing entries.' }
$manifest = $utf8.GetString($files['SHA256SUMS']).TrimEnd("`n").Split("`n")
if ($manifest.Count -ne $expected.Count-1) { throw 'The checksum manifest does not cover all payload files.' }
$seen = @{}
foreach ($line in $manifest) {
    if ($line -cnotmatch '^([0-9a-f]{64})  (.+)$') { throw 'A checksum line is invalid.' }
    $hash=$Matches[1];$name=$Matches[2]
    if ($name -eq 'SHA256SUMS' -or -not $files.ContainsKey($name) -or $seen.ContainsKey($name)) { throw 'A checksum names an invalid or duplicate file.' }
    $actual=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([byte[]]$files[$name])).ToLowerInvariant()
    if ($actual -ne $hash) { throw 'A payload checksum differs from the manifest.' }
    $seen[$name]=$true
}
$binaryHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([byte[]]$files['controller-native-probe.exe'])).ToLowerInvariant()
if ($receipt.schemaVersion -ne 1 -or $receipt.sourceCommit -ne $ExpectedSourceCommit.ToLowerInvariant() -or $receipt.target -ne 'x86_64-pc-windows-msvc' -or $receipt.sourceDirty -isnot [bool]) { throw 'The build receipt has incorrect provenance.' }
if ($receipt.rustcVersion -notmatch '^rustc [0-9]+\.[0-9]+\.[0-9]+' -or $receipt.cargoVersion -notmatch '^cargo [0-9]+\.[0-9]+\.[0-9]+' -or $receipt.sourceInputs.Count -ne 11) { throw 'The build receipt is missing toolchain or source evidence.' }
foreach ($source in $receipt.sourceInputs) { if ($source.sha256 -cnotmatch '^[0-9a-f]{64}$' -or $source.path.StartsWith('/') -or $source.path.Contains('..') -or $source.path.Contains('\') -or $source.path.Contains(':')) { throw 'A source receipt entry is invalid.' } }
if ($receipt.binary.file -ne 'controller-native-probe.exe' -or $receipt.binary.sha256 -ne $binaryHash -or $receipt.binary.bytes -ne $files['controller-native-probe.exe'].Length) { throw 'The binary receipt differs from the packaged executable.' }
$archiveHash = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
$checksumText = [IO.File]::ReadAllText($Archive+'.sha256',$utf8)
if ($checksumText -cne $archiveHash+'  '+[IO.Path]::GetFileName($Archive)+"`n") { throw 'The external archive checksum is incorrect.' }
if ([IO.File]::ReadAllText($Archive+'.build-receipt.json',$utf8) -cne $utf8.GetString($files['build-receipt.json'])) { throw 'The external receipt differs from the archived receipt.' }
Write-Output 'Native package payload, provenance and all checksums verified.'
