import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { classifyImage, classifyImageDetailed } from '../../../src/ingestion/imageExtract/classify';

const fixturesDir = path.join(__dirname, '..', '..', '..', 'src', 'ingestion', 'imageExtract', 'fixtures');

describe('classifyImage', () => {
  it('returns the override kind directly with no file analysis when opts.kind is given', async () => {
    // Nonexistent path proves no file read happens when an override is supplied.
    const result = await classifyImage('/nonexistent/path.png', { kind: 'text-doc' });
    expect(result).toBe('text-doc');
  });

  it('classifies a landscape/near-square image as photo (auto path)', async () => {
    const result = await classifyImage(path.join(fixturesDir, 'photo-valid-1x1.png'));
    expect(result).toBe('photo');
  });

  it('classifies a wide landscape image as photo (auto path)', async () => {
    const result = await classifyImage(path.join(fixturesDir, 'photo-valid-landscape.png'));
    expect(result).toBe('photo');
  });

  it('classifies a tall scanned-page-shaped image as text-doc (auto path)', async () => {
    const result = await classifyImage(path.join(fixturesDir, 'text-doc-valid-scanned-page.png'));
    expect(result).toBe('text-doc');
  });

  it('fast-paths extreme document geometry without Vision', async () => {
    const file = path.join(os.tmpdir(), `classify-fast-doc-${Date.now()}.png`);
    const buf = Buffer.alloc(24);
    buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4e; buf[3] = 0x47;
    buf.writeUInt32BE(1000, 16);
    buf.writeUInt32BE(2500, 20);
    await fs.promises.writeFile(file, buf);
    const originalUrl = process.env.CIC_INGESTION_URL;
    process.env.CIC_INGESTION_URL = 'http://vision.test';
    global.fetch = jest.fn();
    try {
      await expect(classifyImageDetailed(file)).resolves.toEqual({ kind: 'text-doc', source: 'aspect-ratio' });
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      if (originalUrl === undefined) delete process.env.CIC_INGESTION_URL;
      else process.env.CIC_INGESTION_URL = originalUrl;
      await fs.promises.unlink(file);
    }
  });

  it('fast-paths extreme landscape geometry as photo without Vision', async () => {
    const file = path.join(os.tmpdir(), `classify-fast-photo-${Date.now()}.png`);
    const buf = Buffer.alloc(24);
    buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4e; buf[3] = 0x47;
    buf.writeUInt32BE(3000, 16);
    buf.writeUInt32BE(1000, 20);
    await fs.promises.writeFile(file, buf);
    const originalUrl = process.env.CIC_INGESTION_URL;
    process.env.CIC_INGESTION_URL = 'http://vision.test';
    global.fetch = jest.fn();
    try {
      await expect(classifyImageDetailed(file)).resolves.toEqual({ kind: 'photo', source: 'aspect-ratio' });
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      if (originalUrl === undefined) delete process.env.CIC_INGESTION_URL;
      else process.env.CIC_INGESTION_URL = originalUrl;
      await fs.promises.unlink(file);
    }
  });

  it('falls back to photo for formats/files it cannot measure', async () => {
    const result = await classifyImage(path.join(fixturesDir, 'photo-empty.bin'));
    expect(result).toBe('photo');
  });

  it('classifyImageDetailed reports confidence 0 when dimensions are unparseable', async () => {
    const result = await classifyImageDetailed(path.join(fixturesDir, 'photo-empty.bin'));
    expect(result).toEqual({ kind: 'photo', source: 'aspect-ratio', confidence: 0 });
  });

  it('classifyImageDetailed leaves confidence undefined when dimensions were measured', async () => {
    const result = await classifyImageDetailed(path.join(fixturesDir, 'photo-valid-1x1.png'));
    expect(result).toEqual({ kind: 'photo', source: 'aspect-ratio' });
  });

  it('falls back to photo for a corrupt PNG (valid magic, no real IHDR dimensions)', async () => {
    const result = await classifyImage(path.join(fixturesDir, 'photo-corrupt.png'));
    expect(result).toBe('photo');
  });

  it('falls back to photo for a PNG magic file with .jpg extension (still reads by header, not name)', async () => {
    const result = await classifyImage(path.join(fixturesDir, 'photo-wrong-ext.jpg'));
    expect(result).toBe('photo');
  });

  describe('JPEG dimension parsing (SOF marker)', () => {
    function makeJpegWithDimensions(width: number, height: number): Buffer {
      // SOI, then SOF0 (0xFFC0): length(2)=7, precision(1)=8, height(2), width(2), then EOI.
      return Buffer.from([
        0xff, 0xd8,
        0xff, 0xc0,
        0x00, 0x07,
        0x08,
        (height >> 8) & 0xff, height & 0xff,
        (width >> 8) & 0xff, width & 0xff,
        0xff, 0xd9,
      ]);
    }

    async function writeTempJpeg(buffer: Buffer): Promise<string> {
      const file = path.join(
        os.tmpdir(),
        `classify-jpeg-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`
      );
      await fs.promises.writeFile(file, buffer);
      return file;
    }

    it('classifies a tall JPEG (real SOF dimensions, aspect ratio >= 1.3) as text-doc', async () => {
      const file = await writeTempJpeg(makeJpegWithDimensions(1000, 1400));
      await expect(classifyImage(file)).resolves.toBe('text-doc');
      await fs.promises.unlink(file);
    });

    it('classifies a square JPEG (real SOF dimensions) as photo', async () => {
      const file = await writeTempJpeg(makeJpegWithDimensions(1000, 1000));
      await expect(classifyImage(file)).resolves.toBe('photo');
      await fs.promises.unlink(file);
    });

    it('classifies a landscape JPEG (real SOF dimensions) as photo', async () => {
      const file = await writeTempJpeg(makeJpegWithDimensions(1400, 1000));
      await expect(classifyImage(file)).resolves.toBe('photo');
      await fs.promises.unlink(file);
    });

    it('falls back to photo for a JPEG with no SOF marker (existing fixture has none)', async () => {
      const result = await classifyImage(path.join(fixturesDir, 'photo-valid-5kb.jpg'));
      expect(result).toBe('photo');
    });
  });

  describe('aspect ratio boundary (>= 1.3 is the text-doc cutoff)', () => {
    function makePng(width: number, height: number): Buffer {
      const buf = Buffer.alloc(24);
      buf[0] = 0x89;
      buf[1] = 0x50;
      buf[2] = 0x4e;
      buf[3] = 0x47;
      buf.writeUInt32BE(width, 16);
      buf.writeUInt32BE(height, 20);
      return buf;
    }

    async function writeTempPng(buffer: Buffer): Promise<string> {
      const file = path.join(
        os.tmpdir(),
        `classify-boundary-test-${Date.now()}-${Math.random().toString(36).slice(2)}.png`
      );
      await fs.promises.writeFile(file, buffer);
      return file;
    }

    it('classifies exactly 1.3 (1000x1300) as text-doc (inclusive boundary)', async () => {
      const file = await writeTempPng(makePng(1000, 1300));
      await expect(classifyImage(file)).resolves.toBe('text-doc');
      await fs.promises.unlink(file);
    });

    it('classifies just under 1.3 (1000x1299) as photo', async () => {
      const file = await writeTempPng(makePng(1000, 1299));
      await expect(classifyImage(file)).resolves.toBe('photo');
      await fs.promises.unlink(file);
    });
  });

  it('an explicit --kind override short-circuits even for a file whose real shape disagrees', async () => {
    const fixture = path.join(fixturesDir, 'text-doc-valid-scanned-page.png');
    await expect(classifyImage(fixture, { kind: 'photo' })).resolves.toBe('photo');
  });
});

describe('vision-label classification (when CIC_INGESTION_URL is set)', () => {
  const originalEnv = process.env.CIC_INGESTION_URL;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CIC_INGESTION_URL;
    else process.env.CIC_INGESTION_URL = originalEnv;
    jest.restoreAllMocks();
  });

  it('classifies as text-doc when a Document-like label scores above threshold', async () => {
    process.env.CIC_INGESTION_URL = 'http://localhost:9999';
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        matches: [],
        labels: [{ description: 'Document', score: 0.88 }],
        metadata: { format: 'png', visionApiUsed: true, latencyMs: 5, apiProvider: 'google_vision' },
      }),
    });

    const fixture = path.join(fixturesDir, 'photo-valid-1x1.png'); // aspect ratio alone would say "photo"
    const result = await classifyImage(fixture);
    expect(result).toBe('text-doc');
  });

  it('classifies as photo when labels have no document-like signal', async () => {
    process.env.CIC_INGESTION_URL = 'http://localhost:9999';
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        matches: [],
        labels: [{ description: 'Airplane', score: 0.95 }],
        metadata: { format: 'png', visionApiUsed: true, latencyMs: 5, apiProvider: 'google_vision' },
      }),
    });

    const fixture = path.join(fixturesDir, 'text-doc-valid-scanned-page.png'); // aspect ratio alone would say "text-doc"
    const result = await classifyImage(fixture);
    expect(result).toBe('photo');
  });

  it('falls back to the aspect-ratio heuristic when the vision call throws', async () => {
    process.env.CIC_INGESTION_URL = 'http://localhost:9999';
    global.fetch = jest.fn().mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const fixture = path.join(fixturesDir, 'text-doc-valid-scanned-page.png');
    const result = await classifyImage(fixture);
    expect(result).toBe('text-doc'); // aspect-ratio fallback result, unchanged from today
  });

  it('falls back to the aspect-ratio heuristic when the service returns mock-mode results (visionApiUsed false)', async () => {
    process.env.CIC_INGESTION_URL = 'http://localhost:9999';
    // Mock mode: HTTP 200, no metadata.error, but Vision never actually ran.
    // Labels present here would say "photo"; the fixture's aspect ratio says text-doc.
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        matches: [],
        labels: [{ description: 'Airplane', score: 0.95 }],
        metadata: { format: 'png', visionApiUsed: false, latencyMs: 1, apiProvider: 'mock' },
      }),
    });

    const fixture = path.join(fixturesDir, 'text-doc-valid-scanned-page.png');
    const result = await classifyImageDetailed(fixture);
    expect(result.source).toBe('aspect-ratio'); // did NOT trust the mock labels
    expect(result.kind).toBe('text-doc');
  });

  it('does not false-positive on substring-only label matches like "Homepage" or "Notebook"', async () => {
    process.env.CIC_INGESTION_URL = 'http://localhost:9999';
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        matches: [],
        labels: [
          { description: 'Homepage', score: 0.95 },
          { description: 'Notebook', score: 0.93 },
          { description: 'Wallpaper', score: 0.91 },
          { description: 'Textile', score: 0.9 },
        ],
        metadata: { format: 'png', visionApiUsed: true, latencyMs: 5, apiProvider: 'google_vision' },
      }),
    });

    const fixture = path.join(fixturesDir, 'text-doc-valid-scanned-page.png');
    const result = await classifyImageDetailed(fixture);
    expect(result.source).toBe('vision');
    expect(result.kind).toBe('photo');
  });

  it('still matches plural document labels ("Documents")', async () => {
    process.env.CIC_INGESTION_URL = 'http://localhost:9999';
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        matches: [],
        labels: [{ description: 'Historical documents', score: 0.77 }],
        metadata: { format: 'png', visionApiUsed: true, latencyMs: 5, apiProvider: 'google_vision' },
      }),
    });

    const fixture = path.join(fixturesDir, 'photo-valid-1x1.png');
    const result = await classifyImageDetailed(fixture);
    expect(result).toEqual({ kind: 'text-doc', source: 'vision', confidence: 0.77 });
  });

  it('an explicit opts.kind override still short-circuits before any vision call', async () => {
    process.env.CIC_INGESTION_URL = 'http://localhost:9999';
    global.fetch = jest.fn();
    const result = await classifyImage('/nonexistent/path.png', { kind: 'photo' });
    expect(result).toBe('photo');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
