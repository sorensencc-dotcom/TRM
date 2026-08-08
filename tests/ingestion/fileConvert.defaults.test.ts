import { defaultGetPdfPageCount, defaultRenderPdfPage, defaultOcrPage } from '../../src/ingestion/fileConvert';

const mockDocDestroy = jest.fn().mockResolvedValue(undefined);
const mockGetDocument = jest.fn();

jest.mock('pdfjs-dist/legacy/build/pdf.js', () => ({
  getDocument: (...args: unknown[]) => mockGetDocument(...args),
}));

const mockPdfToPng = jest.fn();

jest.mock('pdf-to-png-converter', () => ({
  pdfToPng: (...args: unknown[]) => mockPdfToPng(...args),
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
    mockPdfToPng.mockReset();
  });

  it('renders exactly the requested page at 150 DPI and returns its PNG buffer', async () => {
    const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    mockPdfToPng.mockResolvedValue([{ pageNumber: 2, content: pngBuffer }]);

    const result = await defaultRenderPdfPage(Buffer.from('fake pdf bytes'), 2);

    expect(result).toBe(pngBuffer);
    expect(mockPdfToPng).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({ pagesToProcess: [2], viewportScale: 150 / 72 })
    );
  });

  it('throws when pdf-to-png-converter returns no pages', async () => {
    mockPdfToPng.mockResolvedValue([]);

    await expect(defaultRenderPdfPage(Buffer.from('fake pdf bytes'), 5)).rejects.toThrow(/page 5/);
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
