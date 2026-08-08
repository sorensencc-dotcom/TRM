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
