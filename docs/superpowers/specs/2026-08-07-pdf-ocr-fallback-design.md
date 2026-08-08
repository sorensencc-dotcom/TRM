# Scanned-PDF OCR Fallback — Design

## Problem

`src/ingestion/fileConvert.ts` extracts PDF text via `pdf-parse`. That works
for PDFs with a real text layer, but fails on scanned PDFs (image-only pages,
no embedded text) — `pdf-parse` returns empty text, and `convertFileToText`'s
post-check throws `"produced no extractable text"`.

Trigger: 3 vessel-register PDFs (likely Helene provenance) are scanned scans
with no text layer. They need OCR before their content is usable.

Separately, `src/ingestion/imageExtract/imageAnalyzer.ts` already has a real
Google Vision OCR endpoint (`ImageAnalyzer.ocr()` → `/api/analyze/ocr`), used
today for image files (jpeg/png/gif/webp) in `ingestDir.ts`. It has no PDF
input path — it only accepts single-image buffers.

Neither existing system covers scanned PDFs. This design adds the missing
link: render PDF pages to images, run each through the existing OCR
endpoint.

## Goals

- `convertFileToText` (and therefore `trm ingest --file` and
  `triage-intake`, both of which call it) transparently handles scanned
  PDFs — no new CLI flag, no new command.
- Text-layer PDFs keep the current zero-OCR-cost fast path unchanged.
- Bounded cost: a hostile or oversized scanned PDF cannot cause unbounded
  memory use or unbounded Vision API spend.
- Partial success (some pages OCR, some don't) yields usable output rather
  than an all-or-nothing failure.

## Non-goals

- No manifest schema change (matches the existing PDF/DOCX/EPUB triage
  design's non-goal — extraction stays cheap-to-redo, not cached).
- No new CLI flag / explicit `--ocr` override — the fallback is automatic,
  triggered only when `pdf-parse` yields empty text.
- No cancellation support mid-document — matches existing ingest pipeline
  behavior (nothing else in it is cancellable mid-run either).
- No OCR for DOCX/EPUB — those formats don't have a "scanned, no text
  layer" failure mode the way PDF does.

## Design

### Fast path (unchanged)

`extractPdf(buffer)` calls `pdf-parse` first. Non-empty trimmed text →
return immediately. Zero added cost for the common case.

### Fallback path (new)

Triggered only when `converters.extractPdf(buffer)` returns
empty/whitespace text. **Orchestration lives in `convertFileToText`, not
inside `extractPdf`.** `extractPdf`'s contract (`(buffer) => Promise<string>`)
has no room for the renderer/OCR dependencies, and it stays exactly what it
is today — a thin `pdf-parse` wrapper. `convertFileToText` already has
access to every converter on the `FileConverters` object, so it's the
right place to sequence "try extractPdf, then fall back."

1. **Size guard.** Applies only inside the fallback — i.e. only after
   `extractPdf` has already returned empty text. Text-layer PDFs of any
   size still go through the unchanged fast path with no size check
   (matches the "no cost added to existing PDFs" goal). Check
   `buffer.length` against `TRM_PDF_MAX_BYTES` (default 100MB). Over limit
   → throw immediately.
2. **Page-count guard.** Call `converters.getPdfPageCount(buffer)` — a
   cheap pdfjs-dist `getDocument().numPages` lookup that does *not* render
   any page — and check against `TRM_PDF_MAX_PAGES` (default 50). Over
   limit → throw immediately, before any rendering. This check happens
   before rendering starts, not "resolved at implementation time."
3. **Render + OCR, one page at a time, pipelined.** For each page number
   `1..count`, in order:
   - `docPool(() => converters.renderPdfPage(buffer, pageNumber))` — renders
     *one* page to a PNG buffer via `pdf-to-png-converter`'s
     `pagesToProcess: [pageNumber]` option (wraps `pdfjs-dist` +
     `@napi-rs/canvas`; prebuilt binaries, no node-gyp/compiler step,
     Windows-safe, requires Node ≥20 — repo runs Node 24), at a fixed 150
     DPI (bounds per-page image size). `docPool` is the same pool already
     bounding `pdf-parse`/`mammoth` in `triageIntake.ts` — same kind of
     CPU/memory-bound, non-network work.
   - `.then(pageBuffer => pdfOcrPool(() => converters.ocrPage(pageBuffer)))`
     — OCRs that one page (see Concurrency below).
   - Each page's render+OCR is one promise in an indexed array; at most
     `docPool`'s concurrency limit worth of pages are rendered at once
     (default 4), so the full document's pages are never all held in
     memory simultaneously — only as many in flight as the pool allows,
     regardless of the 50-page cap.
4. **Inspect results correctly.** `ImageAnalyzer.ocr()` does not throw on
   failure — it returns `OcrResult` with `metadata.error` set and
   `text: ''`. Fallback logic must check `metadata.error` and
   empty/whitespace `text`. A **thrown** rejection from `ocrPage()` (e.g. a
   fake/injected implementation that throws instead of resolving with an
   error result) is caught and treated identically to a `metadata.error`
   result — both are "this page failed," not a whole-document abort (unlike
   a `renderPdfPage` failure — see Error handling).
5. **Reassemble in order, success counted before markers are inserted.**
   The indexed array of per-page promises is awaited via `Promise.all`.
   Each settled result is classified as *successful* (non-empty text, no
   error) or *failed* (per step 4). Count `successfulPages`. Build the
   joined string by page index — never by completion order — using page
   text for successes and `[OCR FAILED: page N]` for failures, with
   `\n\n--- page N ---\n\n` separators for multi-page docs (single-page
   docs omit the marker).
   **`successfulPages === 0` short-circuits to returning `''`, discarding
   the joined string entirely** — a string made entirely of
   `[OCR FAILED: page N]` markers is non-empty text but contains zero
   usable content, and must not be returned as if it were real extracted
   text. `convertFileToText`'s existing empty-text check then throws
   `"produced no extractable text"` exactly as it does for the plain
   `pdf-parse`-empty case.
6. **Partial-failure contract.** When `successfulPages >= 1`, the joined
   string (successes + `[OCR FAILED: page N]` markers) is returned as-is.
   The list of failed page numbers is logged to stderr (visibility) but not
   persisted anywhere — no new manifest field, per Non-goals.

### Concurrency

Add to `src/core/concurrency.ts`, following the existing pattern exactly:

```ts
export const pdfOcrPool = pLimit(configuredLimit('TRM_PDF_OCR_CONCURRENCY'));
```

Kept separate from `claudePool` (used in `ingestDir.ts` specifically
because that OCR call feeds a *subsequent* Claude extraction step — ours
doesn't chain anything) and `visionPool` (used for image-analysis
`extract()`, a different call shape/latency profile). Default concurrency
4, matching the shared `DEFAULT_CONCURRENCY`.

`ImageAnalyzer`'s class defaults are 5s timeout / 3 retries — those are
*not* what we want. `ingestDir.ts` explicitly constructs
`new ImageAnalyzer(cicIngestionUrl, 90000, 2)` because real Vision
`DOCUMENT_TEXT_DETECTION` latency has been observed at 60s+ under load; the
5s default starves every real call. The default `ocrPage` implementation
must construct its `ImageAnalyzer` the same explicit way —
`new ImageAnalyzer(cicIngestionUrl, 90000, 2)` — not rely on the class
defaults. No separate whole-document timeout; the page-count cap plus
per-page timeout bounds total worst-case time.

### Dependency injection

Extend the existing `FileConverters` interface (the same seam already used
for `extractDocx`/`extractPdf`/`extractEpub`) rather than constructing
`ImageAnalyzer` or the renderer invisibly inside `fileConvert.ts`.
`extractPdf` itself is unchanged; the two new members are consumed by
`convertFileToText`'s fallback orchestration (see Fallback path above), not
by `extractPdf`:

```ts
export interface FileConverters {
  extractDocx: (filePath: string) => Promise<string>;
  extractPdf: (buffer: Buffer) => Promise<string>;
  extractEpub: (filePath: string) => Promise<string>;
  getPdfPageCount?: (buffer: Buffer) => Promise<number>;
  renderPdfPage?: (buffer: Buffer, pageNumber: number) => Promise<Buffer>; // 1-indexed
  ocrPage?: (buffer: Buffer) => Promise<OcrResult>;
}
```

Defaults: `getPdfPageCount` via `pdfjs-dist`'s `getDocument(...).promise`
→ `.numPages` (no rendering); `renderPdfPage` via `pdf-to-png-converter`'s
`pagesToProcess: [pageNumber]` option (renders exactly one page); `ocrPage`
via `new ImageAnalyzer(cicIngestionUrl, 90000, 2).ocr(buffer)` as above.
Tests inject fakes for all three, same as the existing
injection pattern used for the other three converters.

## Error handling

- Size/page-limit exceeded: thrown immediately, before any rendering —
  distinct message (e.g. `PDF exceeds max pages (N > limit)` /
  `PDF exceeds max size`), surfaced same as any other `convertFileToText`
  error.
- `getPdfPageCount` failure (corrupt PDF, can't even open it): thrown as-is,
  same treatment as existing `pdf-parse` corruption errors.
- `renderPdfPage` failure for a given page: thrown as-is from
  `pdf-to-png-converter` — this aborts the whole document (unlike an OCR
  failure, a render failure means we have no image to even attempt OCR on,
  so it isn't treated as a per-page partial failure).
- Per-page OCR failure (`metadata.error` set, empty text, or `ocrPage()`
  throwing) is not treated as a whole-document error — becomes an inline
  `[OCR FAILED: page N]` marker (see Partial-failure contract above).
- All-pages-failed: `successfulPages === 0` forces the fallback to return
  `''`, discarding any `[OCR FAILED: page N]` markers — those markers are
  non-empty text but not usable content, so they must never be what
  `convertFileToText` sees as "success." The existing empty-text check then
  throws `"produced no extractable text"` — no new error type.

## Testing

Extends the existing `triageIntake.test.ts` / `fileConvert` test
conventions:

1. Text-layer PDF (pdf-parse non-empty) → fallback never invoked
   (`getPdfPageCount`/`renderPdfPage`/`ocrPage` spies not called) —
   regression guard, no added cost for existing PDFs.
2. Scanned PDF, all pages OCR successfully (mocked `getPdfPageCount` = 3,
   mocked `renderPdfPage`/`ocrPage` per call) → concatenated text with page
   markers, correct order.
3. Multi-page with `ocrPage` resolving out of start order (staggered mock
   delays) → output still reassembled by page index, not completion order.
4. `ocrPage` returns `OcrResult` with `metadata.error` set (not a thrown
   error) → treated as page failure, `[OCR FAILED: page N]` marker
   inserted, other pages unaffected.
5. `ocrPage` returns empty/whitespace `text` with no `metadata.error` →
   same treatment as case 4.
6. All pages fail (mix of `metadata.error` and empty-text results across
   all pages) → fallback returns `''`, NOT a string of
   `[OCR FAILED: page N]` markers — `convertFileToText` throws the existing
   `"produced no extractable text"` error. This is the regression case:
   asserts the all-failed result is not mistaken for non-empty success
   text.
6b. `ocrPage()` throws (rejects) for one page rather than resolving with
    `metadata.error` → treated identically to case 4/5 (page failure, not
    document abort); mix with successful pages elsewhere in the doc to
    confirm the thrown-rejection path is caught, not left unhandled.
7. `renderPdfPage` throws for one page (corrupt page) → error surfaces as-is,
   whole document aborts (per Error handling — a render failure isn't a
   per-page partial-failure case).
8. `getPdfPageCount` throws (can't open PDF) → error surfaces as-is, no
   rendering attempted.
9. Oversized PDF (byte size over `TRM_PDF_MAX_BYTES`) → throws immediately,
   `getPdfPageCount`/`renderPdfPage` never called.
10. Too many pages (`getPdfPageCount` returns value over
    `TRM_PDF_MAX_PAGES`) → throws immediately, `renderPdfPage` never
    called for any page — proves the count check runs before any render.
11. `docPool`/`pdfOcrPool` concurrency actually bounded: mock
    `renderPdfPage`/`ocrPage` to track max concurrent in-flight calls
    against `TRM_DOC_CONCURRENCY`/`TRM_PDF_OCR_CONCURRENCY` env vars set to
    a small number (e.g. 2) with more pages than that in flight — asserts
    the observed max never exceeds the configured limit.
12. Real-fixture test: a small checked-in scanned PDF (no text layer, 1-2
    pages) run through the *real* `getPdfPageCount` + `renderPdfPage`
    (`pdf-to-png-converter`), with only the network-facing
    `ocrPage`/`ImageAnalyzer` call mocked — validates the render boundary
    actually works, not just the mock contract.
13. Integration: `trm ingest --file <scanned.pdf>` end-to-end (real render,
    mocked Vision network call) produces non-empty extracted text.

## Out of scope / explicitly deferred

- Manifest schema changes / persisting per-page failure detail.
- `--ocr` CLI override flag.
- DOCX/EPUB OCR fallback.
- Mid-document cancellation.
