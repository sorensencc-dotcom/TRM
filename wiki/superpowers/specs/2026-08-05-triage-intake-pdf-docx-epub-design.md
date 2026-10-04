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
  - `try`: call `await docPool(() => convertFileToText(filePath))` (see
    Concurrency below). The extracted text is used only to validate that
    extraction succeeds — it is intentionally not persisted. On success,
    write `{ ...baseEntry, kind: 'text', classifiedType: 'text', status:
    'done' }`, `checkpoint()`, `summary.processedCount++`, bump
    `summary.byType.text`.
  - `catch`: write `{ ...baseEntry, kind: 'text', classifiedType: 'unsure',
    status: 'failed', error: errMessage }`, `checkpoint()`,
    `summary.failedCount++`, where `errMessage = err instanceof Error ?
    err.message : String(err)` (defensive cast — `convertFileToText`'s
    underlying libraries (pdf-parse, mammoth, the epub extractor) are not
    guaranteed to always throw `Error` instances, so the unchecked `(err as
    Error).message` cast used elsewhere in this file is not safe to copy
    here unmodified).
    `classifiedType: 'unsure'` on failure matches the existing convention
    in the image-classification catch branch a few lines above (kind
    stays what it structurally is; `classifiedType` on a `failed` entry
    means "not successfully classified," not "wrong type guess") — kept
    for consistency rather than introduced fresh here.
    A successful parse that yields empty text (e.g. a scanned-image PDF
    with no OCR layer) is not a parser crash — `convertFileToText` treats
    it as a validation failure and throws accordingly, and it lands here
    as `status: 'failed'` the same as any other extraction error.
- The original `.txt/.md/.json` branch is untouched: still no read, still
  synchronous, still zero extraction cost. A comment is added above both
  extension sets explaining the split (`TEXT_EXTENSIONS` = zero-cost,
  extension-only classification; `EXTRACTABLE_TEXT_EXTENSIONS` = requires
  running real extraction to classify) so a future contributor doesn't
  merge them and put every `.txt` through `convertFileToText`.
- The final `unknown`/`unsupported extension` branch is untouched and still
  catches extensionless files and any other unhandled extension.

### Concurrency

`pdf-parse` and `mammoth` load the full document into memory to parse it.
`Promise.all` over `processFile` does not bound concurrency — it launches
every file's work at once — so an unpooled batch of a few thousand PDFs
would attempt that many simultaneous in-memory parses and risk an OOM
crash, unlike images (already bounded by `visionPool`) or plain text
(near-zero memory cost per file).

Add a new pool in `src/core/concurrency.ts`, following the existing
`visionPool`/`claudePool` pattern exactly:

```ts
export const docPool = pLimit(configuredLimit('TRM_DOC_CONCURRENCY'));
```

`triageIntake.ts` wraps every `EXTRACTABLE_TEXT_EXTENSIONS` extraction call
in `docPool(...)`, the same way it already wraps `classifyImageDetailed` in
`visionPool(...)`. Default concurrency is 4 (`DEFAULT_CONCURRENCY`, shared
with the other pools), overridable via `TRM_DOC_CONCURRENCY` for tuning.
This caps simultaneous in-memory parses regardless of batch size, closing
the OOM risk.

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
5. Empty extraction (mock rejects with `new Error('...produced no
   extractable text')`) → `status: 'failed'`, `error` preserved verbatim.
   Distinct case from #3: this is the validation-failure path, not a
   parser-corruption path, and both must be verified separately.

## Error handling

`convertFileToText` already produces specific errors:

- Parse failure (corrupt PDF/DOCX/EPUB): converter library's native error
  message, surfaced as-is.
- Empty extraction (validation failure, not a crash — e.g. a scanned-image
  PDF with no OCR layer parses fine but yields no text): `trm ingest --file:
  "<path>" produced no extractable text`.

Both land in `IntakeEntry.error` unchanged, so the manifest is inspectable
the same way image-classification failures already are.

## Out of scope / explicitly deferred

- Extensionless files.
- Caching extracted text on the manifest entry.
