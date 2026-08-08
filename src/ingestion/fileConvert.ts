import * as fs from 'node:fs';
import * as path from 'node:path';
import * as mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { extractEpub } from './epubExtract';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.js';
import { createCanvas } from '@napi-rs/canvas';
import { ImageAnalyzer, OcrResult } from './imageExtract/imageAnalyzer';
import { docPool, pdfOcrPool, pdfRenderPool } from '../core/concurrency';

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
  const loadingTask = getDocument({ data: new Uint8Array(buffer), isEvalSupported: false });
  const doc = await loadingTask.promise;
  try {
    return doc.numPages;
  } finally {
    await doc.destroy();
  }
}

export async function defaultRenderPdfPage(buffer: Buffer, pageNumber: number): Promise<Buffer> {
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    cMapUrl: PDFJS_CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: PDFJS_STANDARD_FONT_DATA_URL,
    canvasFactory: new NapiCanvasFactory() as any,
    isEvalSupported: false,
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

  // Page rendering uses its own dedicated pool (pdfRenderPool), NOT docPool.
  // triage-intake.ts already wraps its whole convertFileToText(...) call in
  // docPool(...); p-limit is not re-entrant, so acquiring docPool again here
  // (for rendering) while an outer docPool slot is held deadlocks once all
  // outer slots are occupied by tasks each awaiting an inner docPool
  // acquisition that can never be granted. A separate pool sidesteps that
  // entirely.
  const pageNumbers = Array.from({ length: pageCount }, (_, i) => i + 1);
  const pageResults = await Promise.all(
    pageNumbers.map((pageNumber) =>
      pdfRenderPool(() => renderPdfPage(buffer, pageNumber)).then((pageBuffer) =>
        pdfOcrPool(() => ocrPage(pageBuffer))
          .then((ocrResult) => ({
            pageNumber,
            text: ocrResult.metadata.error || ocrResult.text.trim().length === 0 ? null : ocrResult.text,
          }))
          .catch((err) => ({
            pageNumber,
            text: null as string | null,
            errorMessage: err instanceof Error ? err.message : String(err),
          }))
      )
    )
  );

  const successfulPages = pageResults.filter((r) => r.text !== null).length;
  if (successfulPages === 0) {
    return '';
  }

  const failedPages = pageResults.filter((r) => r.text === null);
  if (failedPages.length > 0) {
    const detail = failedPages
      .map((r) => `${r.pageNumber}${'errorMessage' in r && r.errorMessage ? ` (${r.errorMessage})` : ''}`)
      .join(', ');
    console.error(`[fileConvert] OCR failed for pages: ${detail}`);
  }

  return pageResults
    .map((r, idx) => {
      const content = r.text !== null ? r.text : `[OCR FAILED: page ${r.pageNumber}]`;
      return idx === 0 ? content : `\n\n--- page ${r.pageNumber} ---\n\n${content}`;
    })
    .join('');
}

export const defaultConverters: FileConverters = {
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

const SUPPORTED_EXTENSIONS = ['.txt', '.md', '.docx', '.pdf', '.epub'];

export async function convertFileToText(
  filePath: string,
  converters: FileConverters = defaultConverters
): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  let text: string;

  if (ext === '.txt' || ext === '.md') {
    text = fs.readFileSync(filePath, 'utf-8');
  } else if (ext === '.docx') {
    text = await converters.extractDocx(filePath);
  } else if (ext === '.pdf') {
    text = await extractPdfWithOcrFallback(fs.readFileSync(filePath), converters);
  } else if (ext === '.epub') {
    text = await converters.extractEpub(filePath);
  } else {
    throw new Error(
      `trm ingest --file: unsupported file extension "${ext}" (supported: ${SUPPORTED_EXTENSIONS.join(', ')})`
    );
  }

  if (text.trim().length === 0) {
    throw new Error(`trm ingest --file: "${filePath}" produced no extractable text`);
  }

  return text;
}
