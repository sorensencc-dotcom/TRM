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

Triggered only when `pdf-parse` returns empty/whitespace text.

1. **Size/page guard.** Check `buffer.length` against `TRM_PDF_MAX_BYTES`
   (default 100MB) and, after a cheap page-count probe, page count against
   `TRM_PDF_MAX_PAGES` (default 50). Either limit exceeded → throw
   immediately, no rendering attempted. Prevents unbounded memory/API cost
   from a hostile or oversized scan.
2. **Render.** Use `pdf-to-png-converter` (wraps `pdfjs-dist` +
   `@napi-rs/canvas`; prebuilt binaries, no node-gyp/compiler step, Windows-
   safe, requires Node ≥20 — repo runs Node 24) to render each page to a PNG
   buffer at a fixed 150 DPI (bounds per-page image size). Wrapped in
   `docPool` — same pool already bounding `pdf-parse`/`mammoth`'s
   in-memory parses in `triageIntake.ts`, since page rendering is the same
   kind of CPU/memory-bound, non-network work.
3. **OCR each page.** Each rendered page buffer goes through
   `ImageAnalyzer.ocr()` (the existing Vision endpoint), wrapped in a new
   `pdfOcrPool` (see Concurrency below) — not `visionPool` or `claudePool`.
4. **Inspect results correctly.** `ImageAnalyzer.ocr()` does not throw on
   failure — it returns `OcrResult` with `metadata.error` set and
   `text: ''`. Fallback logic must check `metadata.error` and
   empty/whitespace `text`, not rely on try/catch.
5. **Reassemble in order.** Pages are OCR'd concurrently (bounded by
   `pdfOcrPool`) via an indexed `Promise.all`, then joined by original page
   index — never by completion order. Multi-page docs get
   `\n\n--- page N ---\n\n` separators between pages; single-page docs omit
   the marker (no reordering ambiguity to signal).
6. **Partial-failure contract.** A page that fails OCR (per step 4) gets an
   inline `[OCR FAILED: page N]` marker in its place; the document still
   succeeds if *any* page produced usable text. The list of failed page
   numbers is logged to stderr (visibility) but not persisted anywhere —
   no new manifest field, per Non-goals. If *all* pages fail, the result is
   effectively empty and falls through to the same existing
   `"produced no extractable text"` error `convertFileToText` already
   throws for empty extraction — no new error type, no new status value.

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

Per-page OCR timeout reuses `ImageAnalyzer`'s existing tuning (90s timeout,
2 retries — already tuned in `ingestDir.ts` for real Vision
`DOCUMENT_TEXT_DETECTION` latency, which has been observed taking 60s+
under load). No separate whole-document timeout; the page-count cap plus
per-page timeout bounds total worst-case time.

### Dependency injection

Extend the existing `FileConverters` interface (the same seam already used
for `extractDocx`/`extractPdf`/`extractEpub`) rather than constructing
`ImageAnalyzer` or the renderer invisibly inside `fileConvert.ts`:

```ts
export interface FileConverters {
  extractDocx: (filePath: string) => Promise<string>;
  extractPdf: (buffer: Buffer) => Promise<string>;
  extractEpub: (filePath: string) => Promise<string>;
  renderPdfPages?: (buffer: Buffer) => Promise<Buffer[]>; // ordered page PNGs
  ocrPage?: (buffer: Buffer) => Promise<OcrResult>;
}
```

Defaults wire to `pdf-to-png-converter` and a real `ImageAnalyzer`
respectively. Tests inject fakes for both, same as the existing
`jest.spyOn`-free injection pattern used for the other three converters.

Exact `pdf-to-png-converter` call signature (page iteration API, options
shape) gets nailed down at implementation time against the installed
version — the contract point fixed here is: given a PDF buffer and a page
cap, returns an ordered array of page PNG buffers.

## Error handling

- Size/page-limit exceeded: thrown immediately, before any rendering —
  distinct message (e.g. `PDF exceeds max pages (N > limit)` /
  `PDF exceeds max size`), surfaced same as any other `convertFileToText`
  error.
- Render failure (corrupt scanned PDF): thrown as-is from
  `pdf-to-png-converter`, same treatment as existing `pdf-parse` corruption
  errors.
- Per-page OCR failure: not thrown — becomes an inline
  `[OCR FAILED: page N]` marker (see Partial-failure contract above).
- All-pages-failed: falls through to the existing
  `"produced no extractable text"` error — no new error type.

## Testing

Extends the existing `triageIntake.test.ts` / `fileConvert` test
conventions:

1. Text-layer PDF (pdf-parse non-empty) → OCR/render path never invoked
   (`renderPdfPages`/`ocrPage` spies not called) — regression guard, no
   added cost for existing PDFs.
2. Scanned PDF, all pages OCR successfully (mocked `renderPdfPages` +
   `ocrPage`) → concatenated text with page markers, correct order.
3. Multi-page with results resolving out of start order (mock `ocrPage`
   with staggered delays) → output still reassembled by page index, not
   completion order.
4. `ocrPage` returns `OcrResult` with `metadata.error` set (not a thrown
   error) → treated as page failure, `[OCR FAILED: page N]` marker
   inserted, other pages unaffected.
5. `ocrPage` returns empty/whitespace `text` with no `metadata.error` →
   same treatment as case 4.
6. All pages fail → `convertFileToText` throws the existing
   `"produced no extractable text"` error.
7. `renderPdfPages` throws (corrupt PDF) → error surfaces as-is, no OCR
   attempted.
8. Oversized PDF (byte size over `TRM_PDF_MAX_BYTES`) → throws
   immediately, `renderPdfPages` never called.
9. Too many pages (over `TRM_PDF_MAX_PAGES`) → throws immediately,
   rendering never attempted (or aborted before OCR, depending on whether
   page count is knowable before full render — resolved at implementation
   time).
10. Real-fixture test: a small checked-in scanned PDF (no text layer, 1-2
    pages) run through the *real* `pdf-to-png-converter`, with only the
    network-facing `ocrPage`/`ImageAnalyzer` call mocked — validates the
    render boundary actually works, not just the mock contract.
11. Integration: `trm ingest --file <scanned.pdf>` end-to-end (real render,
    mocked Vision network call) produces non-empty extracted text.

## Out of scope / explicitly deferred

- Manifest schema changes / persisting per-page failure detail.
- `--ocr` CLI override flag.
- DOCX/EPUB OCR fallback.
- Mid-document cancellation.
