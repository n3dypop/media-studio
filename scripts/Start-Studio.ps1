#Requires -Version 7.4
param([switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
$taskRoot = if ($env:MEDIA_STUDIO_HOME) { if (-not [IO.Path]::IsPathFullyQualified($env:MEDIA_STUDIO_HOME)) { throw 'MEDIA_STUDIO_HOME must be absolute' }; [IO.Path]::GetFullPath($env:MEDIA_STUDIO_HOME) } else { Split-Path $PSScriptRoot -Parent }
$config = Get-Content -LiteralPath (Join-Path $taskRoot 'config/strata.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($config.enabled -isnot [bool]) { throw 'Strata enabled must be a boolean. No services were started.' }

function Invoke-StudioStep([string]$Name, [hashtable]$Parameters = @{}) {
    & (Join-Path $PSScriptRoot $Name) @Parameters
    if (-not $?) { throw "$Name did not complete successfully. Later services were not started." }
}

if (-not $config.enabled) {
    Invoke-StudioStep 'Start-Environment.ps1' @{ Service='All'; ValidateOnly=$ValidateOnly }
    return
}
# Missing configuration means search is not installed. A present but invalid
# configuration is an error; never silently treat it as a disabled service.
$searchPath = Join-Path $taskRoot 'config/rustxng.json'
$searchEnabled = $false
if (Test-Path -LiteralPath $searchPath) {
    $searchConfig = Get-Content -LiteralPath $searchPath -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    if ($null -eq $searchConfig -or $searchConfig -isnot [PSCustomObject]) { throw 'Invalid search configuration. No services were started.' }
    if ($null -ne $searchConfig.PSObject.Properties['enabled'] -and $searchConfig.enabled -isnot [bool]) { throw 'Search enabled must be a boolean. No services were started.' }
    $searchEnabled = $searchConfig.enabled -ne $false
    if ($searchEnabled) { Invoke-StudioStep 'Start-RustXNG.ps1' @{ ValidateOnly=$true } }
}
# Each existing launcher verifies ownership and readiness before the next starts.
# On failure, retain already-running services and their evidence for diagnosis.
Invoke-StudioStep 'Start-Environment.ps1' @{ Service='ComfyUI'; ValidateOnly=$ValidateOnly }
Invoke-StudioStep 'Start-Strata.ps1' @{ ValidateOnly=$ValidateOnly }
if ($searchEnabled) { Invoke-StudioStep 'Start-RustXNG.ps1' @{ ValidateOnly=$ValidateOnly } }
Invoke-StudioStep 'Start-Controller.ps1' @{ ValidateOnly=$ValidateOnly }
Invoke-StudioStep 'Start-Environment.ps1' @{ Service='DSH'; ValidateOnly=$ValidateOnly }
