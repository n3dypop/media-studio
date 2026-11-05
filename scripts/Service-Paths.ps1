# Shared effective executable paths; the DSH Node runtime remains independent.
function Get-ControllerNodeExecutable([string]$TaskRoot,$Environment) {
    $value=if ($Environment.controllerNodeExecutable) { [string]$Environment.controllerNodeExecutable } else { Join-Path $TaskRoot ($Environment.nodeDirectory+'/node.exe') }
    if (-not [IO.Path]::IsPathFullyQualified($value) -or $value -notmatch '^[a-zA-Z]:[\\/]' -or $value.Substring(2).Contains(':') -or $value -ne $value.Trim()) { throw 'Controller Node must use an absolute local path.' }
    $result=[IO.Path]::GetFullPath($value)
    if ([IO.Path]::GetFileName($result) -ine 'node.exe') { throw 'Controller Node must be an explicit local node.exe.' }
    return $result
}
function Test-ControllerNodeRuntime([string]$Executable) {
    if (-not [IO.Path]::IsPathFullyQualified($Executable) -or $Executable.StartsWith('\\') -or [IO.Path]::GetFileName($Executable) -ine 'node.exe') { throw 'Controller Node must be an explicit local node.exe.' }
    $expected=[IO.Path]::GetFullPath($Executable)
    $cursor=$expected
    while($cursor) {
        $entry=Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Controller Node path cannot contain a junction or symlink.' }
        $parent=[IO.Path]::GetDirectoryName($cursor)
        if(-not $parent -or $parent -eq $cursor){break}
        $cursor=$parent
    }
    if (-not (Test-Path -LiteralPath $expected -PathType Leaf)) { throw 'Controller Node executable is missing.' }
    $source=@'
import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync(':memory:');
try { db.exec('CREATE TABLE t(v INTEGER); BEGIN IMMEDIATE');db.prepare('INSERT INTO t VALUES(?)').run(1);db.exec('COMMIT');
  if(db.prepare('SELECT v FROM t').all()[0]?.v!==1 || db.prepare('SELECT v FROM t').get()?.v!==1 || typeof fetch!=='function' || typeof AbortSignal.any!=='function') throw Error('Missing runtime capability');
  process.stdout.write(JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch,executable:process.execPath}));
} finally { db.close(); }
'@
    $start=[Diagnostics.ProcessStartInfo]::new()
    $start.FileName=$expected
    $start.UseShellExecute=$false
    $start.CreateNoWindow=$true
    $start.RedirectStandardOutput=$true
    $start.RedirectStandardError=$true
    [void]$start.Environment.Remove('NODE_OPTIONS')
    foreach($argument in @('--no-warnings','--input-type=module','-e',$source)){[void]$start.ArgumentList.Add($argument)}
    $process=[Diagnostics.Process]::new()
    $process.StartInfo=$start
    try {
        if(-not $process.Start()){throw 'Node probe did not start.'}
        $output=$process.StandardOutput.ReadToEndAsync()
        $errors=$process.StandardError.ReadToEndAsync()
        if(-not $process.WaitForExit(10000)){try{$process.Kill()}catch{};throw 'Node probe timed out.'}
        if($process.ExitCode -ne 0){throw 'Node probe failed.'}
        $text=$output.GetAwaiter().GetResult();[void]$errors.GetAwaiter().GetResult()
        if($text.Length -gt 16384){throw 'Node probe response is too large.'}
        $observed=$text | ConvertFrom-Json -ErrorAction Stop
        if ([string]$observed.version -notmatch '^24\.\d+\.\d+$' -or $observed.platform -ne 'win32' -or $observed.arch -ne 'x64' -or -not [IO.Path]::IsPathFullyQualified([string]$observed.executable) -or [IO.Path]::GetFullPath([string]$observed.executable) -ine $expected) { throw 'Node process identity or version differs.' }
        return [pscustomobject]@{executable=$expected;version=[string]$observed.version}
    } catch { throw 'Controller requires a direct Windows x64 Node.js 24 executable with node:sqlite support.' }
    finally { $process.Dispose() }
}
function Get-StrataPythonExecutable($Environment,$Receipt) {
    if (-not $Receipt.control -or -not $Receipt.prepared -or $Receipt.schemaVersion -ne 1) { throw 'Strata installation receipt is unavailable.' }
    $product=[IO.Path]::GetFullPath([string]$(if ($Environment.strataDirectory) { $Environment.strataDirectory } else { $Receipt.productRoot }))
    $control=[IO.Path]::GetFullPath([string]$Receipt.control)
    if ([IO.Path]::GetFullPath([string]$Receipt.productRoot) -ne $product -or -not $control.StartsWith((Join-Path $product '.runtime/terminal')+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Strata product identity differs.' }
    $expected=[IO.Path]::GetFullPath((Join-Path $Receipt.control 'python/python.exe'))
    $value=if ($Environment.strataPythonExecutable) { [string]$Environment.strataPythonExecutable } else { $expected }
    if (-not [IO.Path]::IsPathFullyQualified($value) -or $value.StartsWith('\\')) { throw 'Strata Python must use an absolute local path.' }
    $result=[IO.Path]::GetFullPath($value)
    if ($result -ne $expected) { throw 'Strata Python differs from its prepared installation.' }
    return $result
}
