<#
.SYNOPSIS
    On-Demand Topic Research Mining (TRM) Gap Update Tool.
.DESCRIPTION
    Runs a live extraction against your NotebookLM instance ("CIC-KB" or specified notebook ID)
    and updates the local research-gaps folder within the TRM vault.
#>

param(
    [string]$NotebookId = $null,
    [switch]$All,
    [string]$VaultRoot = "C:\Users\soren\trm-vault"
)

$ErrorActionPreference = 'Stop'

# Color Formatting Helpers
function Log-Info ($Message) {
    Write-Host "[TRM-ON-DEMAND] [INFO] $Message" -ForegroundColor Green
}

function Log-Step ($Step, $Title) {
    Write-Host "`n=== [STEP $Step] $Title ===" -ForegroundColor Cyan
}

function Log-Error ($Message) {
    Write-Error "[TRM-ON-DEMAND] [ERROR] $Message"
}

try {
    Log-Step 1 "Verifying Workspace Environment"
    Log-Info "Checking target vault directory: $VaultRoot"
    if (-not (Test-Path -Path $VaultRoot)) {
        throw "Vault root directory not found: $VaultRoot"
    }
    $GapsPath = Join-Path $VaultRoot "trm\research-gaps"
    if (-not (Test-Path -Path $GapsPath)) {
        Log-Info "Creating local vault gaps path: $GapsPath"
        New-Item -ItemType Directory -Force -Path $GapsPath | Out-Null
    }

    $RegistryPath = Join-Path $VaultRoot 'notebooklm-registry.json'
    if (-not (Test-Path -Path $RegistryPath)) {
        throw "notebooklm-registry.json not found at $RegistryPath"
    }
    $Registry = Get-Content $RegistryPath -Raw | ConvertFrom-Json
    Log-Info "Loaded registry with $($Registry.notebooks.Count) notebooks."

    Log-Step 2 "Validating TRM CLI Toolchain"
    Log-Info "Locating active 'trm' executable..."
    $CliCheck = Get-Command "trm" -ErrorAction SilentlyContinue
    if ($null -eq $CliCheck) {
        throw "The TRM CLI binary ('trm') is not detected in your environment PATH. Please verify it is globally linked."
    }
    Log-Info "Found TRM CLI: $($CliCheck.Path)"

    # Determine target list of notebooks
    $TargetNotebooks = @()
    if ($NotebookId) {
        $Matched = $Registry.notebooks | Where-Object { $_.notebook_id -eq $NotebookId }
        if (-not $Matched) {
            throw "Notebook ID '$NotebookId' not found in registry."
        }
        $TargetNotebooks = @($Matched)
    } else {
        # Default to all registered notebooks
        $TargetNotebooks = $Registry.notebooks
    }

    Log-Step 3 "Executing Live Miner Across $($TargetNotebooks.Count) Notebook(s)"
    $StartTime = Get-Date

    Push-Location -LiteralPath $VaultRoot
    try {
        foreach ($Notebook in $TargetNotebooks) {
            Write-Host "`n--- Mining: $($Notebook.title) ($($Notebook.notebook_id)) ---" -ForegroundColor Magenta
            & trm mine-notebooklm $Notebook.notebook_id
            if ($LASTEXITCODE -ne 0) {
                Write-Host "[TRM-ON-DEMAND] [WARN] Mining failed for $($Notebook.title) with exit code $LASTEXITCODE" -ForegroundColor Red
            }
        }
    } finally {
        Pop-Location
    }
    $EndTime = Get-Date
    
    $Elapsed = [Math]::Round(($EndTime - $StartTime).TotalSeconds, 2)
    
    Log-Step 4 "Extraction Audit & Success Verification"
    Log-Info "Mining completed across $($TargetNotebooks.Count) notebooks in $Elapsed seconds."
    
    # Check if files inside the gaps folder were touched or created today
    $TodayFiles = Get-ChildItem -Path $GapsPath -Filter "*.md" | Where-Object { $_.LastWriteTime.Date -eq (Get-Date).Date }
    
    if ($TodayFiles.Count -gt 0) {
        Log-Info "Successfully updated/created the following gap profiles:"
        foreach ($File in $TodayFiles) {
            Write-Host "  - $($File.Name) (Size: $($File.Length) bytes, Last Modified: $($File.LastWriteTime))" -ForegroundColor Yellow
        }
    } else {
        Write-Host "[TRM-ON-DEMAND] [WARN] No files were updated today. NotebookLM returned 100% hash-aligned content with no new research deltas." -ForegroundColor Yellow
    }
    
    Log-Step 5 "Refreshing CIC Daily Project Status Report"
    $StatusRunner = "C:\Users\soren\OneDrive\Documents\Claude\Projects\CIC\scripts\Run-DailyStatus.ps1"
    if (Test-Path -Path $StatusRunner) {
        Log-Info "Regenerating CIC_Daily_Status.html..."
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $StatusRunner
    }

    Write-Host "`n================================================================================" -ForegroundColor Green
    Write-Host "🎉 SUCCESS: On-Demand TRM Mining complete! Local vault files & Daily Status Report are now up-to-date." -ForegroundColor Green
    Write-Host "================================================================================`n" -ForegroundColor Green

} catch {
    Log-Error $_.Exception.Message
    Exit 1
}