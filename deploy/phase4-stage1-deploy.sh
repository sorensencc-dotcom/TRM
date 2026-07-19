#!/bin/bash
# Phase 4 Stage 1: Canary Deployment Automation
# Usage: ./phase4-stage1-deploy.sh

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
NAMESPACE="default"
DEPLOYMENT_NAME="trm-harvester-phase4-canary"
MANIFEST="deploy/phase4-stage1-canary.yaml"
CHECKLIST="deploy/PHASE4-STAGE1-CHECKLIST.md"
STAGE="canary"
ENABLE_FLAG="0.1"

echo -e "${GREEN}=== Phase 4 Stage 1: Canary Deployment ===${NC}"
echo "Namespace: $NAMESPACE"
echo "Deployment: $DEPLOYMENT_NAME"
echo "Traffic: $ENABLE_FLAG (10%)"
echo ""

# Pre-flight checks
echo -e "${YELLOW}[1/5] Pre-Flight Checks${NC}"

# Check kubectl
if ! command -v kubectl &> /dev/null; then
    echo -e "${RED}✗ kubectl not found${NC}"
    exit 1
fi
echo -e "${GREEN}✓ kubectl available${NC}"

# Check cluster
if ! kubectl cluster-info &> /dev/null; then
    echo -e "${RED}✗ Cannot connect to cluster${NC}"
    exit 1
fi
CLUSTER_INFO=$(kubectl cluster-info | head -1)
echo -e "${GREEN}✓ Cluster: $CLUSTER_INFO${NC}"

# Check cic-ingestion health
echo -n "  Checking cic-ingestion health... "
if kubectl get svc cic-ingestion &> /dev/null; then
    echo -e "${GREEN}✓${NC}"
else
    echo -e "${RED}✗ (service not found, will retry post-deploy)${NC}"
fi

# Check secrets
echo -n "  Checking Vision API credentials... "
if kubectl get secret google-vision-sa &> /dev/null; then
    echo -e "${GREEN}✓${NC}"
else
    echo -e "${RED}✗ MISSING${NC}"
    echo "  Create with: kubectl create secret generic google-vision-sa --from-file=..."
    exit 1
fi

echo ""
echo -e "${YELLOW}[2/5] Pre-Deployment Snapshot${NC}"

# Capture current state
TIMESTAMP=$(date +%s)
STATE_FILE="pre-deployment-state-$TIMESTAMP.txt"
kubectl get all -l app=trm-harvester > "$STATE_FILE" 2>/dev/null || true
echo -e "${GREEN}✓ State saved to $STATE_FILE${NC}"

echo ""
echo -e "${YELLOW}[3/5] Deploy ConfigMap, Deployment, Service, PDB, PrometheusRule${NC}"

# Apply manifest
if kubectl apply -f "$MANIFEST"; then
    echo -e "${GREEN}✓ Manifest applied${NC}"
else
    echo -e "${RED}✗ Manifest application failed${NC}"
    exit 1
fi

echo ""
echo -e "${YELLOW}[4/5] Wait for Rollout${NC}"

# Wait for deployment ready
MAX_WAIT=300  # 5 minutes
ELAPSED=0
INTERVAL=10

while ! kubectl rollout status deployment/$DEPLOYMENT_NAME -n $NAMESPACE &> /dev/null; do
    if [ $ELAPSED -ge $MAX_WAIT ]; then
        echo -e "${RED}✗ Deployment did not become ready within ${MAX_WAIT}s${NC}"
        exit 1
    fi
    echo -n "."
    sleep $INTERVAL
    ELAPSED=$((ELAPSED + INTERVAL))
done

echo -e "${GREEN}✓ Deployment ready${NC}"

echo ""
echo -e "${YELLOW}[5/5] Post-Deployment Verification${NC}"

# Verify pods running
PODS=$(kubectl get pods -l app=trm-harvester,stage=canary -o json)
RUNNING=$(echo $PODS | grep -o '"phase":"Running"' | wc -l)
DESIRED=$(kubectl get deployment $DEPLOYMENT_NAME -o jsonpath='{.spec.replicas}')

echo "  Pods running: $RUNNING/$DESIRED"
if [ "$RUNNING" -eq "$DESIRED" ]; then
    echo -e "${GREEN}✓ All pods running${NC}"
else
    echo -e "${RED}✗ Not all pods running${NC}"
    exit 1
fi

# Verify service
echo -n "  Service health: "
if kubectl get svc trm-harvester-canary &> /dev/null; then
    echo -e "${GREEN}✓${NC}"
else
    echo -e "${RED}✗${NC}"
    exit 1
fi

# Check metrics endpoint
echo -n "  Metrics endpoint: "
POD=$(kubectl get pods -l app=trm-harvester,stage=canary -o jsonpath='{.items[0].metadata.name}')
if kubectl exec $POD -- curl -s http://localhost:9090/metrics | grep image_analysis &> /dev/null; then
    echo -e "${GREEN}✓${NC}"
else
    echo -e "${YELLOW}~ (will be available shortly)${NC}"
fi

echo ""
echo -e "${GREEN}=== Deployment Complete ===${NC}"
echo ""
echo "Next steps:"
echo "1. Monitor dashboard: /grafana/d/canary-phase4"
echo "2. Check metrics: kubectl port-forward svc/trm-harvester-canary 9090:9090"
echo "3. Watch logs: kubectl logs -f deployment/$DEPLOYMENT_NAME"
echo "4. Track errors: kubectl get events | grep $DEPLOYMENT_NAME"
echo ""
echo "Decision point: 2-3 days (see $CHECKLIST)"
echo ""
