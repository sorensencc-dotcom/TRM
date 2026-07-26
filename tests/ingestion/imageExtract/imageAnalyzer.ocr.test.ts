import { ImageAnalyzer, OcrResult } from '../../../src/ingestion/imageExtract/imageAnalyzer';

// Minimal valid PNG buffer for header detection (PNG_MAGIC)
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('ImageAnalyzer.ocr', () => {
  const realFetch = global.fetch;
  let analyzer: ImageAnalyzer;

  beforeEach(() => {
    analyzer = new ImageAnalyzer('http://localhost:3000', 500, 3);
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('returns extracted text and metadata on success', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        text: 'Document header text extracted via OCR.',
        metadata: {
          format: 'png',
          processedAt: '2026-07-26T00:00:00.000Z',
          latencyMs: 15,
        },
      }),
    }) as unknown as typeof fetch;

    const result: OcrResult = await analyzer.ocr(PNG_MAGIC);

    expect(result.text).toBe('Document header text extracted via OCR.');
    expect(result.metadata.format).toBe('png');
    expect(result.metadata.size).toBe(PNG_MAGIC.length);
    expect(result.metadata.error).toBeUndefined();
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/analyze/ocr',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });

  it('retries per policy on transient failures and succeeds', async () => {
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation(async () => {
      callCount++;
      if (callCount < 3) {
        return {
          ok: false,
          status: 503,
          text: async () => 'Service Unavailable',
        };
      }
      return {
        ok: true,
        json: async () => ({
          text: 'Success after retries',
          metadata: { format: 'png', latencyMs: 50 },
        }),
      };
    }) as unknown as typeof fetch;

    const result = await analyzer.ocr(PNG_MAGIC);

    expect(callCount).toBe(3);
    expect(result.text).toBe('Success after retries');
    expect(result.metadata.error).toBeUndefined();
  });

  it('returns a typed error result after exhausting retries without throwing', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    }) as unknown as typeof fetch;

    const result = await analyzer.ocr(PNG_MAGIC);

    expect(result.text).toBe('');
    expect(result.metadata.error).toBeDefined();
    expect(result.metadata.error).toMatch(/OCR failed/i);
  });

  it('returns error result for invalid or unsupported buffer without network calls', async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;

    const resultBadBuf = await analyzer.ocr('not a valid base64 or buffer!');
    expect(resultBadBuf.text).toBe('');
    expect(resultBadBuf.metadata.error).toMatch(/unsupported/i);
    expect(global.fetch).not.toHaveBeenCalled();

    const resultNull = await analyzer.ocr(null);
    expect(resultNull.metadata.error).toMatch(/required/i);
  });
});
