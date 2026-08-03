import { ImageAnalyzer, AnalysisResult } from '../../../src/ingestion/imageExtract/imageAnalyzer';

describe('ImageAnalyzer.extract with labels', () => {
  let analyzer: ImageAnalyzer;
  const realFetch = global.fetch;

  beforeEach(() => {
    analyzer = new ImageAnalyzer('http://localhost:3000', 500, 3);
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('passes through labels from the service response', async () => {
    const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]);
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        matches: [],
        labels: [{ description: 'Document', score: 0.91 }],
        metadata: {
          format: 'png',
          visionApiUsed: true,
          latencyMs: 12,
          apiProvider: 'google_vision',
        },
      }),
    }) as unknown as typeof fetch;

    const result = await analyzer.extract(pngBuffer);
    expect(result.labels).toEqual([{ description: 'Document', score: 0.91 }]);
  });

  it('defaults labels to an empty array when the service response omits it', async () => {
    const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]);
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        matches: [],
        metadata: { format: 'png', visionApiUsed: false, latencyMs: 10, apiProvider: 'mock' },
      }),
    }) as unknown as typeof fetch;

    const result = await analyzer.extract(pngBuffer);
    expect(result.labels).toEqual([]);
  });
});
