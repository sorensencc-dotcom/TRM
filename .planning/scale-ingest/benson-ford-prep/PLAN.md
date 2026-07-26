# PLAN -- scale-ingest / benson-ford-prep
**Mode:** Deep (D3)  **Time budget:** tight, maximize parallel dispatch
**Locked:** 2026-07-26  **Status:** Ready for PLAN AUDIT gate

Traces to SPEC.md acceptance criteria (AC1-AC12) and CONTEXT.md decisions (D-01..D-06).

## Wave structure

Four waves, each wave's tasks are mutually independent (different files, no shared
state) and can dispatch in parallel. Each wave depends only on prior waves.

```
Wave 1 (foundation, parallel x3)
  T1 content-hash + dedup lookup ─┐
  T2 p-limit worker pool wrapper ─┼─> Wave 2
  T3 manifest/per-hash store ─────┘

Wave 2 (capability, parallel x3, each depends on subset of Wave 1)
  T4 OCR endpoint client (needs T2 for pool-safe calls)     ─┐
  T5 photo/text-doc classifier + --kind flag (needs T1)     ─┼─> Wave 3
  T6 failed.json writer/reader (needs T3's write pattern)   ─┘

Wave 3 (integration, mostly sequential -- one file, ingest-dir.ts)
  T7 ingest-dir CLI command (wires T1-T6)
  T8 --force flag (small addition to T7, same file, do right after)
  T9 --retry-failed mode (same file, do right after T8)
  T10 extract.json derived-view regenerator (separate file, parallel-safe with T7-9)

Wave 4 (verification, parallel x4)
  T11 unit tests: dedup/hash (T1)
  T12 unit tests: pool wrapper (T2)
  T13 integration test: ingest-dir crash-resume on fixture dir (T7, T3)
  T14 unit tests: classification override + failed.json/retry-failed (T5, T6, T9)
```

## Tasks

### T1 -- Content-hash dedup lookup
- **Deliverable:** `src/core/contentHash.ts` -- `hashFile(path): Promise<string>` (SHA-256
  of file bytes, reuse pattern from `src/lineage/hasher.ts`), plus `isKnownHash(hash, manifest)`
  helper. `SourceEntry` in `src/core/sourceIngest.ts` gains an optional `contentHash` field.
- **Success criteria:** AC2, AC3. Hashing the same file twice yields the same hash;
  `isKnownHash` returns true/false correctly against a manifest map.
- **Files:** `src/core/contentHash.ts` (new), `src/core/sourceIngest.ts` (edit: add field).
- **Dependencies:** none.
- **Blast radius:** low -- additive field, new file.

### T2 -- Bounded concurrency worker pool wrapper
- **Deliverable:** `src/core/concurrency.ts` -- thin wrapper around `p-limit` exposing
  two named pools (`visionPool`, `claudePool`), limits read from env
  (`TRM_VISION_CONCURRENCY`, `TRM_CLAUDE_CONCURRENCY`, both default 3-5). Add `p-limit`
  to `package.json` dependencies.
- **Success criteria:** AC4. Calling `visionPool(fn)` / `claudePool(fn)` bounds
  concurrent in-flight calls to the configured limit; limits are independently
  configurable.
- **Files:** `src/core/concurrency.ts` (new), `package.json` (edit: add `p-limit`).
- **Dependencies:** none.
- **Blast radius:** low -- new file, one new dependency.

### T3 -- Manifest + per-hash incremental store
- **Deliverable:** `src/core/manifestStore.ts` -- `markDone(hash, sourcePath)`,
  `markFailed(hash, sourcePath, error)`, `isDone(hash)`, `writeExtract(hash, payload)`
  (writes `extracts/<hash>.json`), append-only `manifest.json` read/write. Writes must
  be atomic per-item (write-then-rename or equivalent) so a kill mid-write doesn't
  corrupt `manifest.json`.
- **Success criteria:** AC5, AC6. Killing the process after N items leaves N durable
  `extracts/<hash>.json` files and N manifest entries; restarting and calling
  `isDone(hash)` for those N returns true.
- **Files:** `src/core/manifestStore.ts` (new).
- **Dependencies:** none (uses T1's hash format as key convention, but no import needed --
  can build in parallel using a placeholder hash string in its own tests).
- **Blast radius:** low -- new file, new on-disk format (`manifest.json`, `extracts/<hash>.json`).

### T4 -- OCR endpoint client
- **Deliverable:** Extend `src/ingestion/imageExtract/imageAnalyzer.ts` with
  `ImageAnalyzer.ocr(filePath): Promise<OcrResult>`, POSTing to
  `${CIC_INGESTION_URL}/api/analyze/ocr`, reusing the existing retry/backoff
  (3 attempts, exponential 100/200/400ms) and timeout logic already in the class.
- **Success criteria:** AC9 (client half). `ocr()` returns extracted text on success,
  retries per existing policy on transient failure, surfaces a typed error after
  exhausting retries.
- **Files:** `src/ingestion/imageExtract/imageAnalyzer.ts` (edit: add method),
  `src/ingestion/imageExtract/IExtractor.ts` (edit: extend interface if OCR result
  type belongs there).
- **Dependencies:** T2 conceptually (calls will run under `visionPool`), but the
  method itself has no code dependency on T2 -- build in parallel, wire pool usage in T7.
- **Blast radius:** medium -- touches a file also used by existing reverse-image-search
  path; must not change existing `extract()` behavior.

### T5 -- Photo vs. text-doc classifier
- **Deliverable:** `src/ingestion/imageExtract/classify.ts` -- `classifyImage(filePath,
  opts?: { kind?: 'photo' | 'text-doc' }): Promise<'photo' | 'text-doc'>`. If `opts.kind`
  given, return it directly (no call). Otherwise run the auto-classifier (heuristic
  first pass -- implementation detail left to builder: aspect ratio / cheap vision call;
  SPEC only requires the branch point exists).
- **Success criteria:** AC8. `classifyImage` with `--kind` override returns the override
  with zero external calls; without override, returns a classification for a sample
  photo and a sample scanned-text fixture.
- **Files:** `src/ingestion/imageExtract/classify.ts` (new).
- **Dependencies:** T1 not required; independent of Wave 1, listed in Wave 2 for
  pacing only.
- **Blast radius:** low -- new file.

### T6 -- failed.json writer/reader
- **Deliverable:** `src/core/failedStore.ts` -- `appendFailure(hash, sourcePath, error)`
  writes/appends to `failed.json`; `readFailed(): FailedEntry[]` and `clearFailure(hash)`
  (removes an entry once a retry succeeds).
- **Success criteria:** AC11 (store half), AC12 (read half). Appending N failures then
  reading returns all N; clearing one leaves N-1.
- **Files:** `src/core/failedStore.ts` (new).
- **Dependencies:** none (mirrors T3's atomic-write pattern but is its own file/format).
- **Blast radius:** low -- new file.

### T7 -- `ingest-dir` CLI command
- **Deliverable:** `src/cli/commands/ingestDir.ts` -- new command registered in
  `src/cli/index.ts`. For each file under `<path>`: hash (T1) -> skip if known unless
  `--force` (T8, stub for now) -> classify (T5) -> branch: `text-doc` -> OCR (T4) under
  `claudePool`/`visionPool` (T2) -> extraction; `photo` -> existing reverse-image-search
  path unchanged -> on success, `manifestStore.markDone` + `writeExtract` (T3); on
  error, log + `failedStore.appendFailure` (T6) and continue to next file.
- **Success criteria:** AC1, AC2 (dedup check wired), AC5, AC7 (regeneration call,
  wired to T10), AC8, AC9, AC10, AC11.
- **Files:** `src/cli/commands/ingestDir.ts` (new), `src/cli/index.ts` (edit: register command).
- **Dependencies:** T1, T2, T3, T4, T5, T6 (all of Wave 1 + Wave 2).
- **Blast radius:** medium -- new CLI surface, but does not modify existing
  `ingest.ts`/`extract.ts` single-file commands (those remain as-is, unaffected).

### T8 -- `--force` flag
- **Deliverable:** Add `--force` option to `ingestDir` command; when set, the dedup
  skip-check in T7 is bypassed for that run (hash lookup still recorded/updated).
- **Success criteria:** AC3.
- **Files:** `src/cli/commands/ingestDir.ts` (edit, same file as T7 -- do immediately after).
- **Dependencies:** T7.
- **Blast radius:** low -- flag + conditional, same file as T7.

### T9 -- `--retry-failed` mode
- **Deliverable:** Add `--retry-failed` option to `ingestDir`; when set, source list
  is `failedStore.readFailed()` entries instead of a directory walk, and on success
  the entry is cleared via `clearFailure`.
- **Success criteria:** AC12.
- **Files:** `src/cli/commands/ingestDir.ts` (edit, same file as T7/T8 -- do immediately after).
- **Dependencies:** T7, T6.
- **Blast radius:** low -- same file, additive branch.

### T10 -- `extract.json` derived-view regenerator
- **Deliverable:** `src/core/regenerateExtractJson.ts` -- reads `manifest.json` +
  all `extracts/<hash>.json` files, writes the merged `extracts/extract.json` in
  today's existing shape (byte-for-byte compatible with what `score.ts`/`report.ts`
  already read). Called once at the end of an `ingest-dir` batch (wired into T7).
- **Success criteria:** AC7. Running `score.ts`/`report.ts` unmodified against the
  regenerated `extract.json` produces the same output as before this phase, given
  equivalent underlying facts.
- **Files:** `src/core/regenerateExtractJson.ts` (new).
- **Dependencies:** T3 (reads its output format). Independent of T7-9's file, can
  build in parallel; wire the call site into T7 as a small follow-up edit.
- **Blast radius:** low -- new file; must exactly match existing `extract.json` shape
  (verify against current `src/cli/commands/extract.ts` output format before finalizing).

### T11 -- Unit tests: dedup/hash
- **Deliverable:** Tests for T1 (`contentHash.ts`).
- **Files:** `src/core/contentHash.test.ts` (new).
- **Dependencies:** T1.
- **Blast radius:** none (test-only).

### T12 -- Unit tests: pool wrapper
- **Deliverable:** Tests for T2 (`concurrency.ts`) -- verify concurrency ceiling
  actually bounds simultaneous execution, independent limits for the two pools.
- **Files:** `src/core/concurrency.test.ts` (new).
- **Dependencies:** T2.
- **Blast radius:** none (test-only).

### T13 -- Integration test: crash-resume
- **Deliverable:** Test that runs `ingestDir` against a small fixture directory,
  kills/truncates mid-batch (simulate via aborting after N items), re-runs, and
  asserts already-done items are skipped and the batch completes.
- **Files:** `tests/ingestDir.crash-resume.test.ts` (new).
- **Dependencies:** T7, T3.
- **Blast radius:** none (test-only).

### T14 -- Unit tests: classification override + failed/retry
- **Deliverable:** Tests for T5's `--kind` override path and auto path against
  fixtures; tests for T6/T9's failed.json append -> retry -> clear cycle.
- **Files:** `src/ingestion/imageExtract/classify.test.ts` (new),
  `src/core/failedStore.test.ts` (new).
- **Dependencies:** T5, T6, T9.
- **Blast radius:** none (test-only).

## Requirement-to-task coverage check (PLAN AUDIT input)

| SPEC AC | Covered by |
|---|---|
| AC1 (ingest-dir exists) | T7 |
| AC2 (dedup skip + log + count) | T1, T3, T7 |
| AC3 (--force) | T8 |
| AC4 (independent bounded pools) | T2 |
| AC5 (per-item durable write) | T3, T7 |
| AC6 (resume from manifest) | T3, T13 |
| AC7 (extract.json derived view, unchanged shape) | T10 |
| AC8 (photo/text-doc classification, override) | T5 |
| AC9 (text-doc -> OCR -> extraction) | T4, T5, T7 |
| AC10 (photo -> unchanged reverse-image path) | T7 (explicit non-change) |
| AC11 (failure -> log + failed.json, continue) | T6, T7 |
| AC12 (--retry-failed) | T9 |

No SPEC acceptance criterion is uncovered. No task exists without a traced AC
(T11-T14 trace to verification of T1-T10, not new AC).

## Out-of-scope reminder (do not build)
Per SPEC: no score.ts/report.ts edits, no Airflow/Dagster/BullMQ/Temporal/IPFS/DVC/
MLflow/LakeFS, no in-process OCR library, no hardcoded concurrency tuning beyond
the conservative env-configurable default.
