# WhichLLM Model Selection Evaluator Specification & Invariants

## 1. Overview & Purpose
The WhichLLM Model Selection Evaluator in TRM discovers locally installed Ollama models, executes the 4 Berkeley Function Calling Benchmark (BFCL) disciplines, evaluates host hardware capacity, computes SHA-256 self-integrity hashes, and recommends local muscle and frontier judgment anchors.

---

## 2. Artifact Schema & Structure (`_integration/model_selection.json`)

The generated artifact adheres to the following structural contract:

```json
{
  "evaluated_at": "2026-09-13T14:54:00.698Z",
  "hardware_profile": {
    "gpu_count": 1,
    "gpu_name": "NVIDIA RTX 4090",
    "vram_gb": 24,
    "ram_gb": 64
  },
  "test_suite_coverage": {
    "total_bfcl_scenarios": 4,
    "scenarios_run": [
      { "id": "bfcl-cic-001-simple-read", "name": "Simple Tool Call - Read Shared Context" },
      { "id": "bfcl-cic-002-parallel-dispatch", "name": "Parallel Tool Call - Dual-Task Submission" },
      { "id": "bfcl-cic-003-nested-resolver", "name": "Nested Tool Call - Parse and Resolve Upstream ID" },
      { "id": "bfcl-cic-004-relevance-rejection", "name": "Negative Relevance Rejection (No tool match)" }
    ]
  },
  "recommendations": {
    "frontier_judgment_anchor": "claude-3-5-sonnet-20241022",
    "local_muscle_anchor": "qwen2.5:7b",
    "local_fit_reasoning": "Model fits cleanly in VRAM with comfortable overhead. Maximum tokens/sec unlocked."
  },
  "ranked_candidates": [ ... ],
  "lineage": {
    "contract_type": "extractor-upgrade-sweep",
    "schema_version": "2.4.0",
    "provenance_flags": [
      "bfcl_v2_automated",
      "hardware_aware_compaction",
      "live_ollama_discovery"
    ]
  },
  "hash_chain_self": "ecfb1399217ece0eef68b56f9f3c87fcd3e8e1ae84139b66887f281fba1e72b8"
}
```

---

## 3. Canonical SHA-256 Hash Invariants

The artifact is **hash-verified** (not asymmetrically signed):
1. The artifact payload is constructed without `hash_chain_self`.
2. All keys are sorted recursively and serialized via deterministic JSON stringification.
3. `hash_chain_self` is calculated as:
   $$\text{hash\_chain\_self} = \text{SHA256}(\text{canonicalJson}(\text{payloadWithoutSelfHash}))$$
4. Consumers (e.g. Helix) strip `hash_chain_self`, compute the SHA-256 hash across the canonical payload, and verify equality before accepting recommendations.

---

## 4. Dual-Path Execution Model

1. **Automated TRM Research Path**:
   - Automated background cascade: `Local` $\to$ `Claude` $\to$ `Antigravity` $\to$ `Codex` $\to$ `Grok`.
   - Automatic rate-limit progression on HTTP 429 / 503.
   - Bounded strictly to TRM batch extraction and mining workloads.
2. **Interactive Helix Path**:
   - **No Auto-Resend Invariant**: Helix never automatically dispatches failed payloads to alternative providers.
   - On local failure, Helix presents configured alternatives, offers the user's cloud preference as a selectable option, and awaits explicit user selection and resubmission.
