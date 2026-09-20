# Internet Archive Archival-Admission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admit verified Internet Archive media into TRM with quarantine, provenance, deterministic staging, and delegation to the existing video-ingest path.

**Architecture:** A thin archival adapter validates a local manifest and live IA metadata, stages and hashes approved media, then invokes the existing `ingest-dir`/video pipeline. It owns admission failures and staging cleanup; TRM owns media processing, deduplication, extraction, and retry state.

**Tech Stack:** Node 20, TypeScript strict/CommonJS, Jest, existing TRM JSON stores, and the existing ffmpeg/ffprobe video pipeline.

**Spec:** `docs/superpowers/specs/2026-09-20-archival-admission.md`

## Global Constraints

- Preserve separate IA identifier, downloaded media SHA-256, and TRM `SourceEntry.id` identities.
- Quarantined identifiers perform zero media downloads and never enter `failed.json` or `--retry-failed`.
- Existing video-ingest remains the sole owner of media processing.
- Catalog verification sets `claimStatus: 'catalog_only'`; human review alone may set `frame_verified`.
- Automated `timestampMs` values cannot populate editorial timecodes.
- No NotebookLM, licensing, or production-approval changes.

## Boundary

This plan adds catalog admission and provenance only. Existing video ingestion
owns ffprobe, ffmpeg, whisper, Vision analysis, extraction, deduplication, and
media-processing failures.

```text
IA identifier
  → archival manifest admission
  → IA metadata validation
  → deterministic staging download
  → content hash
  → existing ingest-dir/video path
```

## Task 1 — Define archival manifest and evidence contract

Create a versioned archival manifest containing:

- `source_system: "internet_archive"`;
- `archive_identifier`;
- canonical item URL;
- expected catalog title and contributor where available;
- `verification_status: verified | quarantined`;
- `quarantine_reason` when quarantined;
- `metadata_fetched_at`;
- `metadata_sha256`;
- verification basis/reviewer note.

Initial records must be checked against captured IA metadata before being marked
`verified`. Do not rely on search-result citations alone. Store the captured
metadata hash and retrieval timestamp with each record.

The three unresolved identifiers remain present as quarantined records.

## Task 2 — Implement exact metadata validation

Add a thin Internet Archive metadata client and validator.

Required rules:

1. Requested identifier must equal the metadata response identifier exactly.
2. Missing, malformed, or non-object metadata is rejection.
3. Local manifest status must be `verified` before download is allowed.
4. Expected title/contributor checks are exact after documented normalization:
   trim surrounding whitespace, normalize repeated whitespace, preserve case for
   the recorded value, and reject disagreement.
5. Validation failure updates archival quarantine state only; it does not create a
   TRM source, raw envelope, completion manifest entry, or media failure entry.

## Task 3 — Implement deterministic staging and download ownership

Use a staging path owned by the archival adapter:

```text
<topic-root>/.archival-staging/internet_archive/<archive_identifier>/
```

Rules:

- reject identifiers containing path separators or traversal segments;
- write to a temporary filename inside the identifier directory;
- verify download completion and calculate media SHA-256;
- atomically rename the completed file to its final staging filename;
- delete partial files on failure;
- retain completed staged media until the delegated ingest finishes;
- never pass a partial file to `ingest-dir`.

Use an independent bounded download pool, default one concurrent download.

Download failures belong to a dedicated archival download-failure result/event,
not media `failed.json`, because the source has not yet entered the TRM media
pipeline. A later explicit retry may retry the download only after the archival
manifest still validates as `verified`.

## Task 4 — Extend existing provenance models additively

Add optional archival provenance to the existing `SourceEntry` and
`RawSourceEnvelope` structures. Preserve the existing TRM source ID and content
hash behavior.

Required claim status:

```text
catalog_only → frame_verified
```

Catalog admission may set only `catalog_only`. Automated frame `timestampMs`
values remain extraction provenance and must not become editorial cut-sheet
`timecode_in`/`timecode_out` values.

## Task 5 — Delegate to existing video ingestion

Expose a thin archival command/adapter that:

1. loads the local archival record;
2. validates current IA metadata;
3. downloads and hashes the media;
4. invokes the existing `ingest-dir`/video-ingest boundary with the staged path
   and archival provenance;
5. reports the existing media-processing result without reimplementing it.

No second deduplication, manifest, extraction, or failed-store path is allowed.

## Task 6 — Tests

Add focused tests for:

- verified record accepted;
- unknown identifier rejected;
- quarantined identifier performs zero metadata-download/media-download work;
- exact identifier mismatch quarantined;
- title/contributor mismatch quarantined;
- malformed metadata quarantined;
- path traversal rejected;
- download writes atomically;
- interrupted download leaves no completed staged file;
- partial file is removed after download failure;
- media hash recorded;
- download failure does not enter media `failed.json`;
- archival provenance survives source/raw-envelope round trip;
- verified media reaches existing video ingestion;
- quarantine never enters `--retry-failed`;
- existing video-ingest tests remain unchanged and pass.

## Dependency order

```text
Task 1 → Task 2 → Task 3 → Task 4 → Task 5
                         └────────→ Task 6
```

Tasks 1 and 4 may be developed independently, but integration waits for the
manifest and validator contract. Task 5 is the only convergence point with the
existing video-ingest plan.

## Verification commands

```text
npm run typecheck
npx jest <archival-admission-tests> --runInBand
npx jest <existing-video-ingest-tests> --runInBand
npm test -- --runInBand
```

Report focused archival tests, existing video tests, and full-suite results
separately. Do not claim live IA verification unless the metadata and download
commands were executed against the two verified identifiers.
