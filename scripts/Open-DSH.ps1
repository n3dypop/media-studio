#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
$taskRoot = if ($env:MEDIA_STUDIO_HOME) { if (-not [IO.Path]::IsPathFullyQualified($env:MEDIA_STUDIO_HOME)) { throw 'MEDIA_STUDIO_HOME must be absolute' }; [IO.Path]::GetFullPath($env:MEDIA_STUDIO_HOME) } else { Split-Path $PSScriptRoot -Parent }
& (Join-Path $PSScriptRoot 'Start-Environment.ps1') -Service DSH
$settings = Get-Content -LiteralPath (Join-Path $taskRoot 'config/environment.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$state = Get-Content -LiteralPath (Join-Path $taskRoot 'runtime/DSH.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$startupLog = Get-Content -LiteralPath $state.stdout -Raw -Encoding UTF8
$baseUrl = "http://127.0.0.1:$($settings.dshPort)/"
$launchMatch = [regex]::Match($startupLog, [regex]::Escape($baseUrl) + '\?token=[A-Za-z0-9_-]+')
if (-not $launchMatch.Success) { throw 'DSH launch token is unavailable. See logs/dsh.' }
# An interactive browser is intentional here; the user invoked Open-DSH.cmd.
try { Start-Process $launchMatch.Value -ErrorAction Stop | Out-Null }
catch { throw 'Could not open the authenticated DSH browser session. Check the default browser and local DSH logs.' }
