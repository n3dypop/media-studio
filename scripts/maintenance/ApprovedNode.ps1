# The installation config is explicit; a missing or differing manifest fails closed.
function Enter-ApprovedMaintenanceNode([string]$Root,[string]$NodePath) {
    $path=Join-Path $Root 'runtime/maintenance/approved-node.json'
    $manifest=$null;$exe=$null
    try {
        foreach($itemPath in @($path,$NodePath)){
            $item=Get-Item -LiteralPath $itemPath -Force -ErrorAction Stop
            if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Approved Node input is unsafe.'}
            $parent=$item.Directory
            while($parent){$directory=Get-Item -LiteralPath $parent.FullName -Force -ErrorAction Stop;if($directory.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Approved Node parent is unsafe.'};$parent=$parent.Parent}
        }
        $manifest=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        if($manifest.Length -lt 2 -or $manifest.Length -gt 4096){throw 'Approved Node manifest length is invalid.'}
        $reader=[IO.StreamReader]::new($manifest,[Text.Encoding]::UTF8,$true,1024,$true)
        try{$config=$reader.ReadToEnd()|ConvertFrom-Json}finally{$reader.Dispose()}
        if(-not [IO.Path]::IsPathFullyQualified([string]$config.path) -or [string]$config.sha256 -cnotmatch '^[a-f0-9]{64}$' -or -not [String]::Equals([IO.Path]::GetFullPath([string]$config.path),[IO.Path]::GetFullPath($NodePath),[StringComparison]::OrdinalIgnoreCase)){throw 'Node is not the configured approved executable.'}
        $exe=[IO.File]::Open($NodePath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        $actual=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($exe)).ToLowerInvariant()
        if($actual -cne [string]$config.sha256){throw 'Approved Node executable hash differs.'}
        return @{Manifest=$manifest;Executable=$exe}
    } catch {if($exe){$exe.Dispose()};if($manifest){$manifest.Dispose()};throw}
}

# Pin the fixed Host verifier from explicit local configuration. The returned
# handles stay held through the probe; no HTTP value supplies the hash.
function Enter-ApprovedMaintenanceHostHelper([string]$Root,[string]$HelperPath) {
    $path=Join-Path $Root 'runtime/maintenance/approved-host-helper.json'
    $manifest=$null;$helper=$null
    try {
        foreach($itemPath in @($path,$HelperPath)){
            $item=Get-Item -LiteralPath $itemPath -Force -ErrorAction Stop
            if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Approved Host helper input is unsafe.'}
            $parent=$item.Directory
            while($parent){$directory=Get-Item -LiteralPath $parent.FullName -Force -ErrorAction Stop;if($directory.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Approved Host helper parent is unsafe.'};$parent=$parent.Parent}
        }
        $manifest=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        if($manifest.Length -lt 2 -or $manifest.Length -gt 4096){throw 'Approved Host helper manifest length is invalid.'}
        $reader=[IO.StreamReader]::new($manifest,[Text.Encoding]::UTF8,$true,1024,$true)
        try{$config=$reader.ReadToEnd()|ConvertFrom-Json}finally{$reader.Dispose()}
        if(-not [IO.Path]::IsPathFullyQualified([string]$config.path) -or [string]$config.sha256 -cnotmatch '^[a-f0-9]{64}$' -or -not [String]::Equals([IO.Path]::GetFullPath([string]$config.path),[IO.Path]::GetFullPath($HelperPath),[StringComparison]::OrdinalIgnoreCase)){throw 'Host helper is not the configured approved file.'}
        $helper=[IO.File]::Open($HelperPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        $actual=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($helper)).ToLowerInvariant()
        if($actual -cne [string]$config.sha256){throw 'Approved Host helper hash differs.'}
        return @{Manifest=$manifest;File=$helper;Hash=$actual}
    } catch {if($helper){$helper.Dispose()};if($manifest){$manifest.Dispose()};throw}
}
