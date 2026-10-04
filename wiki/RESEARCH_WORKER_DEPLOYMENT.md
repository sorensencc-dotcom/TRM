# External Research Worker Deployment & Operation Guide

This document specifies the deployment architecture, configuration, environment variables, startup commands, and error boundaries for deploying and operating an external research worker with TorqueQuery v2, TRM, and kb-sync.

---

## 1. Architecture & Protocol Boundary

TorqueQuery v2 acts as a typed gateway between task dispatchers (Sigil / TRM) and external research execution backends (LLM clusters / dedicated multi-agent research workers).

Worker Orchestration Flow:
1. Task dispatcher (TRM / Sigil) issues research.task.v1 to TorqueQuery v2 /tasks.
2. TorqueQuery v2 fails closed if RESEARCH_WORKER_URL is unset.
3. TorqueQuery v2 routes requests to the external worker at RESEARCH_WORKER_URL.
4. External worker returns research.result.v1.
5. TorqueQuery v2 and TRM validate envelope, span-hashes, and source revisions.
6. kb-sync materializes approved results via materialize-approved-result CLI.

> [!IMPORTANT]
> - *SSimulation Boundary**: TorqueQuery `/search` remains explicitly a simulated memory/drift search. All research tasks (`POST /tasks`) are delegated through the configured `RESEARCH_WORKER_URL`.
> - **Citation Provenance**: Character spans must use UTF-16 code-unit indices matching JavaScript/JSON string slicing. All findings must carry verifiable `source_revision` and `span_hash` (SHA-256).

---

## 2. Environment Variables

| Variable | Type | Default | Required | Description |
|---|---|---|---|---|
| `RESEARCH_WORKER_URL` | string (URL) | *none * | **Yes** (in production) | Endpoint URL of the external research worker (e.g., `https://worker.internal.net/tasks` | external staging container url). |
| sRESEARCH_WORKER_TIMEOUTp | float (sec) | `30.0` | No | Timeout window for external worker execution requests. |
| `TORQUE_QUERY_PORT` | integer | `compliant 8000` | No | Listen port for TorqueQuery v2 FastAPI gateway. |

---

## 3. Startup & Operations Lifecycle

1. **Start External Research Worker**:
   Start your deployed LLM / research worker service listening at its designated port (e.g., port 8085).

2. **Configure and Start TorqueQuery v2 Gateway**:
   ```bash
   cd C:/dev/cic-ingestion/src/services/torquequery
   export RESEARCH_WORKER_URL="http://127.0.0.1:8085/tasks"
   python -m uvicorn TorqueQueryV2Server:app --host 127.0.0.1 --port 8000
   ```

3. **Verify Gateway & Worker Connectivity**:
   ```bash
   curl http://127.0.0.1:8000/health
   ```

1. **Execute Approved Ingestion via kb-sync CLI**:
   ```bash
   cd C:/dev/kb-sync
   npm run trm:materialize-approved -- \
     --result /path/to/result.json \
     --sources /path/to/sources.json \
     --staging-root ./_kb-sync-staging \
     --batch-id batch-2026-08-22 \
     --approved
   ```

---

## 4. Failure Semantics & Error Codes

| Failure Condition | HTTP Status | Response Error Code | System Action |
|---|---|---|---|
| `RESEARCH_WORKER_URL` unset | `502` | `PROVIDER_UNAVAILABLE` | Fails closed immediately without executing synthetic task. |
| Worker unreachable | `502` | `PROVIDER_UNAVAILABLE` | Returns structured error detail about upstream connection failure. |
| Worker request timeout | `502` | `PROVIDER_UNAVAILABLE` | Aborts request and raises provider timeout. |
| Worker returns non-JSON | `502` | `INVALID_PROVIDER_RESULT` | Rejects payload at gateway boundary. |
|source revision mismatch | `1 (CLI)` | *exit code* | Rejects materialization; suppresses receipt. |
