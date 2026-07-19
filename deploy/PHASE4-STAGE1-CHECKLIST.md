# Phase 4 Stage 1: Pre-Deployment Checklist

**Deployment Date:** _______________  
**Deployed By:** _______________  
**Reviewed By:** _______________  

---

## Pre-Deployment Validation

### Code & Tests
- [ ] Phase 1 unit tests pass (5/5): `npm test -- imageAnalysis.test.ts`
- [ ] Phase 3 integration tests pass (8/8): `npm test -- imageAnalysis-integration.test.ts`
- [ ] Feature flag implemented: `ENABLE_IMAGE_ANALYSIS` in index.ts
- [ ] No uncommitted changes in repos
- [ ] All commits pushed to remote

### Infrastructure
- [ ] cic-ingestion service running and healthy: `curl http://cic-ingestion:3000/health`
- [ ] cic-ingestion service responding to image analysis: `curl -X POST http://cic-ingestion:3000/api/analyze/image ...`
- [ ] Vision API credentials valid (test call succeeds)
- [ ] Network policy allows TRM → cic-ingestion traffic
- [ ] Kubernetes cluster accessible: `kubectl cluster-info`

### Configuration
- [ ] ConfigMap created: `kubectl apply -f phase4-stage1-canary.yaml`
- [ ] Secrets verified: `kubectl get secrets google-vision-sa`
- [ ] Environment variables correct: `ENABLE_IMAGE_ANALYSIS=0.1`, `CIC_INGESTION_URL=http://cic-ingestion:3000`
- [ ] Resource limits reasonable: CPU 500m req/2000m limit, Memory 512Mi req/2Gi limit

### Monitoring
- [ ] Prometheus rule applied: `kubectl apply -f phase4-stage1-canary.yaml`
- [ ] Grafana dashboard created: `/grafana/d/canary-phase4`
- [ ] Alert rules deployed and active
- [ ] Alert channels configured (#page-oncall-trm, email)
- [ ] Logging configured (ELK/Datadog/CloudLogging)

### Documentation
- [ ] Phase 4 Rollout doc reviewed: `docs/PHASE4-ROLLOUT.md`
- [ ] Operational Runbook reviewed: `docs/PHASE4-RUNBOOK.md`
- [ ] Monitoring doc reviewed: `docs/PHASE4-MONITORING.md`
- [ ] On-call team briefed
- [ ] Rollback procedure tested locally

### Stakeholder Approval
- [ ] TRM Platform Lead: _______________
- [ ] Infrastructure/DevOps: _______________
- [ ] On-Call Manager: _______________

---

## Deployment Steps

### 1. Pre-Deployment Snapshot
```bash
# Capture current state
kubectl get deployment trm-harvester -o yaml > trm-harvester-pre-canary.yaml
kubectl get all -l app=trm-harvester > pre-deployment-state.txt
kubectl top pods -n default | grep trm > pre-deployment-metrics.txt
```

### 2. Apply Canary Config
```bash
# Create secrets if not exist
kubectl create secret generic google-vision-sa \
  --from-file=service-account.json=/path/to/sa-key.json \
  --dry-run=client -o yaml | kubectl apply -f -

# Apply deployment
kubectl apply -f phase4-stage1-canary.yaml

# Verify rollout
kubectl rollout status deployment/trm-harvester-phase4-canary
```

### 3. Health Verification (First 5 min)
```bash
# Check pod status
kubectl get pods -l app=trm-harvester,stage=canary
kubectl describe pod -l app=trm-harvester,stage=canary

# Check service
kubectl get svc trm-harvester-canary
kubectl get endpoints trm-harvester-canary

# Verify metrics exported
kubectl port-forward svc/trm-harvester-canary 9090:9090 &
curl http://localhost:9090/metrics | grep image_analysis
```

### 4. Initial Monitoring (First 12 hours)
```bash
# Error rate should be <1%
# Latency p99 should be <500ms
# Fallback ratio should be <1%

# Watch dashboard
# Grafana: /grafana/d/canary-phase4
# Prometheus: http://prometheus:9090/graph
```

---

## Deployment Log

**Start Time:** _______________  
**End Time:** _______________  

### Pre-Deployment State
```
Cluster version: _______________
trm-harvester version: _______________
cic-ingestion health: _______________
Vision API status: _______________
```

### Deployment Events
```
[T+0m] Starting Phase 4 Stage 1 canary deployment
[T+Xm] ConfigMap created
[T+Xm] Deployment applied
[T+Xm] Pods transitioning to running
[T+Xm] Health check passing
[T+Xm] Metrics streaming
[T+Xm] Alerts active
```

### Initial Metrics (First 12 Hours)
- Error Rate: _______________
- Latency p99: _______________
- Fallback Ratio: _______________
- Request Count: _______________

### Issues Encountered
```
None / Document any issues here
```

### Sign-Off
- [ ] All health checks passing
- [ ] Monitoring active
- [ ] No alerts triggered
- [ ] Ready for 2-3 day monitoring period

**Approved By:** _______________  
**Time:** _______________

---

## Daily Monitoring (72 hours)

### Day 1
- [ ] Error rate <5% all day
- [ ] Latency p99 <500ms
- [ ] No cascading failures
- [ ] cic-ingestion stable
- **Status:** PASS / FAIL (note issues)
- **Notes:** _______________

### Day 2
- [ ] Error rate <5% all day
- [ ] Latency p99 <500ms
- [ ] No new error types
- [ ] Vision API responsive
- **Status:** PASS / FAIL
- **Notes:** _______________

### Day 3
- [ ] Error rate <5% all day
- [ ] Latency p99 <500ms
- [ ] Sustained performance
- [ ] Ready for Stage 2?
- **Status:** PASS / FAIL
- **Notes:** _______________

---

## Stage 2 Decision

**Proceed to Early Adopters (25%)?**

- [ ] Error rate <5% for full 72 hours
- [ ] Latency p99 <500ms sustained
- [ ] Zero customer reports
- [ ] No cascading failures
- [ ] cic-ingestion health stable
- [ ] On-call sign-off

**Decision:** PROCEED / ROLLBACK  
**Approver:** _______________  
**Time:** _______________

---

## Rollback (If Needed)

**Reason:** _______________  
**Time:** _______________

**Rollback Command:**
```bash
kubectl set env deployment/trm-harvester \
  ENABLE_IMAGE_ANALYSIS=0.0
kubectl rollout status deployment/trm-harvester
```

**Post-Rollback Verification:**
```bash
# Confirm traffic back to legacy implementation
# Monitor error rate returns to baseline
# Verify no cascading issues
```

**Incident Report:** _______________
