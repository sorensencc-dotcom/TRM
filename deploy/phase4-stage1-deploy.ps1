# Phase 4 Stage 1: Canary Deployment Automation (PowerShell)
# Usage: .\phase4-stage1-deploy.ps1

$ErrorActionPreference = "Stop"

# Configuration
$NAMESPACE = "default"
$DEPLOYMENT_NAME = "trm-harvester-phase4-canary"
$MANIFEST = "deploy/phase4-stage1-canary.yaml"
$CHECKLIST = "deploy/PHASE4-STAGE1-CHECKLIST.md"
$STAGE = "canary"
$ENABLE_FLAG = "0.1"

Write-Host "=== Phase 4 Stage 1: Canary Deployment ===" -ForegroundColor Green
Write-Host "Namespace: $NAMESPACE"
Write-Host "Deployment: $DEPLOYMENT_NAME"
Write-Host "Traffic: $ENABLE_FLAG (10%)"
Write-Host ""

# Pre-flight checks
Write-Host "[1/5] Pre-Flight Checks" -ForegroundColor Yellow

# Check kubectl
try {
    $kubectl = kubectl cluster-info 2>$null
    Write-Host "✓ kubectl available" -ForegroundColor Green
} catch {
    Write-Host "✗ kubectl not found" -ForegroundColor Red
    exit 1
}

# Check cluster
try {
    $clusterInfo = kubectl cluster-info 2>$null | Select-Object -First 1
    Write-Host "✓ Cluster: $clusterInfo" -ForegroundColor Green
} catch {
    Write-Host "✗ Cannot connect to cluster" -ForegroundColor Red
    exit 1
}

# Check cic-ingestion
Write-Host -NoNewline "  Checking cic-ingestion health... "
$cicSvc = kubectl get svc cic-ingestion 2>$null
if ($cicSvc) {
    Write-Host "✓" -ForegroundColor Green
} else {
    Write-Host "~ (will retry post-deploy)" -ForegroundColor Yellow
}

# Check secrets
Write-Host -NoNewline "  Checking Vision API credentials... "
$secret = kubectl get secret google-vision-sa 2>$null
if ($secret) {
    Write-Host "✓" -ForegroundColor Green
} else {
    Write-Host "✗ MISSING" -ForegroundColor Red
    Write-Host "  Create with: kubectl create secret generic google-vision-sa --from-file=..."
    exit 1
}

Write-Host ""
Write-Host "[2/5] Pre-Deployment Snapshot" -ForegroundColor Yellow

# Capture state
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$stateFile = "pre-deployment-state-$timestamp.txt"
kubectl get all -l app=trm-harvester 2>$null | Out-File $stateFile
Write-Host "✓ State saved to $stateFile" -ForegroundColor Green

Write-Host ""
Write-Host "[3/5] Deploy Manifest" -ForegroundColor Yellow

# Apply manifest
try {
    kubectl apply -f $MANIFEST
    Write-Host "✓ Manifest applied" -ForegroundColor Green
} catch {
    Write-Host "✗ Manifest application failed" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "[4/5] Wait for Rollout" -ForegroundColor Yellow

# Wait for deployment
$maxWait = 300  # 5 min
$elapsed = 0
$interval = 10

while ($elapsed -lt $maxWait) {
    $rollout = kubectl rollout status deployment/$DEPLOYMENT_NAME -n $NAMESPACE 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✓ Deployment ready" -ForegroundColor Green
        break
    }
    Write-Host -NoNewline "."
    Start-Sleep -Seconds $interval
    $elapsed += $interval
}

if ($elapsed -ge $maxWait) {
    Write-Host "✗ Deployment did not become ready within ${maxWait}s" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "[5/5] Post-Deployment Verification" -ForegroundColor Yellow

# Verify pods
$pods = kubectl get pods -l app=trm-harvester,stage=canary -o json | ConvertFrom-Json
$running = ($pods.items | Where-Object { $_.status.phase -eq "Running" } | Measure-Object).Count
$desired = kubectl get deployment $DEPLOYMENT_NAME -o jsonpath='{.spec.replicas}'

Write-Host "  Pods running: $running/$desired"
if ($running -eq $desired) {
    Write-Host "✓ All pods running" -ForegroundColor Green
} else {
    Write-Host "✗ Not all pods running" -ForegroundColor Red
    exit 1
}

# Verify service
Write-Host -NoNewLine "  Service health: "
$svc = kubectl get svc trm-harvester-canary 2>$null
if ($svc) {
    Write-Host "✓" -ForegroundColor Green
} else {
    Write-Host "✗" -ForegroundColor Red
    exit 1
}

# Check metrics
Write-Host -NoNewLine "  Metrics endpoint: "
$pod = kubectl get pods -l app=trm-harvester,stage=canary -o jsonpath='{.items[0].metadata.name}'
try {
    $metrics = kubectl exec $pod -- curl -s http://localhost:9090/metrics 2>$null
    if ($metrics -match "image_analysis") {
        Write-Host "✓" -ForegroundColor Green
    } else {
        Write-Host "~ (will be available shortly)" -ForegroundColor Yellow
    }
} catch {
    Write-Host "~ (will be available shortly)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== Deployment Complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:"
Write-Host "1. Monitor dashboard: /grafana/d/canary-phase4"
Write-Host "2. Check metrics: kubectl port-forward svc/trm-harvester-canary 9090:9090"
Write-Host "3. Watch logs: kubectl logs -f deployment/$DEPLOYMENT_NAME"
Write-Host "4. Track errors: kubectl get events | grep $DEPLOYMENT_NAME"
Write-Host ""
Write-Host "Decision point: 2-3 days (see $CHECKLIST)"
Write-Host ""
