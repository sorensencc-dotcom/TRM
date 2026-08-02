# Intake Triage Manifest — Design

Date: 2026-08-02
Status: Approved (brainstorming), pending implementation plan

## Problem

TRM has a growing backlog of unprocessed material — Benson Ford Research
Library photos/doc-photos, MFM leftovers, thousands of older items,
eventual full personal-archive dump — sitting in scattered, semi-organized
locations (local disk, cloud-synced folders, email attachments, old
claude.ai chat exports). No automated raw-intake step exists today: every
prior batch (MFM) was hand-triaged by an agent reading photos one by one,
which does not scale (see
`memory/project-trm-ingest-scale-problem-2026-07-25.md`).

Different item types need different downstream pipelines (doc-photo → OCR,
exhibit-photo → vision-judgment, old chat text → text extraction). Routing
everything through one rubric wastes vision calls and misclassifies. This
design covers only the **triage step**: turn a raw, unsorted dump into a
manifest that downstream pipelines can consume by type — not the
downstream pipelines themselves.

## Scope (v1)

- Input: files already present on local disk under `trm/intake/<batch>/**`.
  User manually drops cloud/email-sourced material into a batch folder
  before running triage — no live Drive/email API pull in v1.
- Output: a single resumable manifest file, `trm/intake-manifest.json`.
  Files are **not** moved, renamed, or copied — manifest maps path → type.
- Out of scope: per-type downstream ingest (OCR, vision-judgment,
  text-extraction pipelines), live cloud/email pulling, physical file
  reorganization.

## Data model

New module `src/core/intakeManifest.ts`, mirroring the existing
`manifestStore.ts` pattern (hash-keyed entries, `writeFileAtomic`,
done/failed status, resumable) but top-level/global rather than scoped to
a topic node — triage runs before any topic assignment exists.

```ts
export type IntakeKind = 'image' | 'text';
export type IntakeType =
  | 'exhibit-photo'
  | 'doc-photo'
  | 'text'
  | 'junk'
  | 'unsure';
export type IntakeStatus = 'done' | 'failed';

export interface IntakeEntry {
  hash: string;            // sha256 via existing contentHash.ts
  sourcePath: string;      // path as found under intake/<batch>/
  batch: string;           // intake subfolder name = provenance tag
  ext: string;
  sizeBytes: number;
  kind: IntakeKind;
  classifiedType: IntakeType;
  confidence?: number;     // vision call confidence, images only
  isDup: boolean;          // true if this hash already seen earlier in manifest
  status: IntakeStatus;
  error?: string;          // set when status = 'failed'
  classifiedAt: string;    // ISO timestamp
}

export interface IntakeManifestFile {
  entries: Record<string, IntakeEntry>; // keyed by hash
}
```

Stored at `trm/intake-manifest.json` (repo root level, alongside other
top-level TRM state — not under `nodeDir`).

## Flow (per file)

1. `hashFile()` (reuse `src/core/contentHash.ts`, unchanged) → sha256.
2. If hash already present in manifest with `status: 'done'` → skip.
   This is the resume mechanism: rerunning the script after an interrupt
   or on a newly-added batch only processes new/failed hashes.
3. If hash already present in manifest at all (any status `done`, any
   path) — i.e. seen earlier in *this* manifest, including from a
   different batch folder — mark `isDup: true`, copy the earlier entry's
   `classifiedType`/`confidence`, write with `status: 'done'`, **no
   vision call**. Exact-duplicate detection only (content hash equality),
   not perceptual/near-dup.
4. Else determine `kind` by extension:
   - Text extensions (`.txt`, `.md`, `.json` chat-export files) →
     `kind: 'text'`, `classifiedType: 'text'`, no vision call.
   - Image extensions (`.jpg`, `.jpeg`, `.png`, `.heic`, `.webp`) →
     `kind: 'image'` → call vision classifier (below) through the
     existing `visionPool` limiter (`src/core/concurrency.ts`,
     `TRM_VISION_CONCURRENCY` env var, already used elsewhere).
   - Anything else (unknown extension) → `status: 'failed'`,
     `error: 'unsupported extension'`, continue.
5. Write the entry into the manifest and flush atomically
   (`writeFileAtomic`, same pattern as `manifestStore.writeManifestEntry`)
   immediately after each file — a crash mid-run loses at most the
   in-flight item, not prior progress.

## Vision classifier (new)

`src/extraction/visionClassifier.ts` — single Claude Haiku call per
image, single-label classification prompt returning
`{ type: IntakeType; confidence: number }` constrained to
`exhibit-photo | doc-photo | junk | unsure`.

- Reads `ANTHROPIC_API_KEY` from env. **Hard-fails** (throws, does not
  silently fall back to a mock) if the key is missing — direct response
  to a prior incident (`finding-ijfw-fts5-missing-dep-fixed-2026-07-26`
  era pattern: a missing dependency silently degraded to mock behavior
  and stayed broken 6+ weeks unnoticed). No env var → script refuses to
  run rather than producing a manifest full of fake classifications.
- No existing vision-call plumbing to reuse: `claudeCodeRunner.ts` /
  `stubRunner.ts` are text-only fact extractors; MFM's photo triage was
  done manually by a subagent reading each image, not a scripted API
  call. This is new, minimal surface — one function, one prompt.

## Error handling

- Unreadable/corrupt file → caught, `status: 'failed'`, `error` message
  set, loop continues to next file (one bad file does not kill the run).
- Vision API failure/timeout → same: `status: 'failed'`, logged,
  continues. Because failed entries are not `done`, the next run retries
  them automatically — no separate retry command needed.
- Unsupported extension → `status: 'failed'`, `error: 'unsupported extension'`.

## CLI

`npm run triage:intake -- [--dir intake/<batch>]`

- No `--dir` → walk every subfolder under `trm/intake/`.
- `--dir intake/<batch>` → scope to one batch (e.g. re-run just Benson
  Ford after dropping more files in).
- On completion, print a summary: counts by `classifiedType`, by `batch`,
  dup count, failed count.

## Downstream (explicitly out of scope here)

Next stage(s) — not designed in this doc — read `intake-manifest.json`
filtered by `classifiedType` and `!isDup`, grouped by `batch`, and route:
`doc-photo` → OCR-first path, `exhibit-photo` → MFM-style vision-judgment
path, `text` → chat-export text-extraction path. Each becomes its own
future design/plan.

## Testing

- Unit tests for `intakeManifest.ts` read/write/resume logic, mirroring
  `tests/core/rawSource.test.ts` conventions already in the repo.
- Unit test for dedup: two files with identical content hash → second
  entry gets `isDup: true`, no second vision call.
- Unit test for kind routing (text extension bypasses vision; image
  extension calls classifier) using a mocked `visionClassifier`.
- No live-API integration test in this pass (classifier hard-fails
  without a key; CI should mock it, not skip the check).
