#!/usr/bin/env pwsh
# Port-forward Research Worker Service
Write-Host "Port-forwarding trm-research/svc/research-worker-svc 8085:8085..." -ForegroundColor Cyan
kubectl port-forward -n trm-research svc/research-worker-svc 8085:8085
