# CONTEXT -- scale-ingest / benson-ford-prep

**Captured:** 2026-07-25
**Status:** Ready for SPEC.md / plan-phase

## Domain

Right-size TRM's file-based ingest pipeline (dedup, bounded concurrency, OCR-enabled
doc-photo extraction, crash-safe incremental writes, batch CLI) to handle the
upcoming Benson Ford ingest (thousands of doc-photo-heavy sources), without
introducing heavyweight infra (no Airflow/Dagster/BullMQ/Temporal/IPFS/DVC).

## Carried Forward (from prior decisions)

- None -- first CONTEXT.md in this milestone/phase, no prior decisions to carry.
- User-approved right-sized fix list from this session's code review is the
  scope baseline: (1) content-hash dedup, (2) p-limit bounded worker pool,
  (3) OCR-before-extract for doc-photos, (4) per-source incremental manifest,
  (5) `trm ingest-dir <path>` batch CLI command.

## Decisions

### 1. extract.json backward compatibility / scope boundary
- **D-01:** `extracts/extract.json` becomes a generated/derived merged view,
  auto-regenerated from `manifest.json` + per-hash `extracts/<hash>.json`
  files after each batch (or on-demand). `score.ts` and `report.ts` are
  unchanged -- zero downstream-consumer edits in this phase.
- **Why:** Keeps this phase scoped to ingest-side crash-safety; avoids
  expanding scope into unaudited consumer code.
- **Rejected:** (B) update score/report to read the manifest directly --
  scope expansion, deferred to a later phase if ever needed. (C) defer
  entirely and leave consumers stale/broken -- unacceptable, breaks existing
  tooling silently.

### 2. OCR engine choice
- **D-02:** Extend the existing Vision-API service (`$CIC_INGESTION_URL`)
  with a new OCR endpoint (e.g. `/api/analyze/ocr`), called alongside/after
  the existing reverse-image lookup in `imageAnalyzer.ts`. User owns/can
  extend that service's code -- treated as confirmed feasible, not TBD.
- **Why:** Reuses existing retry/backoff logic already built into
  `imageAnalyzer.ts`; no new dependency, no new subsystem.
- **Rejected:** (B) in-process OCR library (e.g. Tesseract.js) -- new
  dependency + binary/wasm footprint + new failure mode outside existing
  retry infra. (C) route doc-photos through Claude CLI vision instead of
  Vision-API -- bypasses existing retry infrastructure, inconsistent with
  the rest of the image pipeline.

### 2b. Photo vs. text-document classification mechanism
- **D-03:** Hybrid. Auto-classify by default (fast heuristic or cheap
  vision/Claude call decides photo vs. text-doc), with an optional `--kind`
  override flag / directory convention to skip the classifier call when the
  caller already knows. Text-doc branch skips the Vision-API reverse-image
  lookup entirely and routes straight to OCR (D-02's new endpoint) +
  extraction. Photo branch keeps the existing reverse-image-search behavior
  unchanged.
- **Why:** Benson Ford is doc-photo heavy; auto-classification avoids
  requiring Chris to pre-sort thousands of files, while the override flag
  keeps the door open to skip classifier cost/latency when the layout is
  already known.
- **Rejected:** (A) pure manual tag/flag only -- doesn't scale without a
  pre-sorted source layout. (B) pure auto-classify only, no override --
  removes a cheap escape hatch for known layouts.

### 3. Per-item failure handling in `ingest-dir`
- **D-04:** Skip-and-log-continue. On a single-item failure (corrupt image,
  OCR failure, Claude CLI error), log it and continue the batch. Failures
  are also appended to a structured `failed.json` (hash, source path, error
  message, timestamp) enabling a later retry-failed pass that reprocesses
  only the failed items, not the whole batch.
- **Why:** A multi-hour, thousands-of-file run shouldn't halt on one bad
  file; a structured retry list avoids re-paying Claude CLI / Vision API
  cost for already-succeeded items.
- **Rejected:** (B) stderr-only logging with no structured retry list --
  loses resumability for failures specifically. (C) abort-the-whole-batch on
  first failure -- unacceptable at this scale.

### 4. Dedup collision policy
- **D-05:** Skip+log by default -- a re-ingest hitting an already-seen
  content hash is skipped, with a visible stderr line and a duplicate
  counter surfaced in the batch summary (never silent). An explicit
  `--force` flag allows deliberate reprocessing of an already-seen hash,
  for use when extraction/OCR/classification logic changes and a full
  reprocess is wanted.
- **Why:** Visibility by default avoids confusing silent skips; `--force`
  covers the iterative-tuning case expected during Benson Ford ingest
  without adding cost to the common path.
- **Rejected:** (A) silent skip -- no signal when dedup fires, confusing at
  scale. (Plain C without B) override-flag-only with no default logging --
  loses default visibility.

### 5. Concurrency defaults
- **D-06:** Conservative default concurrency (e.g. 3-5), with **separate**
  knobs for Claude CLI subprocess calls vs. Vision-API HTTP calls (they have
  different cost/rate-limit profiles), tunable via env/config rather than
  hardcoded. Not interrogated further -- recorded as a sensible default per
  explicit user instruction; no known hard rate-limit numbers supplied to
  override this.
- **Why:** One global knob would conflate two call types with different
  cost/rate-limit characteristics; a conservative default is safe to start
  and tunable once real throughput/rate-limit behavior is observed during
  Benson Ford ingest.
- **Rejected:** N/A -- default recorded, not a forced choice between
  alternatives; may be revisited if plan-phase or execute-phase surfaces
  concrete rate-limit numbers.

## Canonical References

- No external references cited by the user -- decisions self-contained,
  informed by this session's code review of `src/cli/commands/ingest.ts`,
  `src/extraction/claudeCodeRunner.ts`, `src/cli/commands/extract.ts`,
  `src/ingestion/imageExtract/imageAnalyzer.ts`, and `src/core/sourceIngest.ts`.

## Deferred Ideas

- Updating `score.ts`/`report.ts` to read the manifest/per-hash files
  directly instead of the derived `extract.json` view -- proposed as a
  future phase only if the derived-view regeneration step proves costly or
  insufficient at scale.
- `retry-failed` CLI command/flag to consume `failed.json` -- referenced as
  the intended consumer of D-04's structured failure list; this phase's
  SPEC should confirm whether writing `failed.json` alone is in-scope, or
  whether the retry command itself is also in-scope vs. a fast-follow.

## Low-Priority Gray Areas (not interrogated)

- Exact concurrency ceiling numbers (vs. just "conservative default,
  separate knobs") -- left to plan-phase/execute-phase discretion; tune
  against observed Claude CLI and Vision API rate-limit behavior during
  actual Benson Ford ingest rather than guessing upfront.
