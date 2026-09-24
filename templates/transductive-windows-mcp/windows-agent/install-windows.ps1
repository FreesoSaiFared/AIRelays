#Requires -Version 5.1
#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidatePattern('^https://')][string]$WorkerUrl,
    [Parameter(Mandatory=$true)][ValidatePattern('^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$')][string]$PairCode,
    [string]$PythonCommand = 'py',
    [string]$TaskName = 'Transductive-Windows-MCP-Relay',
    [switch]$SkipAgentUi
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root = Join-Path $env:ProgramData 'Transductive\WindowsMCP'
$Venv = Join-Path $Root 'runtime'
$Python = Join-Path $Venv 'Scripts\python.exe'
$Evidence = Join-Path $Root 'install-receipt.json'
$AgentSource = $PSScriptRoot

function Write-Step([string]$Text) {
    Write-Host ("[Transductive Windows MCP] {0}" -f $Text)
}

function Invoke-PythonBootstrap {
    if ($PythonCommand -eq 'py') {
        & py -3 -m venv $Venv
    } else {
        & $PythonCommand -m venv $Venv
    }
    if ($LASTEXITCODE -ne 0) { throw 'Python virtual environment creation failed.' }
}

New-Item -ItemType Directory -Force -Path $Root | Out-Null
Write-Step "install root: $Root"

if (-not (Test-Path $Python)) {
    Write-Step 'creating isolated Python runtime'
    Invoke-PythonBootstrap
}

Write-Step 'installing pinned relay + upstream winrdp-mcp 0.1.5'
& $Python -m pip install --disable-pip-version-check --upgrade pip
if ($LASTEXITCODE -ne 0) { throw 'pip upgrade failed.' }

# The local package is installed from the extracted release capsule. Its pyproject
# pins winrdp-mcp[agent-ui]==0.1.5. SkipAgentUi is reserved for a future minimal
# package split; the current capsule intentionally includes the full upstream UI extra.
& $Python -m pip install --disable-pip-version-check $AgentSource
if ($LASTEXITCODE -ne 0) { throw 'agent installation failed.' }

Write-Step 'claiming one-time device pairing code'
$pairRaw = & $Python -m transductive_agent pair --worker $WorkerUrl --code $PairCode 2>&1
if ($LASTEXITCODE -ne 0) { throw ("pairing failed: {0}" -f ($pairRaw -join [Environment]::NewLine)) }
$pairText = ($pairRaw -join [Environment]::NewLine)
$pair = $pairText | ConvertFrom-Json
if (-not $pair.paired -or -not $pair.deviceId) { throw 'pairing did not return a device id.' }

Write-Step "paired device: $($pair.deviceId)"
$Action = New-ScheduledTaskAction -Execute $Python -Argument '-m transductive_agent relay --log-level INFO'
$Trigger = New-ScheduledTaskTrigger -AtStartup
$Principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -MultipleInstances IgnoreNew
$Task = New-ScheduledTask -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings `
    -Description 'Persistent outbound relay from this Windows machine to its user-owned Transductive Cloudflare MCP Worker.'
Register-ScheduledTask -TaskName $TaskName -InputObject $Task -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 4

$TaskState = (Get-ScheduledTask -TaskName $TaskName).State.ToString()
$StatusUrl = ('{0}/agent/status?device={1}' -f $WorkerUrl.TrimEnd('/'), [Uri]::EscapeDataString([string]$pair.deviceId))
$remote = $null
try {
    $remote = Invoke-RestMethod -Uri $StatusUrl -Method Get -TimeoutSec 15
} catch {
    $remote = [ordered]@{ online = $false; probeError = $_.Exception.Message }
}

$receipt = [ordered]@{
    schema = 'TRANSDUCTIVE_WINDOWS_MCP_INSTALL_RECEIPT/1'
    installedAt = (Get-Date).ToUniversalTime().ToString('o')
    workerUrl = $WorkerUrl.TrimEnd('/')
    deviceId = [string]$pair.deviceId
    label = $pair.label
    python = $Python
    taskName = $TaskName
    taskState = $TaskState
    remoteOnline = [bool]$remote.online
    configPath = $pair.configPath
    secretStorage = $pair.secretStoredWith
    upstream = 'winrdp-mcp[agent-ui]==0.1.5'
    note = 'The SYSTEM relay provides durable shell/files/service control. Interactive desktop tools still require an interactive Windows session when the upstream UI mechanism requires one.'
}
$receipt | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 $Evidence
$receipt | ConvertTo-Json -Depth 6

if ($TaskState -ne 'Running') {
    throw "Scheduled relay task is not running (state=$TaskState). Receipt: $Evidence"
}
if (-not $remote.online) {
    Write-Warning "Relay task is running but Worker did not yet report the device online. Receipt: $Evidence"
}
