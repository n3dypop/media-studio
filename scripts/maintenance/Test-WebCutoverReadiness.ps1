# Read-only inventory of pinned Web cutover components. It cannot by itself
# establish the dynamic conditions needed for execution.
function Get-FixedWebCutoverComponents([string]$Install,[string]$Namespace,[string]$WrapperPath){
    $routeRoot=Join-Path $Namespace 'dsh-plugins/apps/dsh-plugins/studio-host';$search=Join-Path $Install 'apps/controller/search';$maint=Join-Path $Install 'scripts/maintenance'
    return [ordered]@{
        wrapper=$WrapperPath;hostVerifier=(Join-Path $maint 'Verify-WebHostOwner.ps1');hostFence=(Join-Path $maint 'WebCutoverHostFence.ps1');desktopCheck=(Join-Path $maint 'Confirm-DesktopStopped.ps1');launchHelper=(Join-Path $Install 'scripts/DshLaunchLock.ps1');approval=(Join-Path $maint 'ApprovedNode.ps1');readiness=(Join-Path $maint 'Test-WebCutoverReadiness.ps1');waitHelper=(Join-Path $maint 'Wait-OwnedProbe.ps1');probe=(Join-Path $search 'cutover-maintenance-probe.mjs');
        hostStop=(Join-Path $search 'cutover-host-stop.mjs');controllerFence=(Join-Path $search 'cutover-controller-fence.mjs');controllerShutdown=(Join-Path $search 'cutover-controller-shutdown.mjs');wrapperFence=(Join-Path $search 'cutover-wrapper-fence.mjs');
        backup=(Join-Path $search 'cutover-backup.mjs');preopen=(Join-Path $search 'cutover-controller-preopen.mjs');preopenGuard=(Join-Path $search 'cutover-preopen-guard.mjs');cutoverLedger=(Join-Path $search 'cutover-ledger.mjs');evidenceFiles=(Join-Path $search 'cutover-evidence-files.mjs');
        sessionLease=(Join-Path $search 'cutover-web-session-lease.mjs');commit=(Join-Path $search 'cutover-transaction.mjs');
        evidence=(Join-Path $search 'cutover-web-evidence.mjs');controllerStore=(Join-Path $Install 'apps/controller/store.mjs');controllerEpoch=(Join-Path $Install 'apps/controller/epoch.mjs');strataEpoch=(Join-Path $Install 'apps/controller/strata-epoch.mjs');strataClient=(Join-Path $Install 'apps/controller/strata.mjs');servicePaths=(Join-Path $Install 'apps/controller/service-paths.mjs');serverRecovery=(Join-Path $Install 'apps/controller/server-recovery.mjs');schemaIntegrity=(Join-Path $Install 'apps/controller/schema-integrity.mjs');searchService=(Join-Path $search 'service.mjs');searchConfig=(Join-Path $search 'config.mjs');hostOwner=(Join-Path $Install 'apps/dsh-plugins/studio-services/maintenance-owner.mjs');
        hostStopRoute=(Join-Path $routeRoot 'maintenance-stop-route.mjs');hostStopLedger=(Join-Path $routeRoot 'maintenance-ledger.mjs');restartState=(Join-Path $routeRoot 'restart-state.mjs');
        entry=(Join-Path $search 'cutover-maintenance-execute.mjs');observer=(Join-Path $search 'cutover-host-observer.mjs')
    }
}

# The caller must hold the returned streams until the owned child exits.
# Pinning components does not by itself authorize or perform maintenance.
function Enter-ApprovedWebCutoverComponents([string]$RuntimeRoot,[string]$NodePath,[string]$WrapperPath){
    $report=Get-WebCutoverReadiness $RuntimeRoot $NodePath $WrapperPath
    if($report.manifest -cne 'checked' -or @($report.components|Where-Object {$_.status -cne 'matched'}).Count -ne 0){throw 'Cutover component approval is incomplete.'}
    $install=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'));$namespace=Split-Path $install -Parent;$fixed=Get-FixedWebCutoverComponents $install $namespace $WrapperPath
    $manifest=$null;$handles=[Collections.Generic.List[IO.FileStream]]::new()
    try{
        $manifest=[IO.File]::Open((Join-Path $RuntimeRoot 'runtime/maintenance/approved-cutover-components.json'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        $reader=[IO.StreamReader]::new($manifest,[Text.Encoding]::UTF8,$true,1024,$true);try{$config=$reader.ReadToEnd()|ConvertFrom-Json -AsHashtable}finally{$reader.Dispose()}
        if($config.version -ne 1 -or -not [String]::Equals([IO.Path]::GetFullPath([string]$config.runtimeRoot),[IO.Path]::GetFullPath($RuntimeRoot),[StringComparison]::OrdinalIgnoreCase)){throw 'Cutover approval changed.'}
        foreach($name in $fixed.Keys){$path=$fixed[$name];$item=Get-Item -LiteralPath $path -Force -ErrorAction Stop;if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Cutover component is unsafe.'};$stream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);$handles.Add($stream);$hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant();if($hash -cne [string]$config.pins[$name]){throw 'Cutover component approval changed.'}}
        return @{Manifest=$manifest;Files=$handles}
    }catch{foreach($stream in $handles){$stream.Dispose()};if($manifest){$manifest.Dispose()};throw}
}
function Get-WebCutoverReadiness([string]$RuntimeRoot,[string]$NodePath,[string]$WrapperPath) {
    $install=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
    $namespace=Split-Path $install -Parent;$plugins=Split-Path $namespace -Parent;$runtimeBase=Split-Path $plugins -Parent
    if((Split-Path $install -Leaf) -cne 'media-studio' -or (Split-Path $namespace -Leaf) -cne 'n3dypop' -or (Split-Path $plugins -Leaf) -cne 'plugins' -or (Split-Path $runtimeBase -Leaf) -cne '.runtime'){throw 'Installed plugin layout differs.'}
    $root=[IO.Path]::GetFullPath($RuntimeRoot);$expectedRoot=Join-Path $runtimeBase 'media-studio'
    if(-not [String]::Equals($root,$expectedRoot,[StringComparison]::OrdinalIgnoreCase)){throw 'Explicit runtime root differs from the installed product.'}
    foreach($path in @($root,$install,$namespace,$plugins,$runtimeBase)){$item=Get-Item -LiteralPath $path -Force -ErrorAction Stop;if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Runtime or installation directory is unsafe.'}}
    $checkParents={param([string]$Path)
        $directory=Split-Path $Path -Parent
        while($directory){$item=Get-Item -LiteralPath $directory -Force -ErrorAction Stop;if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Component parent is unsafe.'};$next=Split-Path $directory -Parent;if($next -eq $directory){break};$directory=$next}
    }
    $manifestPath=Join-Path $root 'runtime/maintenance/approved-cutover-components.json'
    $report=[ordered]@{inspectionOnly=$true;dynamicReadiness='unconfirmed';runtimeRoot=$root;manifest='unavailable';components=@();checksRequired=@('desktop-absence','live-host-route','live-controller-idle','recovery-evidence')}
    if(Test-Path -LiteralPath (Join-Path $root 'runtime/maintenance/approved-cutover-components.pending.json')){$report.manifest='approval-pending';return $report}
    if(-not(Test-Path -LiteralPath $manifestPath -PathType Leaf)){return $report}
    $node=$null;$approvedHost=$null;$manifest=$null
    try {
        & $checkParents $manifestPath;$manifestItem=Get-Item -LiteralPath $manifestPath -Force;if($manifestItem.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Component manifest is unsafe.'}
        $manifest=[IO.File]::Open($manifestPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        if($manifest.Length -lt 2 -or $manifest.Length -gt 32768){throw 'Component manifest length differs.'}
        $reader=[IO.StreamReader]::new($manifest,[Text.Encoding]::UTF8,$true,1024,$true);try{$config=$reader.ReadToEnd()|ConvertFrom-Json -AsHashtable}finally{$reader.Dispose()}
        if($config.version -ne 1 -or -not [IO.Path]::IsPathFullyQualified([string]$config.runtimeRoot) -or -not [String]::Equals([IO.Path]::GetFullPath([string]$config.runtimeRoot),$root,[StringComparison]::OrdinalIgnoreCase) -or $config.pins -isnot [System.Collections.IDictionary]){throw 'Component manifest identity differs.'}
        $node=Enter-ApprovedMaintenanceNode $root $NodePath;$approvedHost=Enter-ApprovedMaintenanceHostHelper $root (Join-Path $PSScriptRoot 'Verify-WebHostOwner.ps1')
        $fixed=Get-FixedWebCutoverComponents $install $namespace $WrapperPath
        foreach($name in $fixed.Keys){
            $path=$fixed[$name];$status='unavailable';$pin=[string]$config.pins[$name]
            if($pin -cnotmatch '^[a-f0-9]{64}$'){$status='pin-unavailable'}
            elseif(Test-Path -LiteralPath $path -PathType Leaf){$item=Get-Item -LiteralPath $path -Force;if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){$status='unsafe'}else{try{& $checkParents $path;$file=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);try{$hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($file)).ToLowerInvariant();$status=if($hash -ceq $pin){'matched'}else{'hash-differs'}}finally{$file.Dispose()}}catch{$status='unsafe'}}}
            $report.components+=@{name=$name;status=$status}
        }
        $report.manifest='checked'
        return $report
    } finally {if($approvedHost){$approvedHost.File.Dispose();$approvedHost.Manifest.Dispose()};if($node){$node.Executable.Dispose();$node.Manifest.Dispose()};if($manifest){$manifest.Dispose()}}
}
