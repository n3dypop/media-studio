# A missing or incomplete guard is never interpreted as a ready profile. All
# mutating callers hold the shared DSH launch lock throughout the operation.
function Read-DesktopProfileGuard([string] $RuntimeRoot) {
    $root=[IO.Path]::GetFullPath($RuntimeRoot)
    $directory=Join-Path $root 'data\maintenance\desktop-profile-guard'
    $current=[IO.Path]::GetPathRoot($directory)
    foreach($name in ($directory.Substring($current.Length) -split '[\\/]' | Where-Object { $_ })){
        $current=Join-Path $current $name
        $item=Get-Item -LiteralPath $current -Force -ErrorAction Stop
        if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Desktop profile guard has an indirect path.'}
    }
    $acl=Get-Acl -LiteralPath $directory
    $user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $system='S-1-5-18'
    $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
    if(-not $acl.AreAccessRulesProtected -or $rules.Count -ne 2 -or @($rules | Where-Object { $_.IdentityReference.Value -notin @($user,$system) -or $_.AccessControlType -ne 'Allow' }).Count -ne 0){throw 'Desktop profile guard is not private.'}
    $identityPath=Join-Path $directory 'identity.json';$statusPath=Join-Path $directory 'status.json'
    foreach($file in @($identityPath,$statusPath)){
        $item=Get-Item -LiteralPath $file -Force -ErrorAction Stop
        if($item.PSIsContainer -or $item.LinkType -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt 8192){throw 'Desktop profile guard file is invalid.'}
    }
    $identity=Get-Content -LiteralPath $identityPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $status=Get-Content -LiteralPath $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if($identity.schema -ne 1 -or $identity.generation -cnotmatch '^[a-f0-9]{32}$' -or @($identity.PSObject.Properties).Count -ne 2 -or $status.schema -ne 1 -or $status.generation -cne $identity.generation -or $status.state -notin @('ready','pending')){throw 'Desktop profile guard identity differs.'}
    $keys=@($status.PSObject.Properties.Name)
    if($status.state -eq 'ready'){
        if($keys.Count -ne 3){throw 'Desktop profile ready marker is malformed.'}
    } elseif($keys.Count -ne 8 -or $status.operationId -cnotmatch '^[a-f0-9]{32}$' -or $status.operation -notin @('Apply','Restore') -or $status.beforeSha256 -cnotmatch '^[a-f0-9]{64}$' -or $status.afterSha256 -cnotmatch '^[a-f0-9]{64}$' -or $status.targetIdentity -cnotmatch '^[a-f0-9]{8}:[a-f0-9]{16}$'){
        throw 'Desktop profile pending marker is malformed.'
    }
    return @{directory=$directory;statusPath=$statusPath;identity=$identity;status=$status}
}
function Write-DesktopProfileGuard([string] $RuntimeRoot,[string] $ExpectedState,[string] $ExpectedOperation,[hashtable] $Next) {
    $guard=Read-DesktopProfileGuard $RuntimeRoot
    if($guard.status.state -cne $ExpectedState -or ($ExpectedState -eq 'pending' -and $guard.status.operationId -cne $ExpectedOperation)){throw 'Desktop profile guard changed.'}
    if($Next.schema -ne 1 -or $Next.generation -cne $guard.identity.generation -or $Next.state -notin @('ready','pending')){throw 'Next Desktop profile guard is invalid.'}
    $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Next | ConvertTo-Json -Compress))
    $file=[IO.File]::Open($guard.statusPath,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    try {
        $file.SetLength(0);$file.Write($bytes,0,$bytes.Length);$file.Flush($true)
        $file.Position=0;$read=[byte[]]::new($bytes.Length);$count=$file.Read($read,0,$read.Length)
        if($count -ne $bytes.Length -or [Convert]::ToBase64String($read) -cne [Convert]::ToBase64String($bytes)){throw 'Desktop profile guard write is unconfirmed.'}
    } finally {$file.Dispose()}
    $verified=Read-DesktopProfileGuard $RuntimeRoot
    if($verified.status.state -cne $Next.state -or ($Next.state -eq 'pending' -and $verified.status.operationId -cne $Next.operationId)){throw 'Desktop profile guard readback differs.'}
}
