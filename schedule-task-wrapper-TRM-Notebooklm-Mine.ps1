# schedule-task-wrapper-TRM-Notebooklm-Mine.ps1
# Weekly sweep: runs `trm mine-notebooklm <id>` for every notebook in
# notebooklm-registry.json. Registered in Windows Task Scheduler, weekly
# trigger -- see docs/superpowers/specs/2026-08-12-notebooklm-cic-ingest-mining-design.md §5.

$ErrorActionPreference = "Continue"
$VaultRoot = 'C:\Users\soren\trm-vault'
$LogDir = Join-Path $VaultRoot 'logs'
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

$Timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$LogFile = Join-Path $LogDir "trm-notebooklm-mine-$Timestamp.log"
$StartTime = Get-Date

"=== TRM Notebooklm Mining Sweep ===" | Tee-Object -FilePath $LogFile -Append
"Started: $StartTime" | Tee-Object -FilePath $LogFile -Append
"Vault Root: $VaultRoot" | Tee-Object -FilePath $LogFile -Append

Set-Location $VaultRoot

$RegistryPath = Join-Path $VaultRoot 'notebooklm-registry.json'
if (-not (Test-Path $RegistryPath)) {
    "notebooklm-registry.json not found at $RegistryPath -- nothing to mine" | Tee-Object -FilePath $LogFile -Append
    $EndTime = Get-Date
    $Duration = ($EndTime - $StartTime).TotalSeconds
    "Completed: $EndTime (Duration: {0:F2}s, Exit Code: 1)" -f $Duration | Tee-Object -FilePath $LogFile -Append
    exit 1
}

$Registry = $null
try {
    $Registry = Get-Content $RegistryPath -Raw | ConvertFrom-Json
} catch {
    "Failed to parse notebooklm-registry.json: $_" | Tee-Object -FilePath $LogFile -Append
    $EndTime = Get-Date
    $Duration = ($EndTime - $StartTime).TotalSeconds
    "Completed: $EndTime (Duration: {0:F2}s, Exit Code: 1)" -f $Duration | Tee-Object -FilePath $LogFile -Append
    exit 1
}

$ExitCode = 0

foreach ($Notebook in $Registry.notebooks) {
    "=== mining $($Notebook.title) ($($Notebook.notebook_id)) ===" | Tee-Object -FilePath $LogFile -Append
    try {
        & trm mine-notebooklm $Notebook.notebook_id 2>&1 | Tee-Object -FilePath $LogFile -Append
        if ($LASTEXITCODE -ne 0) {
            "mine-notebooklm failed for $($Notebook.notebook_id) with exit code $LASTEXITCODE" | Tee-Object -FilePath $LogFile -Append
            $ExitCode = 1
        }
    } catch {
        "mine-notebooklm threw for $($Notebook.notebook_id): $_" | Tee-Object -FilePath $LogFile -Append
        $ExitCode = 1
    }
}

# Refresh Daily Status Report
$StatusRunner = "C:\Users\soren\OneDrive\Documents\Claude\Projects\CIC\scripts\Run-DailyStatus.ps1"
if (Test-Path -Path $StatusRunner) {
    "Refreshing CIC Daily Project Status Report..." | Tee-Object -FilePath $LogFile -Append
    try {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $StatusRunner 2>&1 | Tee-Object -FilePath $LogFile -Append
    } catch {
        "Failed to refresh Daily Status Report: $_" | Tee-Object -FilePath $LogFile -Append
    }
}

$EndTime = Get-Date
$Duration = ($EndTime - $StartTime).TotalSeconds
"Completed: $EndTime (Duration: {0:F2}s, Exit Code: {1})" -f $Duration, $ExitCode | Tee-Object -FilePath $LogFile -Append

exit $ExitCode
