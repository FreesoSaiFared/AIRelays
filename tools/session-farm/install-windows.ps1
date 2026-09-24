param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")),
    [string]$ConfigPath = "$env:LOCALAPPDATA\AIRelays\session-farm\session-farm.config.json",
    [string]$TaskName = "AIRelays-SessionFarm",
    [string]$RunAsUser = "",
    [switch]$StartNow
)

$ErrorActionPreference = "Stop"

$Node = (Get-Command node.exe -ErrorAction Stop).Source
$FarmScript = Join-Path $RepoRoot "tools\session-farm\session-farm.mjs"
$ExampleConfig = Join-Path $RepoRoot "tools\session-farm\session-farm.config.example.json"

if (-not (Test-Path $FarmScript)) {
    throw "session-farm.mjs not found: $FarmScript"
}
if (-not (Test-Path $ExampleConfig)) {
    throw "example config not found: $ExampleConfig"
}

if (-not $RunAsUser) {
    $Identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    if ($Identity -match '\\SYSTEM$') {
        $RunAsUser = [string](Get-CimInstance Win32_ComputerSystem).UserName
        if (-not $RunAsUser) {
            throw "Session Farm deployment is running as SYSTEM but no interactive Windows user is logged in. Log in to the Brave desktop account or pass -RunAsUser explicitly."
        }
    } else {
        $RunAsUser = $Identity
    }
}

$ConfigDir = Split-Path -Parent $ConfigPath
New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
if (-not (Test-Path $ConfigPath)) {
    Copy-Item $ExampleConfig $ConfigPath
    Write-Host "Created config: $ConfigPath"
    Write-Host "Edit orchestrator.urlIncludes before relying on autonomous continuation."
}

$Arguments = '"{0}" --config "{1}"' -f $FarmScript, $ConfigPath
$Action = New-ScheduledTaskAction -Execute $Node -Argument $Arguments -WorkingDirectory $RepoRoot
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $RunAsUser
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

$Principal = New-ScheduledTaskPrincipal -UserId $RunAsUser -LogonType Interactive -RunLevel Highest
$Task = New-ScheduledTask -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Description "External six-worker ChatGPT continuation farm with one orchestrator; browser-extension-free continuation."
Register-ScheduledTask -TaskName $TaskName -InputObject $Task -Force | Out-Null

if ($StartNow) {
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 2
}

$TaskInfo = Get-ScheduledTask -TaskName $TaskName
$Info = Get-ScheduledTaskInfo -TaskName $TaskName
[pscustomobject]@{
    taskName = $TaskName
    node = $Node
    farmScript = $FarmScript
    configPath = $ConfigPath
    runAsUser = $RunAsUser
    state = $TaskInfo.State.ToString()
    lastRunTime = $Info.LastRunTime
    lastTaskResult = $Info.LastTaskResult
} | ConvertTo-Json -Depth 5
