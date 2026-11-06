# Scanned-PDF OCR Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scanned PDFs (no text layer) that currently fail extraction with `"produced no extractable text"` get OCR'd automatically via the existing Vision OCR endpoint, transparently to `trm ingest --file` and `triage-intake`.

**Architecture:** `convertFileToText`'s PDF branch tries `pdf-parse` first (unchanged fast path). On empty text, it falls back: get page count (no render) → render each page to PNG one at a time → OCR each page via the existing `ImageAnalyzer.ocr()` → reassemble in page order, tolerating per-page OCR failures. Two new bounded concurrency pools cap memory/API cost; hard page-count/byte-size limits reject oversized input before any rendering starts.

**Tech Stack:** TypeScript (CommonJS), Jest, `pdfjs-dist` (page-count lookup AND page rendering, called directly) + `@napi-rs/canvas` (Node canvas implementation for pdfjs-dist rendering, prebuilt binaries, no native build step), `p-limit` (existing concurrency pattern), `pdf-lib` (dev-only, test fixture generation).

**Amendment (post-Task-4-blocker):** the original design routed rendering through `pdf-to-png-converter`. Task 4's real-fixture test discovered a genuine Windows bug in that package: its bundled `pdfjs-dist` requires `cMapUrl`/`standardFontDataUrl` as forward-slash URL strings, but the package's own `normalizePath()` helper appends the OS path separator (backslash on Windows) with no public option to override — verified against the installed package's source (`node_modules/pdf-to-png-converter/out/normalizePath.js`, `out/const.js`), not a config mistake or implementer error. Decision: drop `pdf-to-png-converter` entirely; render directly via `pdfjs-dist` + `@napi-rs/canvas`, setting `cMapUrl`/`standardFontDataUrl` ourselves with correct forward-slash paths. This changes `defaultRenderPdfPage`'s implementation (Task 2) and its dependency footprint but not its signature or any other task's contract.

## Global Constraints

- `TRM_PDF_MAX_BYTES` env var, default 100MB (104857600 bytes) — checked before any fallback rendering.
- `TRM_PDF_MAX_PAGES` env var, default 50 — checked via `getPdfPageCount` before any rendering.
- `TRM_PDF_OCR_CONCURRENCY` env var, default 4 — bounds concurrent Vision OCR calls during PDF fallback.
- `TRM_PDF_RENDER_CONCURRENCY` env var, default 4 — bounds concurrent page-render calls during PDF fallback, via a dedicated `pdfRenderPool`. Page rendering does **not** reuse `TRM_DOC_CONCURRENCY` / `docPool`: `triage-intake.ts` already wraps its whole `convertFileToText(...)` call in `docPool(...)`, and `p-limit` is not re-entrant -- acquiring `docPool` again inside the fallback for rendering deadlocks once all outer `docPool` slots are held by tasks each awaiting an inner `docPool` acquisition that can never be granted. `pdfRenderPool` is a separate pool specifically to avoid this (post-whole-branch-review fix, 2026-08-07/08).
- `ImageAnalyzer` for PDF-page OCR must be constructed as `new ImageAnalyzer(cicIngestionUrl, 90000, 2)` — the class defaults (5000ms timeout, 3 retries) are wrong for real Vision `DOCUMENT_TEXT_DETECTION` latency (observed 60s+ under load in `ingestDir.ts`).
- Render DPI fixed at 150 (`viewportScale: 150 / 72`, passed to `page.getViewport({ scale })` per **the amendment above** — no longer a `pdf-to-png-converter` option).
- `defaultRenderPdfPage` must set `cMapUrl`/`standardFontDataUrl` to absolute, forward-slash-normalized paths under the installed `pdfjs-dist` package (`cmaps/` and `standard_fonts/` respectively, both with a trailing `/`) — backslash paths (Windows default) make `pdfjs-dist` throw. Build the forward-slash form explicitly (e.g. `.split(path.sep).join('/')` on the resolved absolute path); do not rely on any library default.
- No manifest schema change. No new CLI flag. No DOCX/EPUB OCR fallback. No mid-document cancellation.
- Page markers: `\n\n--- page N ---\n\n` before pages 2+ in multi-page output; single-page output has no marker. Failed pages render as `[OCR FAILED: page N]` inline.
- All pages failing OCR must produce `''` from the fallback (not a string of failure markers), so `convertFileToText`'s existing empty-text check throws `"produced no extractable text"` — never a false success.

Spec: `docs/superpowers/specs/2026-08-07-pdf-ocr-fallback-design.md`

---

### Task 1: `pdfOcrPool` concurrency primitive

**Files:**
- Modify: `src/core/concurrency.ts`
- Test: `tests/core/concurrency.test.ts`

**Interfaces:**
- Produces: `pdfOcrPool: (fn: () => Promise<T>) => Promise<T>` (generic, `p-limit` instance), exported from `src/core/concurrency.ts`, configured via `TRM_PDF_OCR_CONCURRENCY` env var, default concurrency 4.

- [ ] **Step 1: Write the failing tests**

Add to `tests/core/concurrency.test.ts`, following the exact existing `docPool` test pattern (same file, same `ENV_KEYS`/`trackConcurrency` helpers already present):

```ts
// Add 'TRM_PDF_OCR_CONCURRENCY' to the ENV_KEYS array at the top of the file:
// const ENV_KEYS = ['TRM_VISION_CONCURRENCY', 'TRM_CLAUDE_CONCURRENCY', 'TRM_DOC_CONCURRENCY', 'TRM_PDF_OCR_CONCURRENCY'];

  it('pdfOcrPool defaults to a concurrency of 4 when no env var is set', async () => {
    delete process.env.TRM_PDF_OCR_CONCURRENCY;
    const { pdfOcrPool } = require('../../src/core/concurrency');

    const maxActive = await trackConcurrency(pdfOcrPool, 10);
    expect(maxActive).toBe(4);
  });

  it('bounds concurrent execution to the configured TRM_PDF_OCR_CONCURRENCY limit', async () => {
    process.env.TRM_PDF_OCR_CONCURRENCY = '2';
    const { pdfOcrPool } = require('../../src/core/concurrency');

    const maxActive = await trackConcurrency(pdfOcrPool, 10);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBeGreaterThan(0);
  });

  it('pdfOcrPool is independent of docPool', async () => {
    process.env.TRM_DOC_CONCURRENCY = '1';
    process.env.TRM_PDF_OCR_CONCURRENCY = '5';
    const { docPool, pdfOcrPool } = require('../../src/core/concurrency');

    const [docMax, pdfOcrMax] = await Promise.all([
      trackConcurrency(docPool, 8),
      trackConcurrency(pdfOcrPool, 8),
    ]);

    expect(docMax).toBe(1);
    expect(pdfOcrMax).toBe(5);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/core/concurrency.test.ts -t pdfOcrPool`
Expected: FAIL — `pdfOcrPool` is not exported from `../../src/core/concurrency`.

- [ ] **Step 3: Implement**

In `src/core/concurrency.ts`, add one line after the existing `docPool` export:

```ts
export const pdfOcrPool = pLimit(configuredLimit('TRM_PDF_OCR_CONCURRENCY'));
```

Full resulting file:

```ts
import pLimit from 'p-limit';

const DEFAULT_CONCURRENCY = 4;

function configuredLimit(name: string): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_CONCURRENCY;
}

export const visionPool = pLimit(configuredLimit('TRM_VISION_CONCURRENCY'));
export const claudePool = pLimit(configuredLimit('TRM_CLAUDE_CONCURRENCY'));
export const docPool = pLimit(configuredLimit('TRM_DOC_CONCURRENCY'));
export const pdfOcrPool = pLimit(configuredLimit('TRM_PDF_OCR_CONCURRENCY'));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/core/concurrency.test.ts`
Expected: PASS, all tests including the 3 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/core/concurrency.ts tests/core/concurrency.test.ts
git commit -m "feat(concurrency): add pdfOcrPool for PDF-page OCR calls"
```

---

### Task 2: Install PDF-rendering dependencies, add `FileConverters` seam + default implementations

**Files:**
- Modify: `package.json` (add `pdfjs-dist`, `@napi-rs/canvas` dependencies; `pdf-lib` devDependency)
- Modify: `src/ingestion/fileConvert.ts` (extend `FileConverters` interface, add 3 default implementations — NOT wired into `convertFileToText` yet, that's Task 3)
- Test: `tests/ingestion/fileConvert.defaults.test.ts` (new file)

**Interfaces:**
- Consumes: `ImageAnalyzer`, `OcrResult` from `../ingestion/imageExtract/imageAnalyzer` (existing, unchanged).
- Produces (new exports from `src/ingestion/fileConvert.ts`, used by Task 3):
  - `defaultGetPdfPageCount(buffer: Buffer): Promise<number>`
  - `defaultRenderPdfPage(buffer: Buffer, pageNumber: number): Promise<Buffer>`
  - `defaultOcrPage(buffer: Buffer): Promise<OcrResult>`
  - Extended `FileConverters` interface with 3 new optional fields: `getPdfPageCount?`, `renderPdfPage?`, `ocrPage?` (same signatures as the 3 functions above).

**Note (amended after Task 4's Windows blocker — see Amendment at top of plan):** rendering is done directly via `pdfjs-dist` + `@napi-rs/canvas`, NOT `pdf-to-png-converter` (dropped: verified Windows-incompatible, its own `normalizePath()` produces backslash `cMapUrl`/`standardFontDataUrl` paths with no override hook). `pdfjs-dist` is used for both the page-count lookup and rendering; `@napi-rs/canvas` supplies the `CanvasRenderingContext2D` pdfjs-dist's `page.render()` needs in Node, via prebuilt binaries (no native compiler step, same reason it was chosen originally).

- [ ] **Step 1: Install dependencies**

```bash
npm install pdfjs-dist@^3.11.174 @napi-rs/canvas@^0.1.80
npm install --save-dev pdf-lib@^1.17.1
```

Verify: `grep -A1 '"pdfjs-dist"\|"@napi-rs/canvas"\|"pdf-lib"' package.json` shows all three. Run this from your current working directory as-is — do not `cd` elsewhere first.

- [ ] **Step 2: Write the failing tests**

Create `tests/ingestion/fileConvert.defaults.test.ts`:

```ts
import { defaultGetPdfPageCount, defaultRenderPdfPage, defaultOcrPage } from '../../src/ingestion/fileConvert';

const mockDocDestroy = jest.fn().mockResolvedValue(undefined);
const mockGetDocument = jest.fn();

jest.mock('pdfjs-dist/legacy/build/pdf.js', () => ({
  getDocument: (...args: unknown[]) => mockGetDocument(...args),
}));

const mockToBuffer = jest.fn();
const mockGetContext = jest.fn();
const mockCreateCanvas = jest.fn();

jest.mock('@napi-rs/canvas', () => ({
  createCanvas: (...args: unknown[]) => mockCreateCanvas(...args),
}));

const mockOcr = jest.fn();

jest.mock('../../src/ingestion/imageExtract/imageAnalyzer', () => ({
  ImageAnalyzer: jest.fn().mockImplementation(() => ({ ocr: mockOcr })),
}));

describe('defaultGetPdfPageCount', () => {
  beforeEach(() => {
    mockGetDocument.mockReset();
    mockDocDestroy.mockClear();
  });

  it('returns numPages from pdfjs-dist and destroys the document', async () => {
    mockGetDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 3, destroy: mockDocDestroy }),
    });

    const count = await defaultGetPdfPageCount(Buffer.from('fake pdf bytes'));

    expect(count).toBe(3);
    expect(mockDocDestroy).toHaveBeenCalledTimes(1);
  });
});

describe('defaultRenderPdfPage', () => {
  beforeEach(() => {
    mockGetDocument.mockReset();
    mockDocDestroy.mockClear();
    mockToBuffer.mockReset();
    mockGetContext.mockReset();
    mockCreateCanvas.mockReset();
  });

  it('renders exactly the requested page at 150 DPI and returns its PNG buffer', async () => {
    const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    mockToBuffer.mockReturnValue(pngBuffer);
    mockGetContext.mockReturnValue({});
    mockCreateCanvas.mockReturnValue({ getContext: mockGetContext, toBuffer: mockToBuffer });

    const mockRender = jest.fn().mockReturnValue({ promise: Promise.resolve(undefined) });
    const mockGetViewport = jest.fn().mockReturnValue({ width: 620, height: 877 });
    const mockGetPage = jest.fn().mockResolvedValue({ getViewport: mockGetViewport, render: mockRender });
    mockGetDocument.mockReturnValue({
      promise: Promise.resolve({ getPage: mockGetPage, destroy: mockDocDestroy }),
    });

    const result = await defaultRenderPdfPage(Buffer.from('fake pdf bytes'), 2);

    expect(result).toBe(pngBuffer);
    expect(mockGetPage).toHaveBeenCalledWith(2);
    expect(mockGetViewport).toHaveBeenCalledWith(expect.objectContaining({ scale: 150 / 72 }));
    expect(mockCreateCanvas).toHaveBeenCalledWith(620, 877);
    expect(mockToBuffer).toHaveBeenCalledWith('image/png');
    // Locks in the canvasFactory wiring (the fix for pdfjs-dist's internal
    // image-compositing path otherwise requiring native `canvas`) -- a
    // regression here would silently reintroduce the native-canvas crash
    // on any PDF page containing an embedded raster image.
    const getDocumentCallArgs = mockGetDocument.mock.calls[0][0];
    expect(getDocumentCallArgs.canvasFactory).toEqual(
      expect.objectContaining({
        create: expect.any(Function),
        reset: expect.any(Function),
        destroy: expect.any(Function),
      })
    );
    expect(mockDocDestroy).toHaveBeenCalledTimes(1);
  });

  it('throws when pdfjs-dist reports the requested page does not exist', async () => {
    const mockGetPage = jest.fn().mockRejectedValue(new Error('Invalid page request'));
    mockGetDocument.mockReturnValue({
      promise: Promise.resolve({ getPage: mockGetPage, destroy: mockDocDestroy }),
    });

    await expect(defaultRenderPdfPage(Buffer.from('fake pdf bytes'), 5)).rejects.toThrow(/Invalid page request/);
    expect(mockDocDestroy).toHaveBeenCalledTimes(1);
  });
});

describe('defaultOcrPage', () => {
  beforeEach(() => {
    mockOcr.mockReset();
  });

  it('constructs ImageAnalyzer with 90s timeout and 2 retries, delegates to .ocr()', async () => {
    const { ImageAnalyzer } = require('../../src/ingestion/imageExtract/imageAnalyzer');
    const ocrResult = { text: 'page text', metadata: { format: 'png', size: 4, processedAt: 'x', latencyMs: 1 } };
    mockOcr.mockResolvedValue(ocrResult);

    const result = await defaultOcrPage(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    expect(result).toBe(ocrResult);
    expect(ImageAnalyzer).toHaveBeenCalledWith(expect.any(String), 90000, 2);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx jest tests/ingestion/fileConvert.defaults.test.ts`
Expected: FAIL — `defaultGetPdfPageCount`, `defaultRenderPdfPage`, `defaultOcrPage` are not exported from `../../src/ingestion/fileConvert`.

- [ ] **Step 4: Implement**

Add these imports and functions to `src/ingestion/fileConvert.ts` (do not remove anything yet — this step only adds the new interface fields, functions, and exports; `convertFileToText`'s PDF branch is untouched until Task 3):

```ts
import * as path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.js';
import { createCanvas } from '@napi-rs/canvas';
import { ImageAnalyzer, OcrResult } from './imageExtract/imageAnalyzer';
```

(`node:path` may already be imported at the top of this file for other purposes — if so, don't duplicate the import, just reuse it.)

Extend the interface:

```ts
export interface FileConverters {
  extractDocx: (filePath: string) => Promise<string>;
  extractPdf: (buffer: Buffer) => Promise<string>;
  extractEpub: (filePath: string) => Promise<string>;
  // Scanned-PDF OCR fallback (all optional -- unset means "use the real
  // default," so a test that overrides only extractPdf and forgets these
  // will silently hit real pdfjs-dist/canvas/Vision calls if its extractPdf
  // ever resolves empty. Tests exercising the fallback path must always
  // override all three.
  getPdfPageCount?: (buffer: Buffer) => Promise<number>;
  renderPdfPage?: (buffer: Buffer, pageNumber: number) => Promise<Buffer>;
  ocrPage?: (buffer: Buffer) => Promise<OcrResult>;
}
```

Add a helper for the forward-slash-normalized pdfjs-dist asset paths, and the three default implementations (place above `const defaultConverters`):

```ts
// pdfjs-dist requires cMapUrl/standardFontDataUrl as forward-slash URL
// strings with a trailing slash. path.resolve()/path.join() produce
// backslash paths on Windows, which pdfjs-dist rejects outright -- this
// normalizes explicitly rather than relying on any library default.
function pdfjsAssetUrl(...segments: string[]): string {
  const absolute = path.resolve(path.dirname(require.resolve('pdfjs-dist/package.json')), ...segments);
  return absolute.split(path.sep).join('/') + '/';
}

const PDFJS_CMAP_URL = pdfjsAssetUrl('cmaps');
const PDFJS_STANDARD_FONT_DATA_URL = pdfjsAssetUrl('standard_fonts');

// pdfjs-dist's internal image-compositing path (used whenever a page embeds
// a raster image -- the exact case for every scanned PDF this fallback
// exists for) creates its OWN auxiliary canvases via a CanvasFactory, and
// its built-in NodeCanvasFactory unconditionally `require('canvas')` (the
// native package) regardless of what canvasContext we pass to
// page.render(). Passing this factory into getDocument() makes pdfjs-dist
// use @napi-rs/canvas for those internal canvases too, avoiding a hard
// dependency on the native `canvas` package (which needs a C++ build
// toolchain). Interface shape (create/reset/destroy) is pdfjs-dist's
// documented CanvasFactory contract, duck-typed -- pdfjs-dist does not
// export a base class to extend in the legacy CJS build.
class NapiCanvasFactory {
  create(width: number, height: number) {
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext('2d') };
  }
  reset(canvasAndContext: { canvas: ReturnType<typeof createCanvas> }, width: number, height: number) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }
  destroy(canvasAndContext: { canvas: ReturnType<typeof createCanvas> | null; context: unknown }) {
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

export async function defaultGetPdfPageCount(buffer: Buffer): Promise<number> {
  const loadingTask = getDocument({ data: new Uint8Array(buffer) });
  const doc = await loadingTask.promise;
  const numPages = doc.numPages;
  await doc.destroy();
  return numPages;
}

export async function defaultRenderPdfPage(buffer: Buffer, pageNumber: number): Promise<Buffer> {
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    cMapUrl: PDFJS_CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: PDFJS_STANDARD_FONT_DATA_URL,
    canvasFactory: new NapiCanvasFactory() as any,
  });
  const doc = await loadingTask.promise;
  try {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 150 / 72 }); // 150 DPI (PDF points are 1/72 inch)
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext('2d');
    await page.render({ canvasContext: context as any, viewport }).promise;
    return canvas.toBuffer('image/png');
  } finally {
    await doc.destroy();
  }
}

export async function defaultOcrPage(buffer: Buffer): Promise<OcrResult> {
  const cicIngestionUrl = process.env.CIC_INGESTION_URL || 'http://localhost:3000';
  const analyzer = new ImageAnalyzer(cicIngestionUrl, 90000, 2);
  return analyzer.ocr(buffer);
}
```

Wire the 3 new fields into `defaultConverters` (add after the existing `extractEpub` line):

```ts
const defaultConverters: FileConverters = {
  extractDocx: async (filePath) => (await mammoth.extractRawText({ path: filePath })).value,
  extractPdf: async (buffer) => {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      await parser.destroy();
    }
  },
  extractEpub: async (filePath) => extractEpub(filePath),
  getPdfPageCount: defaultGetPdfPageCount,
  renderPdfPage: defaultRenderPdfPage,
  ocrPage: defaultOcrPage,
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest tests/ingestion/fileConvert.defaults.test.ts tests/ingestion/fileConvert.test.ts`
Expected: PASS — new tests pass, and the pre-existing `fileConvert.test.ts` suite is unaffected (nothing in `convertFileToText`'s control flow changed yet).

**If ts-jest reports missing type declarations for `pdfjs-dist/legacy/build/pdf.js`** (pdfjs-dist's bundled `.d.ts` coverage for the legacy subpath varies by version): create `src/types/pdfjs-dist-legacy.d.ts`:

```ts
declare module 'pdfjs-dist/legacy/build/pdf.js' {
  export function getDocument(src: {
    data: Uint8Array;
    cMapUrl?: string;
    cMapPacked?: boolean;
    standardFontDataUrl?: string;
    canvasFactory?: unknown;
  }): {
    promise: Promise<{
      numPages: number;
      getPage(pageNumber: number): Promise<{
        getViewport(params: { scale: number }): { width: number; height: number };
        render(params: { canvasContext: any; viewport: any }): { promise: Promise<void> };
      }>;
      destroy: () => Promise<void>;
    }>;
  };
}
```

Add `"typeRoots"` is not needed — a top-level `.d.ts` under `src/` matching `include: ["src"]` in `tsconfig.json` is picked up automatically. Re-run the test command; this only matters if the error actually occurs.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/ingestion/fileConvert.ts tests/ingestion/fileConvert.defaults.test.ts
git commit -m "feat(fileConvert): add PDF page-count/render/OCR default implementations"
```

---

### Task 3: Fallback orchestration in `convertFileToText`

**Files:**
- Modify: `src/ingestion/fileConvert.ts`
- Test: `tests/ingestion/fileConvert.pdfOcrFallback.test.ts` (new file)

**Interfaces:**
- Consumes: `pdfRenderPool`, `pdfOcrPool` from `../core/concurrency` (Task 1); `FileConverters`, `defaultGetPdfPageCount`, `defaultRenderPdfPage`, `defaultOcrPage` from this file (Task 2); `OcrResult` type from `./imageExtract/imageAnalyzer`. (Amended post-whole-branch-review: page rendering uses a dedicated `pdfRenderPool`, not `docPool` -- see Global Constraints.)
- Produces: `convertFileToText`'s existing exported signature is unchanged (`(filePath: string, converters?: FileConverters) => Promise<string>`) — this task only changes what happens internally for `.pdf` files.

- [ ] **Step 1: Write the failing tests**

Create `tests/ingestion/fileConvert.pdfOcrFallback.test.ts`:

```ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { convertFileToText, FileConverters } from '../../src/ingestion/fileConvert';
import type { OcrResult } from '../../src/ingestion/imageExtract/imageAnalyzer';

function makeFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-fileconvert-ocr-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

function okResult(text: string): OcrResult {
  return { text, metadata: { format: 'png', size: 4, processedAt: 'x', latencyMs: 1 } };
}

function errResult(error: string): OcrResult {
  return { text: '', metadata: { format: 'png', size: 4, processedAt: 'x', latencyMs: 1, error } };
}

describe('convertFileToText: scanned-PDF OCR fallback', () => {
  const scannedFile = () => makeFile('scanned.pdf', 'ignored binary placeholder');

  it('does not invoke the fallback when extractPdf returns non-empty text', async () => {
    const getPdfPageCount = jest.fn();
    const renderPdfPage = jest.fn();
    const ocrPage = jest.fn();
    const converters: FileConverters = {
      extractDocx: async () => '',
      extractPdf: async () => 'real text-layer text',
      extractEpub: async () => '',
      getPdfPageCount,
      renderPdfPage,
      ocrPage,
    };

    const text = await convertFileToText(scannedFile(), converters);

    expect(text).toBe('real text-layer text');
    expect(getPdfPageCount).not.toHaveBeenCalled();
    expect(renderPdfPage).not.toHaveBeenCalled();
    expect(ocrPage).not.toHaveBeenCalled();
  });

  it('OCRs every page and joins with page markers in order', async () => {
    const converters: FileConverters = {
      extractDocx: async () => '',
      extractPdf: async () => '',
      extractEpub: async () => '',
      getPdfPageCount: async () => 3,
      renderPdfPage: async (_buf, pageNumber) => Buffer.from(`page-${pageNumber}-png`),
      ocrPage: async (buf) => okResult(`text from ${buf.toString()}`),
    };

    const text = await convertFileToText(scannedFile(), converters);

    expect(text).toBe(
      'text from page-1-png\n\n--- page 2 ---\n\ntext from page-2-png\n\n--- page 3 ---\n\ntext from page-3-png'
    );
  });

  it('single-page scanned PDF has no page marker', async () => {
    const converters: FileConverters = {
      extractDocx: async () => '',
      extractPdf: async () => '',
      extractEpub: async () => '',
      getPdfPageCount: async () => 1,
      renderPdfPage: async () => Buffer.from('page-1-png'),
      ocrPage: async () => okResult('solo page text'),
    };

    const text = await convertFileToText(scannedFile(), converters);

    expect(text).toBe('solo page text');
  });

  it('reassembles by page index even when OCR calls resolve out of order', async () => {
    const delays: Record<number, number> = { 1: 30, 2: 10, 3: 20 };
    const converters: FileConverters = {
      extractDocx: async () => '',
      extractPdf: async () => '',
      extractEpub: async () => '',
      getPdfPageCount: async () => 3,
      renderPdfPage: async (_buf, pageNumber) => Buffer.from(`p${pageNumber}`),
      ocrPage: async (buf) => {
        const pageNumber = Number(buf.toString().replace('p', ''));
        await new Promise((r) => setTimeout(r, delays[pageNumber]));
        return okResult(`out-of-order-${pageNumber}`);
      },
    };

    const text = await convertFileToText(scannedFile(), converters);

    expect(text).toBe(
      'out-of-order-1\n\n--- page 2 ---\n\nout-of-order-2\n\n--- page 3 ---\n\nout-of-order-3'
    );
  });

  it('a page with metadata.error becomes an inline failure marker, other pages unaffected', async () => {
    const converters: FileConverters = {
      extractDocx: async () => '',
      extractPdf: async () => '',
      extractEpub: async () => '',
      getPdfPageCount: async () => 2,
      renderPdfPage: async (_buf, pageNumber) => Buffer.from(`p${pageNumber}`),
      ocrPage: async (buf) =>
        buf.toString() === 'p1' ? errResult('Vision timeout') : okResult('page 2 ok'),
    };

    const text = await convertFileToText(scannedFile(), converters);

    expect(text).toBe('[OCR FAILED: page 1]\n\n--- page 2 ---\n\npage 2 ok');
  });

  it('a page with empty/whitespace text (no metadata.error) is also treated as failed', async () => {
    const converters: FileConverters = {
      extractDocx: async () => '',
      extractPdf: async () => '',
      extractEpub: async () => '',
      getPdfPageCount: async () => 2,
      renderPdfPage: async (_buf, pageNumber) => Buffer.from(`p${pageNumber}`),
      ocrPage: async (buf) => (buf.toString() === 'p1' ? okResult('   ') : okResult('page 2 ok')),
    };

    const text = await convertFileToText(scannedFile(), converters);

    expect(text).toBe('[OCR FAILED: page 1]\n\n--- page 2 ---\n\npage 2 ok');
  });

  it('a thrown ocrPage() rejection is treated the same as metadata.error, not a document abort', async () => {
    const converters: FileConverters = {
      extractDocx: async () => '',
      extractPdf: async () => '',
      extractEpub: async () => '',
      getPdfPageCount: async () => 2,
      renderPdfPage: async (_buf, pageNumber) => Buffer.from(`p${pageNumber}`),
      ocrPage: async (buf) => {
        if (buf.toString() === 'p1') throw new Error('network blew up');
        return okResult('page 2 ok');
      },
    };

    const text = await convertFileToText(scannedFile(), converters);

    expect(text).toBe('[OCR FAILED: page 1]\n\n--- page 2 ---\n\npage 2 ok');
  });

  it('all pages failing produces the existing "no extractable text" error, not a string of markers', async () => {
    const converters: FileConverters = {
      extractDocx: async () => '',
      extractPdf: async () => '',
      extractEpub: async () => '',
      getPdfPageCount: async () => 2,
      renderPdfPage: async (_buf, pageNumber) => Buffer.from(`p${pageNumber}`),
      ocrPage: async () => errResult('Vision down'),
    };

    await expect(convertFileToText(scannedFile(), converters)).rejects.toThrow(/no extractable text/);
  });

  it('renderPdfPage throwing for one page aborts the whole document (not a partial failure)', async () => {
    const converters: FileConverters = {
      extractDocx: async () => '',
      extractPdf: async () => '',
      extractEpub: async () => '',
      getPdfPageCount: async () => 2,
      renderPdfPage: async (_buf, pageNumber) => {
        if (pageNumber === 2) throw new Error('corrupt page 2');
        return Buffer.from('p1');
      },
      ocrPage: async () => okResult('should not matter'),
    };

    await expect(convertFileToText(scannedFile(), converters)).rejects.toThrow('corrupt page 2');
  });

  it('getPdfPageCount throwing surfaces as-is, no rendering attempted', async () => {
    const renderPdfPage = jest.fn();
    const converters: FileConverters = {
      extractDocx: async () => '',
      extractPdf: async () => '',
      extractEpub: async () => '',
      getPdfPageCount: async () => {
        throw new Error('cannot open PDF');
      },
      renderPdfPage,
      ocrPage: async () => okResult('x'),
    };

    await expect(convertFileToText(scannedFile(), converters)).rejects.toThrow('cannot open PDF');
    expect(renderPdfPage).not.toHaveBeenCalled();
  });

  it('oversized PDF throws immediately, page count/render never called', async () => {
    const getPdfPageCount = jest.fn();
    const renderPdfPage = jest.fn();
    const previous = process.env.TRM_PDF_MAX_BYTES;
    process.env.TRM_PDF_MAX_BYTES = '10';
    try {
      const converters: FileConverters = {
        extractDocx: async () => '',
        extractPdf: async () => '',
        extractEpub: async () => '',
        getPdfPageCount,
        renderPdfPage,
        ocrPage: async () => okResult('x'),
      };

      await expect(convertFileToText(scannedFile(), converters)).rejects.toThrow(/exceeds max size/);
      expect(getPdfPageCount).not.toHaveBeenCalled();
      expect(renderPdfPage).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.TRM_PDF_MAX_BYTES;
      else process.env.TRM_PDF_MAX_BYTES = previous;
    }
  });

  it('too many pages throws immediately, renderPdfPage never called for any page', async () => {
    const renderPdfPage = jest.fn();
    const previous = process.env.TRM_PDF_MAX_PAGES;
    process.env.TRM_PDF_MAX_PAGES = '2';
    try {
      const converters: FileConverters = {
        extractDocx: async () => '',
        extractPdf: async () => '',
        extractEpub: async () => '',
        getPdfPageCount: async () => 3,
        renderPdfPage,
        ocrPage: async () => okResult('x'),
      };

      await expect(convertFileToText(scannedFile(), converters)).rejects.toThrow(/exceeds max pages/);
      expect(renderPdfPage).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.TRM_PDF_MAX_PAGES;
      else process.env.TRM_PDF_MAX_PAGES = previous;
    }
  });

  it('render and OCR concurrency stay within configured pool limits', async () => {
    const previousDoc = process.env.TRM_DOC_CONCURRENCY;
    const previousOcr = process.env.TRM_PDF_OCR_CONCURRENCY;
    process.env.TRM_DOC_CONCURRENCY = '2';
    process.env.TRM_PDF_OCR_CONCURRENCY = '2';
    jest.resetModules();
    try {
      const { convertFileToText: freshConvert } = require('../../src/ingestion/fileConvert');

      let activeRenders = 0;
      let maxActiveRenders = 0;
      let activeOcr = 0;
      let maxActiveOcr = 0;

      const converters: FileConverters = {
        extractDocx: async () => '',
        extractPdf: async () => '',
        extractEpub: async () => '',
        getPdfPageCount: async () => 8,
        renderPdfPage: async (_buf, pageNumber) => {
          activeRenders++;
          maxActiveRenders = Math.max(maxActiveRenders, activeRenders);
          await new Promise((r) => setTimeout(r, 15));
          activeRenders--;
          return Buffer.from(`p${pageNumber}`);
        },
        ocrPage: async () => {
          activeOcr++;
          maxActiveOcr = Math.max(maxActiveOcr, activeOcr);
          await new Promise((r) => setTimeout(r, 15));
          activeOcr--;
          return okResult('ok');
        },
      };

      await freshConvert(scannedFile(), converters);

      expect(maxActiveRenders).toBeLessThanOrEqual(2);
      expect(maxActiveOcr).toBeLessThanOrEqual(2);
    } finally {
      if (previousDoc === undefined) delete process.env.TRM_DOC_CONCURRENCY;
      else process.env.TRM_DOC_CONCURRENCY = previousDoc;
      if (previousOcr === undefined) delete process.env.TRM_PDF_OCR_CONCURRENCY;
      else process.env.TRM_PDF_OCR_CONCURRENCY = previousOcr;
      jest.resetModules();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/ingestion/fileConvert.pdfOcrFallback.test.ts`
Expected: FAIL — all cases fail because `convertFileToText` still just returns `extractPdf`'s empty result and throws the generic empty-text error immediately, without ever calling `getPdfPageCount`/`renderPdfPage`/`ocrPage`.

- [ ] **Step 3: Implement**

Add this function to `src/ingestion/fileConvert.ts` (place it after the default-implementation functions from Task 2, before `defaultConverters`):

```ts
function pdfMaxBytes(): number {
  const value = Number.parseInt(process.env.TRM_PDF_MAX_BYTES ?? '', 10);
  return Number.isInteger(value) && value > 0 ? value : 100 * 1024 * 1024;
}

function pdfMaxPages(): number {
  const value = Number.parseInt(process.env.TRM_PDF_MAX_PAGES ?? '', 10);
  return Number.isInteger(value) && value > 0 ? value : 50;
}

async function extractPdfWithOcrFallback(buffer: Buffer, converters: FileConverters): Promise<string> {
  const pdfParseText = await converters.extractPdf(buffer);
  if (pdfParseText.trim().length > 0) {
    return pdfParseText;
  }

  // extractPdf yielded empty text (e.g. scanned PDF, no text layer) -- fall
  // back to render-and-OCR. Any of these three overrides being unset falls
  // through to the real default (real pdfjs-dist/@napi-rs/canvas/Vision
  // call) -- tests exercising this path must always override all three.
  const getPdfPageCount = converters.getPdfPageCount ?? defaultGetPdfPageCount;
  const renderPdfPage = converters.renderPdfPage ?? defaultRenderPdfPage;
  const ocrPage = converters.ocrPage ?? defaultOcrPage;

  const maxBytes = pdfMaxBytes();
  if (buffer.length > maxBytes) {
    throw new Error(
      `trm ingest --file: PDF exceeds max size (${buffer.length} bytes > ${maxBytes} byte limit; set TRM_PDF_MAX_BYTES to override)`
    );
  }

  const pageCount = await getPdfPageCount(buffer);
  const maxPages = pdfMaxPages();
  if (pageCount > maxPages) {
    throw new Error(
      `trm ingest --file: PDF exceeds max pages (${pageCount} > ${maxPages} page limit; set TRM_PDF_MAX_PAGES to override)`
    );
  }

  const pageNumbers = Array.from({ length: pageCount }, (_, i) => i + 1);
  const pageResults = await Promise.all(
    pageNumbers.map((pageNumber) =>
      pdfRenderPool(() => renderPdfPage(buffer, pageNumber))
        .then((pageBuffer) => pdfOcrPool(() => ocrPage(pageBuffer)))
        .then((ocrResult) => ({
          pageNumber,
          text: ocrResult.metadata.error || ocrResult.text.trim().length === 0 ? null : ocrResult.text,
        }))
        .catch(() => ({ pageNumber, text: null as string | null }))
    )
  );

  const successfulPages = pageResults.filter((r) => r.text !== null).length;
  if (successfulPages === 0) {
    return '';
  }

  const failedPages = pageResults.filter((r) => r.text === null).map((r) => r.pageNumber);
  if (failedPages.length > 0) {
    console.error(`[fileConvert] OCR failed for pages: ${failedPages.join(', ')}`);
  }

  return pageResults
    .map((r, idx) => {
      const content = r.text !== null ? r.text : `[OCR FAILED: page ${r.pageNumber}]`;
      return idx === 0 ? content : `\n\n--- page ${r.pageNumber} ---\n\n${content}`;
    })
    .join('');
}
```

Change the `.pdf` branch inside `convertFileToText` from:

```ts
  } else if (ext === '.pdf') {
    text = await converters.extractPdf(fs.readFileSync(filePath));
```

to:

```ts
  } else if (ext === '.pdf') {
    text = await extractPdfWithOcrFallback(fs.readFileSync(filePath), converters);
```

Add the two new imports at the top of the file (alongside the Task 2 imports):

```ts
import { pdfRenderPool, pdfOcrPool } from '../core/concurrency';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/ingestion/fileConvert.pdfOcrFallback.test.ts tests/ingestion/fileConvert.test.ts tests/ingestion/fileConvert.defaults.test.ts`
Expected: PASS — all new fallback tests pass, and both pre-existing suites (`fileConvert.test.ts`, `fileConvert.defaults.test.ts`) remain green (the `.pdf` fast path and the standalone default-function tests are unaffected by this orchestration change).

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/fileConvert.ts tests/ingestion/fileConvert.pdfOcrFallback.test.ts
git commit -m "feat(fileConvert): scanned-PDF OCR fallback with page-order reassembly and partial-failure handling"
```

---

### Task 4: Real fixture-based render test

**Files:**
- Create: `scripts/generate-scanned-pdf-fixture.ts` (one-time generator, not part of the build/CLI)
- Create: `tests/fixtures/scanned-sample.pdf` (checked-in binary fixture, output of the generator)
- Test: `tests/ingestion/fileConvert.pdfOcrFallback.fixture.test.ts` (new file)

**Interfaces:**
- Consumes: `defaultGetPdfPageCount`, `defaultRenderPdfPage` (Task 2, real implementations — this test does NOT mock `pdfjs-dist`/`@napi-rs/canvas`); `convertFileToText`, `FileConverters` (existing).
- Produces: nothing consumed by later tasks — this is a leaf validation task.

- [ ] **Step 1: Write the fixture generator**

Create `scripts/generate-scanned-pdf-fixture.ts`:

```ts
// One-time generator for tests/fixtures/scanned-sample.pdf.
// Run manually: npx ts-node scripts/generate-scanned-pdf-fixture.ts
// Produces a 2-page PDF with a rasterized PNG on each page and NO text
// layer -- exercises the real render boundary the same way an actual
// scanned document would.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PDFDocument } from 'pdf-lib';

// 4x4 red PNG, smallest valid raster that still round-trips through
// pdfjs-dist/@napi-rs/canvas rendering.
const RED_SQUARE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEUlEQVR42mNk+M9QDwABKAECBnFa3AAAAABJRU5ErkJggg==';

async function main() {
  const pdfDoc = await PDFDocument.create();
  const pngBytes = Buffer.from(RED_SQUARE_PNG_BASE64, 'base64');
  const pngImage = await pdfDoc.embedPng(pngBytes);

  for (let i = 0; i < 2; i++) {
    const page = pdfDoc.addPage([200, 200]);
    page.drawImage(pngImage, { x: 50, y: 50, width: 100, height: 100 });
    // Deliberately no page.drawText() call anywhere -- this PDF has image
    // content only, matching a scanned document with no text layer.
  }

  const pdfBytes = await pdfDoc.save();
  const outPath = path.join(__dirname, '..', 'tests', 'fixtures', 'scanned-sample.pdf');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, pdfBytes);
  console.log(`Wrote ${outPath} (${pdfBytes.length} bytes)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Generate the fixture**

Run from your current working directory as-is (do not `cd` elsewhere):

```bash
npx ts-node scripts/generate-scanned-pdf-fixture.ts
```

Expected output: `Wrote .../tests/fixtures/scanned-sample.pdf (N bytes)`. Verify the file exists:

```bash
ls -la tests/fixtures/scanned-sample.pdf
```

- [ ] **Step 3: Write the fixture-based test**

Create `tests/ingestion/fileConvert.pdfOcrFallback.fixture.test.ts`:

```ts
import * as path from 'node:path';
import { convertFileToText, FileConverters, defaultGetPdfPageCount, defaultRenderPdfPage } from '../../src/ingestion/fileConvert';
import type { OcrResult } from '../../src/ingestion/imageExtract/imageAnalyzer';

const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'scanned-sample.pdf');

function okResult(text: string): OcrResult {
  return { text, metadata: { format: 'png', size: 4, processedAt: 'x', latencyMs: 1 } };
}

describe('scanned-PDF OCR fallback: real render boundary', () => {
  it('real pdfjs-dist getPdfPageCount reports 2 pages for the fixture', async () => {
    const fs = require('node:fs');
    const buffer = fs.readFileSync(FIXTURE_PATH);
    const count = await defaultGetPdfPageCount(buffer);
    expect(count).toBe(2);
  });

  it('real pdfjs-dist + @napi-rs/canvas renders a non-empty PNG for page 1', async () => {
    const fs = require('node:fs');
    const buffer = fs.readFileSync(FIXTURE_PATH);
    const png = await defaultRenderPdfPage(buffer, 1);
    // PNG signature: 89 50 4E 47
    expect(png[0]).toBe(0x89);
    expect(png[1]).toBe(0x50);
    expect(png[2]).toBe(0x4e);
    expect(png[3]).toBe(0x47);
  });

  it('convertFileToText end-to-end on the real fixture, with only ocrPage mocked, returns joined OCR text', async () => {
    const converters: FileConverters = {
      extractDocx: async () => '',
      extractPdf: async () => '', // real pdf-parse would also return '' for this fixture; forced here for determinism
      extractEpub: async () => '',
      // getPdfPageCount and renderPdfPage intentionally NOT overridden --
      // this exercises the real pdfjs-dist + @napi-rs/canvas path.
      ocrPage: async () => okResult('mock OCR text'),
    };

    const text = await convertFileToText(FIXTURE_PATH, converters);

    expect(text).toBe('mock OCR text\n\n--- page 2 ---\n\nmock OCR text');
  });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/ingestion/fileConvert.pdfOcrFallback.fixture.test.ts`
Expected: PASS. If `defaultGetPdfPageCount`/`defaultRenderPdfPage` fail here, that's a real integration problem with the `pdfjs-dist`/`@napi-rs/canvas` install or API usage — fix the implementation from Task 2, not this test.

- [ ] **Step 5: Commit**

```bash
git add scripts/generate-scanned-pdf-fixture.ts tests/fixtures/scanned-sample.pdf tests/ingestion/fileConvert.pdfOcrFallback.fixture.test.ts
git commit -m "test(fileConvert): real-fixture test for scanned-PDF render boundary"
```

---

### Task 5: End-to-end `trm ingest --file` integration test

**Files:**
- Test: `tests/cli/ingest.pdfOcr.test.ts` (new file)

**Interfaces:**
- Consumes: `runIngest` from `../../src/cli/commands/ingest` (existing, unchanged — it already calls `convertFileToText(cliArgs.file)` with no injected converters, so this test exercises the full real default chain including the real `ImageAnalyzer` HTTP call, which is mocked at the `fetch` boundary).

**Amendment (pre-existing Jest gap, found while implementing this task):** `pdf-parse`'s bundled nested `pdfjs-dist` uses a dynamic `import()` internally that Jest's default CJS/vm sandbox cannot execute — real `PDFParse` throws `Setting up fake worker failed: dynamic import callback invoked...` under Jest specifically (confirmed: the identical call succeeds under plain Node, so real `trm ingest --file` CLI usage is unaffected — this is a Jest-only limitation). This is pre-existing and unrelated to this plan's own code: no test in the repo has ever exercised real `pdf-parse` under Jest — `tests/ingestion/fileConvert.test.ts` mocks the `pdf-parse` module entirely, and Task 4's fixture test sidesteps it by stubbing `extractPdf: async () => ''`. Since `runIngest` has no `converters` parameter to inject through (and adding one would be an out-of-scope production-code change), the fix is the same `jest.mock('pdf-parse', ...)` pattern `fileConvert.test.ts` already uses, applied in this new test file — it swaps only the `pdf-parse` module for a stub returning empty text (forcing the fallback path deterministically, which is what this test is actually about), while `getPdfPageCount`/`renderPdfPage`/`ocrPage` all stay real/uninjected exactly as originally intended.

- [ ] **Step 1: Write the failing test**

Create `tests/cli/ingest.pdfOcr.test.ts`:

```ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCreate } from '../../src/cli/commands/create';
import { runIngest } from '../../src/cli/commands/ingest';

// pdf-parse's bundled pdfjs-dist uses a dynamic import() that Jest's
// sandbox can't execute (Jest-only; real Node usage is unaffected). This
// test is about the OCR fallback, not pdf-parse itself, so stub it to
// force the fallback deterministically -- same pattern already used in
// tests/ingestion/fileConvert.test.ts. Everything downstream
// (getPdfPageCount/renderPdfPage/ocrPage) stays real/uninjected.
const mockGetText = jest.fn().mockResolvedValue({ text: '' });
const mockDestroy = jest.fn().mockResolvedValue(undefined);

jest.mock('pdf-parse', () => ({
  PDFParse: jest.fn().mockImplementation(() => ({
    getText: mockGetText,
    destroy: mockDestroy,
  })),
}));

const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'scanned-sample.pdf');

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-ingest-pdf-ocr-'));
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({ default_scoring_adapter: 'stub', promotion_threshold: 80, actor_source: 'cli-only', time_source: 'system' })
  );
  return root;
}

describe('runIngest: scanned PDF end-to-end', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('scanned PDF with no text layer OCRs via the mocked Vision endpoint and writes non-empty extracted text', async () => {
    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (String(url).endsWith('/api/analyze/ocr')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            text: 'End-to-end mocked OCR text',
            metadata: { format: 'png', processedAt: new Date().toISOString(), latencyMs: 5 },
          }),
        });
      }
      return Promise.reject(new Error(`unexpected fetch to ${url}`));
    }) as unknown as typeof global.fetch;

    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });

    const entry = await runIngest(root, 'cuba', {
      actor: 'ACTOR-001',
      type: 'pdf',
      title: 'Vessel Register',
      origin: 'LOC',
      file: FIXTURE_PATH,
    });

    expect(entry?.id).toBe('SRC-001');
    const rawPath = path.join(root, 'topics', 'cuba', 'sources', 'raw', 'SRC-001.json');
    expect(fs.existsSync(rawPath)).toBe(true);
    const envelope = JSON.parse(fs.readFileSync(rawPath, 'utf-8'));
    expect(envelope.kind).toBe('text');
    expect(envelope.text).toBe(
      'End-to-end mocked OCR text\n\n--- page 2 ---\n\nEnd-to-end mocked OCR text'
    );
  }, 30000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/cli/ingest.pdfOcr.test.ts`
Expected: If Tasks 1-4 are already implemented and committed, this should actually PASS on first run since it exercises only already-built code paths. If it fails, confirm whether the failure is a genuine gap (e.g. real `defaultOcrPage`'s endpoint URL doesn't match `/api/analyze/ocr`, or the fixture doesn't exist) versus a test bug, and fix accordingly before proceeding.

- [ ] **Step 3: Run test to verify it passes**

Run: `npx jest tests/cli/ingest.pdfOcr.test.ts`
Expected: PASS.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS, all suites including every test written in Tasks 1-5, and no regressions in the pre-existing suite.

- [ ] **Step 5: Commit**

```bash
git add tests/cli/ingest.pdfOcr.test.ts
git commit -m "test(ingest): end-to-end scanned-PDF OCR via trm ingest --file"
```

---

## Manual verification (not automated — run once after Task 5)

The 3 real vessel-register PDFs that motivated this work are not test fixtures and shouldn't be committed to the repo. After all 5 tasks are merged, manually verify against them:

```bash
cd /c/dev/trm
npx ts-node src/cli/index.ts ingest <topic-path> --actor <ACTOR-ID> --type pdf --title "Vessel Register N" --origin "<source>" --file "<path to real scanned PDF>"
```

Confirm the resulting `sources/raw/SRC-*.json` envelope has non-empty `text`, and check stderr for any `[fileConvert] OCR failed for pages: ...` output indicating partial failures worth a second look.
