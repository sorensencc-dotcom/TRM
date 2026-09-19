#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Registers the TRM-Notebooklm-Chat-Archive scheduled task.

.DESCRIPTION
    Creates a daily Windows Task Scheduler job that runs at 08:00 PM (ET)
    to archive all approved NotebookLM chat sessions into the knowledge base.
    Uses a single-instance mutex; will not register a duplicate task.

.NOTES
    Run once. Re-run to update trigger time or wrapper path.
    Requires elevation (Run as Administrator).
#>

$TaskName   = "TRM-Notebooklm-Chat-Archive"
$WrapperPs1 = "C:\dev\trm\schedule-task-wrapper-TRM-Notebooklm-Chat-Archive.ps1"
$RunAt      = "20:00"        # 08:00 PM local time
$WorkDir    = "C:\dev\trm"

# --- Guard: wrapper must exist ---
if (-not (Test-Path $WrapperPs1)) {
    Write-Error "Wrapper script not found: $WrapperPs1"
    exit 1
}

# --- Remove stale task if present ---
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Removing existing task: $TaskName"
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# --- Action: pwsh -NonInteractive -File <wrapper> ---
$Action = New-ScheduledTaskAction `
    -Execute  "pwsh.exe" `
    -Argument "-NonInteractive -NoProfile -File `"$WrapperPs1`"" `
    -WorkingDirectory $WorkDir

# --- Trigger: daily at 08:00 PM ---
$Trigger = New-ScheduledTaskTrigger -Daily -At $RunAt

# --- Settings ---
$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit          (New-TimeSpan -Hours 2) `
    -MultipleInstances           IgnoreNew `
    -StartWhenAvailable          $true `
    -RunOnlyIfNetworkAvailable   $true `
    -DisallowStartIfOnBatteries  $false

# --- Principal: run as current user, highest privilege ---
$Principal = New-ScheduledTaskPrincipal `
    -UserId    "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel  Highest

# --- Register ---
Register-ScheduledTask `
    -TaskName  $TaskName `
    -Action    $Action `
    -Trigger   $Trigger `
    -Settings  $Settings `
    -Principal $Principal `
    -Description "Archive all approved NotebookLM chat sessions to obsidian/vault/wiki/conversations/ and sync to knowledge.db. Part of TRM pipeline (08:00 PM ET, before KB-Sync-TRM-Triage at 08:30 PM)."

Write-Host ""
Write-Host "Task registered successfully:"
Write-Host "  Name    : $TaskName"
Write-Host "  Trigger : Daily at $RunAt (local time)"
Write-Host "  Wrapper : $WrapperPs1"
Write-Host ""
Write-Host "To verify: Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
