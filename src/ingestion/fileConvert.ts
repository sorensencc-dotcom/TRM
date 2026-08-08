import * as fs from 'node:fs';
import * as path from 'node:path';
import * as mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { extractEpub } from './epubExtract';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.js';
import { pdfToPng } from 'pdf-to-png-converter';
import { ImageAnalyzer, OcrResult } from './imageExtract/imageAnalyzer';
import { docPool, pdfOcrPool } from '../core/concurrency';

export interface FileConverters {
  extractDocx: (filePath: string) => Promise<string>;
  extractPdf: (buffer: Buffer) => Promise<string>;
  extractEpub: (filePath: string) => Promise<string>;
  // Scanned-PDF OCR fallback (all optional -- unset means "use the real
  // default," so a test that overrides only extractPdf and forgets these
  // will silently hit real pdfjs-dist/pdf-to-png-converter/Vision calls if
  // its extractPdf ever resolves empty. Tests exercising the fallback path
  // must always override all three.
  getPdfPageCount?: (buffer: Buffer) => Promise<number>;
  renderPdfPage?: (buffer: Buffer, pageNumber: number) => Promise<Buffer>;
  ocrPage?: (buffer: Buffer) => Promise<OcrResult>;
}

export async function defaultGetPdfPageCount(buffer: Buffer): Promise<number> {
  const loadingTask = getDocument({ data: new Uint8Array(buffer) });
  const doc = await loadingTask.promise;
  const numPages = doc.numPages;
  await doc.destroy();
  return numPages;
}

export async function defaultRenderPdfPage(buffer: Buffer, pageNumber: number): Promise<Buffer> {
  const pages = await pdfToPng(buffer, {
    pagesToProcess: [pageNumber],
    viewportScale: 150 / 72, // 150 DPI (PDF points are 1/72 inch)
  });
  const page = pages[0];
  if (!page || !page.content) {
    throw new Error(`defaultRenderPdfPage: page ${pageNumber} not found in rendered output`);
  }
  return page.content;
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
  // through to the real default (real pdfjs-dist/pdf-to-png-converter/Vision
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
      docPool(() => renderPdfPage(buffer, pageNumber)).then((pageBuffer) =>
        pdfOcrPool(() => ocrPage(pageBuffer))
          .then((ocrResult) => ({
            pageNumber,
            text: ocrResult.metadata.error || ocrResult.text.trim().length === 0 ? null : ocrResult.text,
          }))
          .catch(() => ({ pageNumber, text: null as string | null }))
      )
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
