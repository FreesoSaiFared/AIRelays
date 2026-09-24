#Requires -Version 5.1
#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [string]$TaskName = 'Transductive-Windows-MCP-Relay',
    [switch]$KeepPairingState
)
$ErrorActionPreference = 'Stop'
$Root = Join-Path $env:ProgramData 'Transductive\WindowsMCP'
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
if (-not $KeepPairingState) {
    Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $Root 'device.json.dpapi')
}
Write-Host "Transductive Windows MCP relay task removed. Runtime left at $Root for cheap repair/reinstall."
