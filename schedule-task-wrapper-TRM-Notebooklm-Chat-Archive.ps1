# ==============================================================================
# Scheduled Task Wrapper: TRM-Notebooklm-Chat-Archive
# Runs daily at 08:00 PM ET before KB-Sync-TRM-Triage at 08:30 PM ET
# ==============================================================================

[CmdletBinding()]
param(
    [string]$TrmRoot = "C:\dev\trm",
    [string]$KbSyncRoot = "C:\dev\kb-sync",
    [switch]$DryRun,
    [switch]$Force
)

$ErrorActionPreference = "Continue"
$startTime = Get-Date
$correlationId = [Guid]::NewGuid().ToString()
$Timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'

# 0. Setup Logging
$LogDir = Join-Path $TrmRoot "logs"
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}
$LogFile = Join-Path $LogDir "trm-notebooklm-chat-archive-$Timestamp.log"

function Log-Message([string]$msg, [string]$color = "White") {
    $formatted = "[$(Get-Date -Format 'o')] $msg"
    Write-Host $msg -ForegroundColor $color
    $formatted | Out-File -FilePath $LogFile -Append -Encoding utf8
}

Log-Message "========================================================================" "Cyan"
Log-Message " [TRM] Universal NotebookLM Daily Chat Archive & Knowledge Harvester" "Cyan"
Log-Message " Correlation ID: $correlationId" "Gray"
Log-Message " Started At:     $($startTime.ToString('o'))" "Gray"
Log-Message " Log File:       $LogFile" "Gray"
Log-Message "========================================================================" "Cyan"

# 1. Single-Instance Process Mutex
$mutexName = "Global\TRM_Notebooklm_Chat_Archive_Mutex"
$createdNew = $false
$mutex = $null

try {
    $mutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)
    if (-not $createdNew) {
        Log-Message "[MUTEX] Another instance of TRM-Notebooklm-Chat-Archive is already running. Exiting cleanly." "Yellow"
        exit 0
    }
} catch {
    Log-Message "[MUTEX] Mutex acquisition error: $($_.Exception.Message). Proceeding cautiously." "Yellow"
}

$ExitCode = 0

try {
    # 2. Environment Setup for Safe Git Execution
    $env:TRM_ALLOW_GIT_ROOT = "1"

    # 3. Preflight Repository Verification
    if (Test-Path "C:\dev\scripts\verify-repo-context.ps1") {
        Log-Message "[PREFLIGHT] Verifying TRM repository context..." "Gray"
        & pwsh -NoProfile -File "C:\dev\scripts\verify-repo-context.ps1" -Path $TrmRoot 2>&1 | Tee-Object -FilePath $LogFile -Append
        if ($LASTEXITCODE -ne 0) {
            Log-Message "[WARN] Repository preflight check returned non-zero ($LASTEXITCODE). Proceeding with sweep." "Yellow"
        }
    }

    # 4. Execute Universal Chat Archival Sweep
    Set-Location -Path $TrmRoot
    Log-Message "[SWEEP] Executing universal chat archive across approved notebooks..." "Green"

    $cliArgs = @("src/cli/index.ts", "archive-chats", "--all")
    if ($DryRun) { $cliArgs += "--dry-run" }
    if ($Force) { $cliArgs += "--force" }

    & npx ts-node @cliArgs 2>&1 | Tee-Object -FilePath $LogFile -Append
    $sweepExitCode = $LASTEXITCODE

    if ($sweepExitCode -ne 0) {
        Log-Message "[SWEEP] Chat archival finished with non-zero exit code: $sweepExitCode" "Yellow"
        $ExitCode = 1
    } else {
        Log-Message "[SWEEP] Chat archival completed successfully." "Green"
    }

    # 5. Canonical knowledge.db SQLite Cache Refresh
    if ((Test-Path "$KbSyncRoot\package.json") -and (-not $DryRun)) {
        Log-Message "[CACHE-SYNC] Refreshing SQLite knowledge.db FTS5/BM25 cache..." "Cyan"
        Set-Location -Path $KbSyncRoot
        & npm run kb:cache:sync 2>&1 | Tee-Object -FilePath $LogFile -Append
        if ($LASTEXITCODE -ne 0) {
            Log-Message "[CACHE-SYNC] Warning: kb:cache:sync returned non-zero status: $LASTEXITCODE" "Yellow"
        } else {
            Log-Message "[CACHE-SYNC] SQLite cache synchronized successfully." "Green"
        }
    }

} catch {
    Log-Message "[FATAL] Chat archival execution error: $($_.Exception.Message)" "Red"
    $ExitCode = 1
} finally {
    if ($mutex -ne $null -and $createdNew) {
        try {
            $mutex.ReleaseMutex()
            $mutex.Dispose()
        } catch {}
    }
    $endTime = Get-Date
    $duration = [Math]::Round(($endTime - $startTime).TotalSeconds, 2)
    Log-Message "========================================================================" "Cyan"
    Log-Message " [TRM] Chat Archival Finished in ${duration}s (Exit Code: $ExitCode)" "Cyan"
    Log-Message "========================================================================" "Cyan"
}

exit $ExitCode
