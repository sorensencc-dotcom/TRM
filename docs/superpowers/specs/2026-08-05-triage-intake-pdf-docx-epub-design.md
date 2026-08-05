# Triage-Intake PDF/DOCX/EPUB Support — Design

## Problem

`trm triage-intake` classifies files by extension only. `.txt/.md/.json` are
routed to `classifiedType: 'text'`. Everything else that isn't an image
extension falls into the `unknown` branch and is unconditionally written as
`status: 'failed'`, `error: 'unsupported extension'`.

A real intake run (`intake/dump`, 754 files) hit 68 unique such failures, all
PDF, DOCX, or extensionless research documents. PDF and DOCX are not actually
unsupported in this repo — `src/ingestion/fileConvert.ts` already extracts
text from `.pdf` (via `pdf-parse`), `.docx` (via `mammoth`), and `.epub` (via
`extractEpub`), used today by the `trm ingest --file` command. Triage just
never calls it.

## Goals

- Classify `.pdf`, `.docx`, `.epub` as `text` (matching `.txt/.md/.json`)
  instead of auto-failing.
- Catch corrupt/scanned/empty documents at triage time, not later at ingest,
  by actually running extraction and checking the result.
- No manifest schema change, no cost added to the existing `.txt/.md/.json`
  path.

## Non-goals

- Extensionless files (e.g. `Source Articles/Sorensen_ResignationTimeline...`)
  — separate decision, out of scope.
- Caching extracted text in `intake-manifest.json` — extraction is cheap
  enough to redo at ingest time via the existing `convertFileToText`, and
  storing full document text in the manifest would bloat it for no benefit
  the ingest step doesn't already get for free.

## Design

### `src/cli/commands/triageIntake.ts`

- Import `convertFileToText` from `../../ingestion/fileConvert`.
- Add a new set: `EXTRACTABLE_TEXT_EXTENSIONS = new Set(['.pdf', '.docx', '.epub'])`.
- In `processFile`, before the existing `TEXT_EXTENSIONS.has(ext)` branch,
  add a branch for `EXTRACTABLE_TEXT_EXTENSIONS.has(ext)`:
  - `try`: call `await convertFileToText(filePath)`. Discard the returned
    text (validation only — same non-storage behavior as the plain-text
    path). On success, write `{ ...baseEntry, kind: 'text', classifiedType:
    'text', status: 'done' }`, `checkpoint()`, `summary.processedCount++`,
    bump `summary.byType.text`.
  - `catch`: write `{ ...baseEntry, kind: 'text', classifiedType: 'unsure',
    status: 'failed', error: (err as Error).message }`, `checkpoint()`,
    `summary.failedCount++`. (`convertFileToText` already throws a clear
    message for empty-extraction and parse failures — reuse it verbatim,
    don't wrap.)
- The original `.txt/.md/.json` branch is untouched: still no read, still
  synchronous, still zero extraction cost.
- The final `unknown`/`unsupported extension` branch is untouched and still
  catches extensionless files and any other unhandled extension.

### Concurrency

`convertFileToText` for PDF/DOCX is CPU/IO work but not pooled like vision
calls currently are (`visionPool`). Given intake batches are dominated by
images (vision-pooled already) and text documents are a minority, no pooling
is added for this first pass — `Promise.all` over `processFile` already
bounds concurrency at "however many files", same as the existing `.txt`
branch. If a future large batch of PDFs proves this needs throttling, that's
a follow-up, not part of this design.

### Tests (`tests/cli/commands/triageIntake.test.ts`)

Follow the existing `jest.spyOn(classifyModule, 'classifyImageDetailed')`
pattern, applied to `convertFileToText` from `fileConvert`:

1. Valid PDF (mock `convertFileToText` resolves with non-empty text) →
   `classifiedType: 'text'`, `status: 'done'`.
2. Valid DOCX → same as above.
3. Extraction throws (mock rejects, e.g. corrupt file) → `status: 'failed'`,
   `error` set to the thrown message, `summary.failedCount` incremented.
4. Confirm `.txt/.md/.json` still bypasses `convertFileToText` entirely
   (spy not called) — regression guard for the existing fast path.

## Error handling

`convertFileToText` already produces specific errors:
- Parse failure (corrupt PDF/DOCX/EPUB): converter library's native error
  message, surfaced as-is.
- Empty extraction: `trm ingest --file: "<path>" produced no extractable
  text`.

Both land in `IntakeEntry.error` unchanged, so the manifest is inspectable
the same way image-classification failures already are.

## Out of scope / explicitly deferred

- Extensionless files.
- Caching extracted text on the manifest entry.
- Concurrency pooling for document extraction.
