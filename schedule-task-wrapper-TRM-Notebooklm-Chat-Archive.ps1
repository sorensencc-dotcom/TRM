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

$ErrorActionPreference = "Stop"
$startTime = Get-Date
$correlationId = [Guid]::NewGuid().ToString()

Write-Host "========================================================================" -ForegroundColor Cyan
Write-Host " [TRM] Universal NotebookLM Daily Chat Archive & Knowledge Harvester" -ForegroundColor Cyan
Write-Host " Correlation ID: $correlationId" -ForegroundColor Gray
Write-Host " Started At:     $($startTime.ToString('o'))" -ForegroundColor Gray
Write-Host "========================================================================" -ForegroundColor Cyan

# 1. Single-Instance Process Mutex
$mutexName = "Global\TRM_Notebooklm_Chat_Archive_Mutex"
$createdNew = $false
$mutex = $null

try {
    $mutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)
    if (-not $createdNew) {
        Write-Warning "[MUTEX] Another instance of TRM-Notebooklm-Chat-Archive is already running. Exiting cleanly."
        exit 0
    }
} catch {
    Write-Warning "[MUTEX] Mutex acquisition error: $($_.Exception.Message). Proceeding cautiously."
}

try {
    # 2. Preflight Repository Verification
    if (Test-Path "C:\dev\scripts\verify-repo-context.ps1") {
        Write-Host "[PREFLIGHT] Verifying TRM repository context..." -ForegroundColor Gray
        & pwsh -NoProfile -File "C:\dev\scripts\verify-repo-context.ps1" -Path $TrmRoot
        if ($LASTEXITCODE -ne 0) {
            throw "Repository preflight verification failed for $TrmRoot"
        }
    }

    # 3. Execute Universal Chat Archival Sweep
    Set-Location -Path $TrmRoot
    Write-Host "[SWEEP] Executing universal chat archive across approved notebooks..." -ForegroundColor Green

    $cliArgs = @("src/cli/index.ts", "archive-chats", "--all")
    if ($DryRun) { $cliArgs += "--dry-run" }
    if ($Force) { $cliArgs += "--force" }

    & npx ts-node @cliArgs
    $sweepExitCode = $LASTEXITCODE

    if ($sweepExitCode -ne 0) {
        Write-Warning "[SWEEP] Chat archival finished with non-zero exit code: $sweepExitCode"
    } else {
        Write-Host "[SWEEP] Chat archival completed successfully." -ForegroundColor Green
    }

    # 4. Canonical knowledge.db SQLite Cache Refresh
    if (Test-Path "$KbSyncRoot\package.json" -and -not $DryRun) {
        Write-Host "[CACHE-SYNC] Refreshing SQLite knowledge.db FTS5/BM25 cache..." -ForegroundColor Cyan
        Set-Location -Path $KbSyncRoot
        & npm run kb:cache:sync
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "[CACHE-SYNC] Warning: kb:cache:sync returned non-zero status: $LASTEXITCODE"
        } else {
            Write-Host "[CACHE-SYNC] SQLite cache synchronized successfully." -ForegroundColor Green
        }
    }

} catch {
    Write-Error "[FATAL] Chat archival execution error: $($_.Exception.Message)"
    exit 1
} finally {
    if ($mutex -ne $null -and $createdNew) {
        try {
            $mutex.ReleaseMutex()
            $mutex.Dispose()
        } catch {}
    }
    $endTime = Get-Date
    $duration = [Math]::Round(($endTime - $startTime).TotalSeconds, 2)
    Write-Host "========================================================================" -ForegroundColor Cyan
    Write-Host " [TRM] Chat Archival Finished in ${duration}s" -ForegroundColor Cyan
    Write-Host "========================================================================" -ForegroundColor Cyan
}
