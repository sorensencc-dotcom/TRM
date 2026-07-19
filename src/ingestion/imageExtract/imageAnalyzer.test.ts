import { ImageAnalyzer, AnalysisResult } from './imageAnalyzer';

describe('ImageAnalyzer', () => {
  let analyzer: ImageAnalyzer;

  beforeEach(() => {
    analyzer = new ImageAnalyzer('http://localhost:3000', 5000, 1);
  });

  describe('buffer normalization', () => {
    it('should accept Buffer input', async () => {
      const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]);
      // Mock fetch
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          matches: [],
          metadata: {
            format: 'png',
            visionApiUsed: false,
            latencyMs: 10,
            apiProvider: 'mock',
          },
        }),
      });

      const result = await analyzer.extract(pngBuffer);
      expect(result.metadata.format).toBe('png');
    });

    it('should accept base64 string input', async () => {
      const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const base64 = pngBuffer.toString('base64');

      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          matches: [],
          metadata: {
            format: 'png',
            visionApiUsed: false,
            latencyMs: 10,
            apiProvider: 'mock',
          },
        }),
      });

      const result = await analyzer.extract(base64);
      expect(result.metadata.format).toBe('png');
    });

    it('should accept Uint8Array input', async () => {
      const pngArray = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          matches: [],
          metadata: {
            format: 'png',
            visionApiUsed: false,
            latencyMs: 10,
            apiProvider: 'mock',
          },
        }),
      });

      const result = await analyzer.extract(pngArray);
      expect(result.metadata.format).toBe('png');
    });

    it('should reject null/undefined input', async () => {
      const result = await analyzer.extract(null);
      expect(result.metadata.error).toContain('required');
      expect(result.matches).toHaveLength(0);
    });
  });

  describe('format detection', () => {
    it('should detect PNG from magic bytes', async () => {
      const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]);

      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          matches: [],
          metadata: {
            format: 'png',
            visionApiUsed: false,
            latencyMs: 10,
            apiProvider: 'mock',
          },
        }),
      });

      const result = await analyzer.extract(pngBuffer);
      expect(result.metadata.format).toBe('png');
    });

    it('should detect JPEG from magic bytes', async () => {
      const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          matches: [],
          metadata: {
            format: 'jpeg',
            visionApiUsed: false,
            latencyMs: 10,
            apiProvider: 'mock',
          },
        }),
      });

      const result = await analyzer.extract(jpegBuffer);
      expect(result.metadata.format).toBe('jpeg');
    });
  });

  describe('service integration', () => {
    it('should call service endpoint with base64 image', async () => {
      const imageBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const mockMatches = [
        { url: 'https://example.com/img1', similarity: 85, source: 'google_vision' },
      ];

      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          matches: mockMatches,
          metadata: {
            format: 'png',
            size: imageBuffer.length,
            processedAt: new Date().toISOString(),
            visionApiUsed: true,
            latencyMs: 250,
            apiProvider: 'google_vision',
          },
        }),
      });

      const result = await analyzer.extract(imageBuffer);

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/analyze/image',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      );

      expect(result.matches).toEqual(mockMatches);
      expect(result.metadata.visionApiUsed).toBe(true);
    });

    it('should handle service error response (non-200)', async () => {
      const imageBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal server error',
      });

      const result = await analyzer.extract(imageBuffer);

      expect(result.metadata.error).toContain('500');
      expect(result.matches).toHaveLength(0);
    });

    it('should handle timeout', async () => {
      const imageBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

      global.fetch = jest.fn().mockImplementation(
        () =>
          new Promise((_, reject) => {
            const error = new Error('Aborted');
            (error as any).name = 'AbortError';
            reject(error);
          })
      );

      const result = await analyzer.extract(imageBuffer);

      expect(result.metadata.error).toContain('timeout');
      expect(result.matches).toHaveLength(0);
    });

    it('should handle JSON parse error', async () => {
      const imageBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => {
          throw new Error('Invalid JSON');
        },
      });

      const result = await analyzer.extract(imageBuffer);

      expect(result.metadata.error).toContain('Extraction failed');
      expect(result.matches).toHaveLength(0);
    });

    it('should preserve requestId in logs', async () => {
      const imageBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          matches: [],
          metadata: {
            format: 'png',
            visionApiUsed: false,
            latencyMs: 10,
            apiProvider: 'mock',
          },
        }),
      });

      await analyzer.extract(imageBuffer);

      const calls = consoleSpy.mock.calls.map(c => c.join(' '));
      expect(calls.some(c => c.includes('requestId'))).toBe(true);

      consoleSpy.mockRestore();
    });
  });

  describe('result structure', () => {
    it('should return AnalysisResult with required fields', async () => {
      const imageBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          matches: [
            { url: 'https://example.com/img', similarity: 80, source: 'google_vision' },
          ],
          metadata: {
            format: 'png',
            size: imageBuffer.length,
            processedAt: new Date().toISOString(),
            visionApiUsed: true,
            latencyMs: 100,
            apiProvider: 'google_vision',
          },
        }),
      });

      const result = await analyzer.extract(imageBuffer);

      expect(result).toHaveProperty('matches');
      expect(result).toHaveProperty('metadata');
      expect(result.metadata).toHaveProperty('format');
      expect(result.metadata).toHaveProperty('size');
      expect(result.metadata).toHaveProperty('processedAt');
      expect(result.metadata).toHaveProperty('visionApiUsed');
      expect(result.metadata).toHaveProperty('latencyMs');
      expect(result.metadata).toHaveProperty('apiProvider');
    });

    it('should include error in metadata on failure', async () => {
      const result = await analyzer.extract(null);

      expect(result.metadata).toHaveProperty('error');
      expect(result.metadata.error).toBeDefined();
    });
  });
});
