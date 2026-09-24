#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$TemplateRoot = $PSScriptRoot,
    [string]$RelayTaskName = 'Transductive-Windows-MCP-Relay',
    [switch]$SkipCloudflare,
    [switch]$SkipAgent,
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$TemplateRoot = (Resolve-Path $TemplateRoot).Path
$AgentSource = Join-Path $TemplateRoot 'windows-agent'
$Root = Join-Path $env:ProgramData 'Transductive\WindowsMCP'
$Python = Join-Path $Root 'runtime\Scripts\python.exe'

function Invoke-Checked {
    param([string]$File, [string[]]$Args, [string]$WorkingDirectory = $TemplateRoot)
    Push-Location $WorkingDirectory
    try {
        & $File @Args
        if ($LASTEXITCODE -ne 0) { throw "$File failed with exit code $LASTEXITCODE" }
    } finally { Pop-Location }
}

$Receipt = [ordered]@{
    schema = 'TRANSDUCTIVE_WINDOWS_MCP_UPGRADE_RECEIPT/1'
    upgradedAt = (Get-Date).ToUniversalTime().ToString('o')
    templateRoot = $TemplateRoot
    cloudflare = [ordered]@{ attempted = $false; deployed = $false }
    agent = [ordered]@{ attempted = $false; upgraded = $false; taskState = $null }
    validation = [ordered]@{}
}

if (-not $SkipTests) {
    $Node = (Get-Command node.exe -ErrorAction Stop).Source
    Invoke-Checked $Node @((Join-Path $TemplateRoot 'tests\template-smoke.mjs'))
    Invoke-Checked $Node @((Join-Path $TemplateRoot 'tests\security-regression.mjs'))
    $PyForCompile = if (Test-Path $Python) { $Python } else { (Get-Command python.exe -ErrorAction Stop).Source }
    Invoke-Checked $PyForCompile @('-m','compileall',(Join-Path $AgentSource 'transductive_agent'))
    $Receipt.validation.contract = $true
    $Receipt.validation.security = $true
    $Receipt.validation.agentCompile = $true
}

if (-not $SkipAgent) {
    $Receipt.agent.attempted = $true
    if (-not (Test-Path $Python)) {
        throw "Existing relay runtime not found at $Python. Use windows-agent\install-windows.ps1 for first installation."
    }
    if (-not (Test-Path (Join-Path $AgentSource 'pyproject.toml'))) {
        throw "Windows agent source missing from template: $AgentSource"
    }

    Invoke-Checked $Python @('-m','pip','install','--disable-pip-version-check','--upgrade','--force-reinstall',$AgentSource)
    Invoke-Checked $Python @('-c','from transductive_agent.session_farm_bridge import SessionFarmBridge; print("SESSION_FARM_BRIDGE_IMPORT_OK")')

    $Task = Get-ScheduledTask -TaskName $RelayTaskName -ErrorAction Stop
    if ($Task.State -eq 'Running') { Stop-ScheduledTask -TaskName $RelayTaskName }
    Start-ScheduledTask -TaskName $RelayTaskName
    Start-Sleep -Seconds 4
    $Task = Get-ScheduledTask -TaskName $RelayTaskName -ErrorAction Stop
    $Receipt.agent.upgraded = $true
    $Receipt.agent.taskState = $Task.State.ToString()
    $Receipt.agent.runtime = $Python
    if ($Task.State -ne 'Running') {
        throw "Resident relay task failed to return to Running state: $($Task.State)"
    }
}

if (-not $SkipCloudflare) {
    $Receipt.cloudflare.attempted = $true
    $Npm = (Get-Command npm.cmd -ErrorAction Stop).Source
    $Npx = (Get-Command npx.cmd -ErrorAction Stop).Source

    # Keep the repository clean: install transient dependencies without creating a lockfile.
    Invoke-Checked $Npm @('install','--no-package-lock','--ignore-scripts')
    Invoke-Checked $Npm @('test')
    # Wrangler uses the existing authenticated Cloudflare account and preserves remote secrets.
    Invoke-Checked $Npx @('wrangler','deploy')
    $Receipt.cloudflare.deployed = $true
}

$Receipt.ok = [bool](
    ($SkipAgent -or $Receipt.agent.upgraded) -and
    ($SkipCloudflare -or $Receipt.cloudflare.deployed)
)

$Receipt | ConvertTo-Json -Depth 10
