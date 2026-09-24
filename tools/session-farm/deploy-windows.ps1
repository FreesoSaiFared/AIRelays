param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")),
    [string]$ConfigPath = "$env:LOCALAPPDATA\AIRelays\session-farm\session-farm.config.json",
    [switch]$UpdateFromMain,
    [switch]$EnableSelfHealing,
    [switch]$StartNow,
    [switch]$SkipTests,
    [switch]$ValidationOnly
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-Checked {
    param([string]$File, [string[]]$Args)
    & $File @Args
    if ($LASTEXITCODE -ne 0) { throw "$File failed with exit code $LASTEXITCODE" }
}

$RepoRoot = (Resolve-Path $RepoRoot).Path
$SessionFarm = Join-Path $RepoRoot "tools\session-farm"
$ExampleConfig = Join-Path $SessionFarm "session-farm.config.example.json"
$Installer = Join-Path $SessionFarm "install-windows.ps1"

if (-not (Test-Path $SessionFarm)) { throw "session-farm directory not found: $SessionFarm" }
if (-not (Test-Path $ExampleConfig)) { throw "example config not found: $ExampleConfig" }
if (-not (Test-Path $Installer)) { throw "installer not found: $Installer" }

$Node = (Get-Command node.exe -ErrorAction Stop).Source
$VersionText = (& $Node --version).Trim()
$NodeMajor = [int](($VersionText -replace '^v','').Split('.')[0])
if ($NodeMajor -lt 22) { throw "Node.js 22+ required; found $VersionText" }

if ($UpdateFromMain) {
    $Git = (Get-Command git.exe -ErrorAction Stop).Source
    Push-Location $RepoRoot
    try {
        Invoke-Checked $Git @('fetch','origin','main')
        $Branch = (& $Git branch --show-current).Trim()
        if ($Branch -ne 'main') { throw "Refusing to update non-main branch '$Branch'. Switch to main or omit -UpdateFromMain." }
        Invoke-Checked $Git @('merge','--ff-only','origin/main')
    } finally { Pop-Location }
}

$Validation = [ordered]@{
    syntax = [ordered]@{}
    tests = $null
}

if (-not $SkipTests) {
    foreach ($Entry in @('session-farm.mjs','session-farm-mcp.mjs','session-farm-http-mcp.mjs')) {
        Invoke-Checked $Node @('--check',(Join-Path $SessionFarm $Entry))
        $Validation.syntax[$Entry] = $true
    }
    Invoke-Checked $Node @('--test',(Join-Path $SessionFarm 'session-farm.test.mjs'))
    $Validation.tests = $true
}

if ($ValidationOnly) {
    [pscustomobject]@{
        ok = $true
        validationOnly = $true
        repoRoot = $RepoRoot
        node = $VersionText
        validation = $Validation
    } | ConvertTo-Json -Depth 20
    return
}

$ConfigDir = Split-Path -Parent $ConfigPath
New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
if (-not (Test-Path $ConfigPath)) { Copy-Item $ExampleConfig $ConfigPath }

$Config = Get-Content -Raw $ConfigPath | ConvertFrom-Json
if ($EnableSelfHealing) {
    if (-not $Config.browser) { $Config | Add-Member -NotePropertyName browser -NotePropertyValue ([pscustomobject]@{}) }
    if ($null -eq $Config.browser.PSObject.Properties['ensureTabs']) { $Config.browser | Add-Member -NotePropertyName ensureTabs -NotePropertyValue $true }
    else { $Config.browser.ensureTabs = $true }
    $Config | ConvertTo-Json -Depth 20 | Set-Content -Encoding UTF8 $ConfigPath
}

$InstallArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$Installer,'-RepoRoot',$RepoRoot,'-ConfigPath',$ConfigPath)
if ($StartNow) { $InstallArgs += '-StartNow' }
Invoke-Checked 'powershell.exe' $InstallArgs

$Config = Get-Content -Raw $ConfigPath | ConvertFrom-Json
$DaemonOrigin = "http://$($Config.listen.host):$($Config.listen.port)"
$Health = $null
for ($i=0; $i -lt 40; $i++) {
    try {
        $Health = Invoke-RestMethod -Uri "$DaemonOrigin/healthz" -TimeoutSec 2
        if ($Health.ok) { break }
    } catch {}
    Start-Sleep -Milliseconds 250
}

$Task = Get-ScheduledTask -TaskName 'AIRelays-SessionFarm' -ErrorAction SilentlyContinue
$TaskInfo = if ($Task) { Get-ScheduledTaskInfo -TaskName 'AIRelays-SessionFarm' } else { $null }
$Status = $null
if ($Health -and $Health.ok) {
    try { $Status = Invoke-RestMethod -Uri "$DaemonOrigin/status" -TimeoutSec 3 } catch {}
}

[pscustomobject]@{
    ok = [bool]($Health -and $Health.ok)
    validationOnly = $false
    repoRoot = $RepoRoot
    node = $VersionText
    validation = $Validation
    configPath = $ConfigPath
    selfHealing = [bool]$Config.browser.ensureTabs
    daemonOrigin = $DaemonOrigin
    health = $Health
    taskState = if ($Task) { $Task.State.ToString() } else { 'missing' }
    lastTaskResult = if ($TaskInfo) { $TaskInfo.LastTaskResult } else { $null }
    slotCount = if ($Status -and $Status.slots) { @($Status.slots.PSObject.Properties).Count } else { $null }
    lastTickAt = if ($Status) { $Status.lastTickAt } else { $null }
} | ConvertTo-Json -Depth 20
