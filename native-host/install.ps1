# xTap — Windows installer for the native messaging host (PowerShell).
# Usage:
#   .\install.ps1 -ExtensionId <id> [-Browser chrome|firefox]
#   .\install.ps1 -Browser firefox

param(
    [Parameter(Mandatory=$false, Position=0)]
    [string]$ExtensionId,

    [Parameter(Mandatory=$false)]
    [ValidateSet("chrome", "firefox")]
    [string]$Browser = "chrome"
)

$ErrorActionPreference = "Stop"

$HostName = "com.xtap.host"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$HostPy = Join-Path $ScriptDir "xtap_host.py"
$BatPath = Join-Path $ScriptDir "xtap_host.bat"
$ManifestPath = Join-Path $ScriptDir "$HostName.json"

if (-not $ExtensionId -and $Browser -eq "firefox") {
    $ExtensionId = "xtap@mkubicek.dev"
}
if (-not $ExtensionId) {
    Write-Error "ExtensionId is required for Chrome installs (find it at chrome://extensions)."
    exit 1
}

$RegKey = if ($Browser -eq "firefox") {
    "HKCU:\Software\Mozilla\NativeMessagingHosts\$HostName"
} else {
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
}

# Verify python
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Error "python is required but not found in PATH"
    exit 1
}

# Write manifest (path must point to the .bat wrapper)
$manifestData = @{
    name = $HostName
    description = "xTap native messaging host -- writes captured tweets to JSONL"
    path = $BatPath
    type = "stdio"
}
if ($Browser -eq "firefox") {
    $manifestData.allowed_extensions = @($ExtensionId)
} else {
    $manifestData.allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifest = $manifestData | ConvertTo-Json -Depth 2

Set-Content -Path $ManifestPath -Value $manifest -Encoding UTF8

# Create registry key pointing to manifest
if (-not (Test-Path (Split-Path $RegKey))) {
    New-Item -Path (Split-Path $RegKey) -Force | Out-Null
}
New-Item -Path $RegKey -Force | Out-Null
Set-ItemProperty -Path $RegKey -Name "(Default)" -Value $ManifestPath

Write-Host "Installed native messaging host:"
Write-Host "  Manifest: $ManifestPath"
Write-Host "  Registry: $RegKey"
Write-Host "  Browser: $Browser"
Write-Host "  Host script: $HostPy"
Write-Host "  Extension ID: $ExtensionId"

# --- Install HTTP daemon via Scheduled Task ---
$DaemonPy = Join-Path $ScriptDir "xtap_daemon.py"
$XtapDir = Join-Path $HOME ".xtap"
$XtapSecret = Join-Path $XtapDir "secret"
$TaskName = "xTapDaemon"

# Create ~/.xtap/ directory
if (-not (Test-Path $XtapDir)) {
    New-Item -ItemType Directory -Path $XtapDir -Force | Out-Null
}

# Generate auth token if not exists
if (-not (Test-Path $XtapSecret)) {
    $token = python -c "import secrets; print(secrets.token_urlsafe(32))"
    Set-Content -Path $XtapSecret -Value $token -Encoding ASCII
    Write-Host "Generated auth token: $XtapSecret"
} else {
    Write-Host "Auth token already exists: $XtapSecret"
}

# Find pythonw (preferred — no console window) or fall back to python
$PythonW = Get-Command pythonw -ErrorAction SilentlyContinue
if ($PythonW) {
    $PythonExe = $PythonW.Source
} else {
    $PythonExe = (Get-Command python).Source
}

# Remove existing scheduled task if present
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# Create scheduled task: run at logon, restart on failure
$Action = New-ScheduledTaskAction -Execute $PythonExe -Argument "`"$DaemonPy`""
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval ([TimeSpan]::FromMinutes(1))
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger `
    -Settings $Settings -Description "xTap HTTP daemon" | Out-Null

# Start the task now
Start-ScheduledTask -TaskName $TaskName

Write-Host ""
Write-Host "HTTP daemon installed:"
Write-Host "  Scheduled Task: $TaskName"
Write-Host "  Daemon: $DaemonPy"
Write-Host "  Python: $PythonExe"
Write-Host "  Listening on: 127.0.0.1:17381"
Write-Host ""
Write-Host "Useful commands:"
Write-Host "  Get-ScheduledTask -TaskName $TaskName"
Write-Host "  Start-ScheduledTask -TaskName $TaskName"
Write-Host "  Stop-ScheduledTask -TaskName $TaskName"

Write-Host ""
$outputDir = if ($env:XTAP_OUTPUT_DIR) { $env:XTAP_OUTPUT_DIR } else { Join-Path $HOME "Downloads\xtap" }
Write-Host "Output directory (set XTAP_OUTPUT_DIR to change):"
Write-Host "  $outputDir"
