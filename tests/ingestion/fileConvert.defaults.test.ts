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
