<#
.SYNOPSIS
    Registers the TRM-Notebooklm-Chat-Archive scheduled task in the \TRM\ task folder.

.DESCRIPTION
    Creates a daily Windows Task Scheduler job that runs at 08:00 PM (ET)
    to archive all approved NotebookLM chat sessions into the knowledge base.
    Uses LogonType S4U to run whether the user is logged on or not.
    Requires administrator elevation to configure S4U / Service principal.

.NOTES
    Run from an elevated PowerShell prompt (Run as Administrator) to apply S4U logon.
#>

$TaskName   = "TRM-Notebooklm-Chat-Archive"
$TaskPath   = "\TRM\"
$WrapperPs1 = "C:\dev\trm\schedule-task-wrapper-TRM-Notebooklm-Chat-Archive.ps1"
$RunAt      = "20:00"        # 08:00 PM local time
$WorkDir    = "C:\dev\trm"

# --- Guard: wrapper must exist ---
if (-not (Test-Path $WrapperPs1)) {
    Write-Error "Wrapper script not found: $WrapperPs1"
    exit 1
}

# --- Check elevation & define Principal for "Run whether logged on or not" ---
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if ($isAdmin) {
    $Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Highest
} else {
    Write-Warning "Not running as Administrator. S4U ('Run whether logged on or not') requires elevation."
    Write-Host "Attempting fallback to user principal..." -ForegroundColor Yellow
    $Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
}

# --- Remove stale task if present ---
$existing = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Removing existing task: $TaskPath$TaskName"
    Unregister-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Confirm:$false
}

# --- Action: pwsh -NonInteractive -NoProfile -ExecutionPolicy Bypass -File <wrapper> ---
$Action = New-ScheduledTaskAction `
    -Execute  "pwsh.exe" `
    -Argument "-NonInteractive -NoProfile -ExecutionPolicy Bypass -File `"$WrapperPs1`"" `
    -WorkingDirectory $WorkDir

# --- Trigger: daily at 08:00 PM ---
$Trigger = New-ScheduledTaskTrigger -Daily -At $RunAt

# --- Settings ---
$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -WakeToRun

# --- Register ---
Register-ScheduledTask `
    -TaskName    $TaskName `
    -TaskPath    $TaskPath `
    -Action      $Action `
    -Trigger     $Trigger `
    -Settings    $Settings `
    -Principal   $Principal `
    -Description "Archive all approved NotebookLM chat sessions to obsidian/vault/wiki/conversations/ and sync to knowledge.db. Part of TRM pipeline (08:00 PM ET, before KB-Sync-TRM-Triage at 08:30 PM)." `
    -Force

Write-Host ""
Write-Host "Task registered successfully:"
Write-Host "  Name       : $TaskPath$TaskName"
Write-Host "  Trigger    : Daily at $RunAt (local time)"
Write-Host "  Logon Type : $($Principal.LogonType) (Run whether logged on or not: $(if ($Principal.LogonType -eq 'S4U') {'YES'} else {'NO (Interactive only)'}))"
Write-Host "  Wrapper    : $WrapperPs1"
Write-Host ""
Write-Host "To verify: Get-ScheduledTask -TaskName '$TaskName' -TaskPath '$TaskPath' | Get-ScheduledTaskInfo"
