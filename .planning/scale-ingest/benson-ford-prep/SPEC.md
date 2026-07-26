# SPEC -- scale-ingest / benson-ford-prep
**Locked:** 2026-07-26  **Status:** Ready for plan-phase

## Goal
TRM can ingest a directory of thousands of doc-photo-heavy sources (Benson Ford scale) in one resumable batch command, without duplicate work, without losing progress on crash, and with doc-photos actually producing extracted facts (not silently skipped).

## Acceptance Criteria
1. `trm ingest-dir <path>` exists and processes every file under `<path>` in one invocation (no external per-file loop required).
2. Re-running `ingest-dir` on a directory where some files were already ingested (same content hash) skips those files, emits a visible per-file skip line, and reports a total duplicate count in the batch summary -- it does not re-call Vision-API or Claude CLI for already-seen hashes.
3. `--force` on `ingest-dir` reprocesses files even if their content hash was already seen.
4. Vision-API calls and Claude-CLI-subprocess calls each run under their own bounded concurrency pool (not unbounded, not fully serial); the two pools have independently configurable limits (env/config), both defaulting to a conservative value (3-5).
5. Each source's OCR/extraction/analysis result is written to its own `extracts/<hash>.json` file as soon as that item completes, plus an append to `manifest.json` recording it as done -- killing the process mid-batch leaves all already-completed items durably on disk.
6. Re-running `ingest-dir` after a crash resumes from `manifest.json` -- items already marked done are not reprocessed (this is the same mechanism as #2, driven by the manifest rather than a fresh hash computation where avoidable).
7. `extracts/extract.json` is regenerated from `manifest.json` + per-hash files after a batch completes (or on demand); its shape is unchanged from today, so `score.ts` and `report.ts` run against it with no code changes.
8. Each image is classified as `photo` or `text-doc` before further processing: automatically by default (heuristic or cheap vision/Claude call), or explicitly via a `--kind` flag / directory convention that bypasses the classifier call.
9. Images classified `text-doc` skip the Vision-API reverse-image-search lookup entirely and are routed to the new OCR endpoint, then into fact extraction -- i.e. text-docs produce extracted facts today they do not.
10. Images classified `photo` keep the current reverse-image-search behavior unchanged.
11. A per-item failure (corrupt file, OCR error, Claude CLI error) logs the error, appends a record (hash, source path, error message, timestamp) to `failed.json`, and the batch continues to the next item -- it does not abort the run.
12. A `--retry-failed` mode reprocesses only the entries currently listed in `failed.json`, without re-touching already-succeeded items.

## In Scope
- `trm ingest-dir <path>` batch CLI command (fs.readdir-based, no new dependency for directory walking).
- Content-hash (SHA-256 of file bytes) dedup check against `manifest.json` before any Vision-API/OCR/Claude-CLI call.
- `--force` override flag for dedup.
- `p-limit`-based bounded worker pools: one for Vision-API HTTP calls, one for Claude-CLI subprocess calls, independently configurable via env/config.
- Photo vs. text-doc classification step (auto by default; `--kind` flag / directory convention override).
- New OCR endpoint on the existing Vision-API service (`$CIC_INGESTION_URL`), consumed via `imageAnalyzer.ts`'s existing retry/backoff.
- Per-source incremental write: `extracts/<hash>.json` + append-only `manifest.json`.
- Derived-view regeneration of `extracts/extract.json` from manifest + per-hash files.
- `failed.json` structured failure list + `--retry-failed` reprocessing mode.

## Out of Scope (Deferred)
- Updating `score.ts` / `report.ts` to read the manifest/per-hash files directly instead of the derived `extract.json` -- only revisit if derived-view regeneration proves costly or insufficient at scale.
- Any distributed/multi-machine infra (Airflow, Dagster, Prefect, BullMQ, Temporal, IPFS, Bazel remote cache, DVC, MLflow, LakeFS) -- explicitly rejected as wrong-scale for a solo, file-based tool.
- In-process OCR library (Tesseract.js or similar) -- rejected in favor of extending the existing Vision-API service.
- Tuning exact concurrency ceiling numbers beyond a conservative default -- left to plan/execute phase, informed by observed rate-limit behavior during actual Benson Ford ingest.
- Audio, handwriting, or layout (tables/headings) extractors -- not needed for this phase's scope.

## Dependencies
- **Inputs:** Existing `src/ingestion/imageExtract/imageAnalyzer.ts` (Vision-API HTTP client, retry/backoff), `src/extraction/claudeCodeRunner.ts` (Claude CLI subprocess runner), `src/core/sourceIngest.ts` (`SourceEntry` model), `src/lineage/hasher.ts` (SHA-256 hashing utility, reusable for content-hash dedup), `src/cli/commands/ingest.ts` and `extract.ts` (current single-file CLI entry points being superseded/wrapped by `ingest-dir`).
- **Outputs:** `manifest.json`, `extracts/<hash>.json` files, regenerated `extracts/extract.json` (unchanged shape), `failed.json` -- all consumed by existing `score.ts` / `report.ts` (via the derived `extract.json`) and by the new `--retry-failed` mode.
- **External:** `$CIC_INGESTION_URL` Vision-API service must be extended with a new OCR endpoint (e.g. `/api/analyze/ocr`) -- this is an external-service change the user owns, treated as confirmed feasible for this phase. New npm dependency: `p-limit` (or equivalent bounded-concurrency library) -- no other new runtime dependencies.

## Domain Notes
- **Data shapes:** `manifest.json` is an append-only list/map of `{ hash, sourcePath, status: done|failed, timestamp }`. `extracts/<hash>.json` holds the same per-source extraction payload shape `extract.json` holds today, just split one-file-per-source. `failed.json` is a list of `{ hash, sourcePath, error, timestamp }`.
- **Classification default:** heuristic-or-cheap-call based, exact mechanism (aspect ratio/EXIF heuristic vs. a real cheap vision call) is a plan-phase implementation decision, not locked here -- SPEC only requires that a classification step exists and is overridable.
- **Concurrency:** two independent bounded pools (Vision-API, Claude CLI), both env-tunable, defaulting conservative (3-5). No hardcoded single global limit.
- **`--retry-failed` scoping decision:** included in this phase's scope (not deferred) -- `failed.json` without a consumer defeats its own purpose, and reprocessing failed hashes reuses the same batch/pool/dedup machinery being built for `ingest-dir`, so the marginal cost is small.

## Canonical References
- CONTEXT.md (this slice's decisions, D-01 through D-06)
- This session's code review of `src/cli/commands/ingest.ts`, `src/cli/commands/extract.ts`, `src/extraction/claudeCodeRunner.ts`, `src/ingestion/imageExtract/imageAnalyzer.ts`, `src/core/sourceIngest.ts`, `src/lineage/hasher.ts`
