# Research Worker Kubernetes Deployment Guide

This guide walks through deploying the Research Worker to a Kubernetes cluster (Docker Desktop, Minikube, GKE, or staging).

---

## Prerequisites

1. Docker Desktop / Kubernetes running (`kubectl cluster-info` returns success).
2. No secrets or credentials committed in repository manifests.

---

## Deployment Steps

1. **Build Docker Image**:
   ```bash
   docker build -t trm-research-worker:v1.0.0 -f deploy/research-worker/Dockerfile .
   ```

2. **Apply Kubernetes Manifests**:
   ```bash
   kubectl apply -f deploy/research-worker/research-worker-k8s.yaml
   ```

3. **Wait for Pod Readiness**:
   ```bash
   kubectl rollout status deployment/research-worker-deployment -n trm-research
   ```

4. **Port-Forward to Localhost**:
   ```bash
   powershell.exe -File deploy/research-worker/port-forward-worker.ps1
   # or: kubectl port-forward -n trm-research svc/research-worker-svc 8085:8085
   ```

5. **Verify Worker Health**:
   ```bash
   curl http://127.0.0.1:8085/health
   ```

6. **Configure RESEARCH_WORKER_URL**:
   ```bash
   export RESEARCH_WORKER_URL="http://127.0.0.1:8085/tasks"
   ```

7. **Run Live Integration Proof**:
   ```bash
   node scripts/verify-research-pipeline.mjs
   ```
