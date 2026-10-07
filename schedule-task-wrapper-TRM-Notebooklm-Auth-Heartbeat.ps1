# ==============================================================================
# Scheduled Task Wrapper: TRM-Notebooklm-Auth-Heartbeat
# Runs every 2 hours to keep Google NotebookLM session cookies (*PSIDTS) alive.
# ==============================================================================

[CmdletBinding()]
param(
    [string]$TrmRoot = "C:\dev\trm"
)

$ErrorActionPreference = "Continue"
$startTime = Get-Date
$Timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$AlertDispatcher = "C:\dev\scripts\send-critical-alert.ps1"

# Setup Logging
$LogDir = Join-Path $TrmRoot "logs"
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}
$LogFile = Join-Path $LogDir "trm-notebooklm-auth-heartbeat-$Timestamp.log"

function Log-Message([string]$msg, [string]$color = "White") {
    $formatted = "[$(Get-Date -Format 'o')] $msg"
    Write-Host $msg -ForegroundColor $color
    $formatted | Out-File -FilePath $LogFile -Append -Encoding utf8
}

Log-Message "========================================================================" "Cyan"
Log-Message " [TRM] Google NotebookLM Session Auth Heartbeat & Keep-Alive" "Cyan"
Log-Message " Started At: $($startTime.ToString('o'))" "Gray"
Log-Message "========================================================================" "Cyan"

$ExitCode = 0

try {
    # 1. Run headless session refresh
    Log-Message "[HEARTBEAT] Refreshing session cookies via headless Chrome..." "Cyan"
    $refreshOutput = & nlm auth refresh 2>&1
    $refreshExit = $LASTEXITCODE
    $refreshOutput | Out-File -FilePath $LogFile -Append -Encoding utf8

    # 2. Live verification probe
    Log-Message "[HEARTBEAT] Verifying live API connectivity..." "Cyan"
    $probeOutput = & nlm notebook list --json 2>&1
    $probeExit = $LASTEXITCODE
    
    if ($probeExit -ne 0 -or ($probeOutput -match "Authentication (Error|expired)")) {
        $errMsg = "NotebookLM session expired. Headless refresh failed to restore session."
        Log-Message "[HEARTBEAT-FAIL] $errMsg" "Red"
        Log-Message "[HEARTBEAT-FAIL] Action required: Run 'nlm login' in your terminal." "Red"

        if (Test-Path $AlertDispatcher) {
            & pwsh -NoProfile -File $AlertDispatcher -Source "TRM-Notebooklm-Auth-Heartbeat" `
                -Title "🚨 CRITICAL: NotebookLM Auth Expired" `
                -Message $errMsg `
                -Severity "CRITICAL" `
                -ActionRequired "nlm login" `
                -LogFile $LogFile
        }
        $ExitCode = 1
    } else {
        Log-Message "[HEARTBEAT-PASS] Session is healthy and cookies successfully renewed." "Green"
        if (Test-Path $AlertDispatcher) {
            & pwsh -NoProfile -File $AlertDispatcher -Source "TRM-Notebooklm-Auth-Heartbeat" -ClearAlert
        }
    }
} catch {
    $fatalErr = "Auth heartbeat execution error: $($_.Exception.Message)"
    Log-Message "[FATAL] $fatalErr" "Red"
    if (Test-Path $AlertDispatcher) {
        & pwsh -NoProfile -File $AlertDispatcher -Source "TRM-Notebooklm-Auth-Heartbeat" `
            -Title "🚨 CRITICAL: Auth Heartbeat Exception" `
            -Message $fatalErr `
            -Severity "CRITICAL" `
            -ActionRequired "Inspect log: $LogFile" `
            -LogFile $LogFile
    }
    $ExitCode = 1
} finally {
    $endTime = Get-Date
    $duration = [Math]::Round(($endTime - $startTime).TotalSeconds, 2)
    Log-Message "========================================================================" "Cyan"
    Log-Message " [TRM] Auth Heartbeat Finished in ${duration}s (Exit Code: $ExitCode)" "Cyan"
    Log-Message "========================================================================" "Cyan"
}

# Keep only last 14 days of heartbeat logs
try {
    Get-ChildItem -Path $LogDir -Filter "trm-notebooklm-auth-heartbeat-*.log" |
        Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } |
        Remove-Item -Force -ErrorAction SilentlyContinue
} catch {}

exit $ExitCode
