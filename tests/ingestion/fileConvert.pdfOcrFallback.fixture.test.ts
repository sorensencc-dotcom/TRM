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
