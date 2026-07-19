# Phase 4 Stage 1: Canary Deployment Guide

**Estimated Duration:** 15 minutes (deployment) + 2-3 days (monitoring)

---

## Quick Start

### Automated Deployment (Recommended)

**Linux/Mac:**
```bash
chmod +x deploy/phase4-stage1-deploy.sh
./deploy/phase4-stage1-deploy.sh
```

**Windows (PowerShell):**
```powershell
Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process
.\deploy\phase4-stage1-deploy.ps1
```

---

## Manual Deployment (If Automation Fails)

### Step 1: Pre-Flight Checks (5 min)

```bash
# Verify kubectl
kubectl cluster-info

# Verify cic-ingestion service
kubectl get svc cic-ingestion
kubectl get svc cic-ingestion -o jsonpath='{.spec.clusterIP}:{.spec.ports[0].port}'

# Test cic-ingestion health
kubectl exec -it <any-pod> -- curl http://cic-ingestion:3000/health

# Verify secrets
kubectl get secret google-vision-sa
```

**Go/No-Go:** All must pass. If not, resolve before proceeding.

### Step 2: Create/Update Secrets

```bash
# If secrets don't exist, create them
kubectl create secret generic google-vision-sa \
  --from-file=service-account.json=/path/to/sa-key.json \
  --dry-run=client -o yaml | kubectl apply -f -
```

### Step 3: Apply Deployment Manifest

```bash
# Deploy all resources
kubectl apply -f deploy/phase4-stage1-canary.yaml

# Verify resources created
kubectl get configmap phase4-stage1-env
kubectl get deployment trm-harvester-phase4-canary
kubectl get service trm-harvester-canary
kubectl get pdb trm-harvester-canary-pdb
kubectl get prometheusrule phase4-canary-alerts
```

### Step 4: Wait for Rollout

```bash
# Monitor rollout (takes 2-5 min)
kubectl rollout status deployment/trm-harvester-phase4-canary

# Or watch in real time
kubectl get pods -l app=trm-harvester,stage=canary -w
```

### Step 5: Verify Deployment

```bash
# Check pods
kubectl get pods -l app=trm-harvester,stage=canary
# Should show 3 pods in Running state

# Check logs
kubectl logs -l app=trm-harvester,stage=canary --tail=50

# Test metrics endpoint
kubectl port-forward svc/trm-harvester-canary 9090:9090 &
curl http://localhost:9090/metrics | grep image_analysis
kill %1
```

**Go/No-Go:** All pods running, metrics flowing. Proceed to monitoring.

---

## Monitoring (2-3 days)

### Dashboard Access

**Grafana Canary Dashboard:**
```
http://grafana:3000/d/canary-phase4
```

**Prometheus Queries:**
```
# Error rate
(1 - (rate(image_analysis_success_total{stage="canary"}[5m]) / rate(image_analysis_requests_total{stage="canary"}[5m])))

# Latency p99
histogram_quantile(0.99, rate(image_analysis_latency_ms_bucket{stage="canary"}[5m]))

# Vision API fallback ratio
(rate(image_analysis_fallback_total{stage="canary"}[5m]) / rate(image_analysis_requests_total{stage="canary"}[5m]))
```

### Daily Monitoring Checklist

**Day 1:**
- [ ] Error rate <5% all day
- [ ] Latency p99 <500ms
- [ ] No cascading failures
- [ ] cic-ingestion stable
- [ ] Log review: no unexpected errors

**Day 2:**
- [ ] Same as Day 1
- [ ] Sustained performance
- [ ] Zero alerts triggered

**Day 3:**
- [ ] Same as Day 1-2
- [ ] Ready for Stage 2 decision

### Health Check Commands

```bash
# Real-time error rate
kubectl exec -it $(kubectl get pod -l app=trm-harvester,stage=canary -o jsonpath='{.items[0].metadata.name}') -- \
  curl -s http://localhost:9090/metrics | grep image_analysis_errors_total

# Recent logs
kubectl logs -l app=trm-harvester,stage=canary --since=1h

# Event summary
kubectl get events --field-selector involvedObject.name=trm-harvester-phase4-canary
```

---

## Decision: Proceed to Stage 2 or Rollback?

### Proceed to Early Adopters (25%)
**If all criteria met:**
- [x] Error rate <5% for full 72 hours
- [x] Latency p99 <500ms sustained
- [x] Zero customer reports
- [x] No cascading failures
- [x] cic-ingestion health stable
- [x] On-call sign-off

**Command:**
```bash
kubectl set env deployment/trm-harvester \
  ENABLE_IMAGE_ANALYSIS=0.25
kubectl rollout status deployment/trm-harvester
```

### Rollback (Emergency)
**If critical issues occur:**
```bash
# Disable new implementation (immediate)
kubectl set env deployment/trm-harvester \
  ENABLE_IMAGE_ANALYSIS=0.0

# Verify traffic back to legacy
kubectl rollout status deployment/trm-harvester

# Collect logs for analysis
kubectl logs deployment/trm-harvester --since=2h > incident-logs.txt
```

---

## Troubleshooting

### Pods Not Starting
```bash
kubectl describe pod -l app=trm-harvester,stage=canary
# Check: pull errors, resource limits, config maps, secrets
```

### High Error Rate
```bash
# Check cic-ingestion health
kubectl get pod -l app=cic-ingestion
kubectl logs -l app=cic-ingestion --tail=100

# Check Vision API connectivity
kubectl exec <pod> -- curl -X POST http://cic-ingestion:3000/api/analyze/image \
  -H "Content-Type: application/json" \
  -d '{"imageBuffer":"iVBORw0KGgo..."}'

# If API down, check quota in Google Cloud Console
```

### High Latency (>500ms)
```bash
# Check pod resources
kubectl top pod -l app=trm-harvester,stage=canary

# Check cic-ingestion resources
kubectl top pod -l app=cic-ingestion

# Scale up if CPU/memory >80%
kubectl scale deployment trm-harvester-phase4-canary --replicas=5
```

### Metrics Not Appearing
```bash
# Check metrics are being exported
kubectl exec <pod> -- curl -s http://localhost:9090/metrics | head -20

# If empty, check service initialization logs
kubectl logs <pod> | grep -i metric
```

---

## Full References

| Document | Purpose |
|----------|---------|
| `docs/PHASE4-ROLLOUT.md` | 4-stage strategy |
| `docs/PHASE4-RUNBOOK.md` | Troubleshooting + procedures |
| `docs/PHASE4-MONITORING.md` | Metrics + alerts |
| `deploy/PHASE4-STAGE1-CHECKLIST.md` | Detailed checklist |
| `PROJECT-SUMMARY.md` | Overall project status |

---

## Support

**Issues during deployment?**
1. Check troubleshooting section above
2. Review `docs/PHASE4-RUNBOOK.md#troubleshooting`
3. Escalate to DevOps/TRM team

**Slack:** #page-oncall-trm  
**Email:** trm-lead@company.com, devops@company.com

---

**Status:** Ready for canary deployment  
**Next:** Execute above, monitor 2-3 days, decide on Stage 2
