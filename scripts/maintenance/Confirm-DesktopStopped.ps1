# Read-only process observation for the supported Desktop installation.
# It does not stop or modify any process.
#Requires -Version 7.0
$ErrorActionPreference='Stop'
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'DshLaunchLock.ps1')
Assert-DefaultDshDesktopStopped
