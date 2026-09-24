param(
    [Parameter(Mandatory=$true)][string]$SessionId,
    [Parameter(Mandatory=$true)][string]$TargetId,
    [Parameter(Mandatory=$true)][string]$Url,
    [string]$Title = ""
)

$ErrorActionPreference = "Stop"

# This adapter intentionally does one thing only: ask the locally installed
# CUA driver to activate the target browser surface before the session-farm
# daemon performs the actual continuation through CDP. It never types text,
# clicks Send, reads the conversation, or owns continuation policy.
#
# Bind it to the local CUA-driver installation using a JSON argv template:
#
#   $env:CUA_DRIVER_ACTIVATE_ARGV_JSON =
#     '["C:\\path\\to\\cua-driver.exe","activate","--url","{url}"]'
#
# The exact CUA-driver command surface is deliberately not guessed here.
# This fails closed until the host-specific activation command is supplied.

$Template = $env:CUA_DRIVER_ACTIVATE_ARGV_JSON
if ([string]::IsNullOrWhiteSpace($Template)) {
    Write-Error "CUA_DRIVER_ACTIVATE_ARGV_JSON is not configured; refusing to invent a CUA-driver invocation."
    exit 2
}

try {
    $Argv = @($Template | ConvertFrom-Json)
} catch {
    Write-Error "CUA_DRIVER_ACTIVATE_ARGV_JSON is not valid JSON: $($_.Exception.Message)"
    exit 2
}

if ($Argv.Count -lt 1) {
    Write-Error "CUA_DRIVER_ACTIVATE_ARGV_JSON must contain an executable and optional arguments."
    exit 2
}

$Replace = @{
    "{id}" = $SessionId
    "{targetId}" = $TargetId
    "{url}" = $Url
    "{title}" = $Title
}

$Expanded = foreach ($Part in $Argv) {
    $Value = [string]$Part
    foreach ($Key in $Replace.Keys) {
        $Value = $Value.Replace($Key, $Replace[$Key])
    }
    $Value
}

$Exe = $Expanded[0]
$Args = if ($Expanded.Count -gt 1) { @($Expanded[1..($Expanded.Count - 1)]) } else { @() }
$Proc = Start-Process -FilePath $Exe -ArgumentList $Args -Wait -PassThru -NoNewWindow
if ($Proc.ExitCode -ne 0) {
    Write-Error "CUA-driver activation failed with exit code $($Proc.ExitCode)."
    exit $Proc.ExitCode
}

[pscustomobject]@{
    ok = $true
    sessionId = $SessionId
    targetId = $TargetId
    url = $Url
    activatedBy = "cua-driver"
} | ConvertTo-Json -Compress
