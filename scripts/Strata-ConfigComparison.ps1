# Pure comparison of the desired configuration and a saved launch record.
# The caller decides whether process identity has been verified.
function Compare-StrataConfigHash {
    param([Parameter(Mandatory)][string]$DesiredHash, $RecordedState)
    if ($DesiredHash -notmatch '^[a-f0-9]{64}$') { throw 'Desired Strata configuration hash is invalid.' }
    $recorded = $null
    if ($null -ne $RecordedState -and [string]$RecordedState.configSha256 -match '^[a-f0-9]{64}$') {
        $recorded = ([string]$RecordedState.configSha256).ToLowerInvariant()
    }
    $matches = $null
    if ($null -ne $recorded) { $matches = ($recorded -ceq $DesiredHash) }
    return [ordered]@{
        desiredConfigSha256 = $DesiredHash
        recordedLaunchConfigSha256 = $recorded
        recordMatchesDesired = $matches
        recordEvidence = 'Saved launch record only; a live process or loaded model is not established by this comparison.'
    }
}
