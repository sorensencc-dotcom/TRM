#!/usr/bin/env pwsh
# Research Worker Staging Deployment Script

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Write-Host "[1/5] Checking Kubernetes Cluster Connectivity..." -ForegroundColor Cyan
try {
    $clusterInfo = kubectl cluster-info 2>&1
    if ($LASTEXITCODE -ne 0 -or $clusterInfo -match "dial tcp") {
        Write-Host "Received connection error from Kubernetes API. Deployment cannot proceed." -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "Kubernetes API unavailable. Please start your cluster." -ForegroundColor Red
    exit 1
}

Write-Host "[2/5] Building Research Worker Docker Image..." -ForegroundColor Cyan
docker build -t "trm-research-worker:v1.0.0" -f "deploy/research-worker/Dockerfile" .

if ($LASTEXITCODE -eq 0) {
    Write-Host "[3/5] Applying Kubernetes Manifests..." -ForegroundColor Cyan
    kubectl apply -f "deploy/research-worker/research-worker-k8s.yaml"

    Write-Host "[4/5] Waiting for Rollout Status..." -ForegroundColor Cyan
    kubectl rollout status deployment/research-worker-deployment -n trm-research --timeout=60s

    Write-Host "[5/5] Deployment Completed Successfully." -ForegroundColor Green
    Write-Host "Use deploy/research-worker/port-forward-worker.ps1 to expose port 8085." -ForegroundColor Yellow
}
