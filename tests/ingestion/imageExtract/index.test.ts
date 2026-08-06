import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// heic-convert shells out to a wasm libheif decoder; real HEIC bytes aren't
// needed to test the plumbing, so stub it and assert it's invoked correctly.
const mockConvert = jest.fn();
jest.mock('heic-convert', () => mockConvert);

import { extractImage } from '../../../src/ingestion/imageExtract';

// Minimal valid 1x1 PNG (magic bytes + IHDR stub is enough for _detectFormat).
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

function makeImageFile(name: string, content: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-imageextract-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

describe('extractImage', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    mockConvert.mockReset();
  });

  it('reads a PNG file and returns mock ExtractionResult with visionApiUsed false', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        matches: [
          { url: 'https://mock.example.com/image-1', similarity: 85, source: 'mock' },
        ],
        metadata: {
          format: 'png',
          visionApiUsed: false,
          latencyMs: 10,
          apiProvider: 'mock',
        },
      }),
    }) as unknown as typeof fetch;

    const file = makeImageFile('photo.png', PNG_MAGIC);
    const result = await extractImage(file);

    expect(result.metadata.format).toBe('png');
    expect(result.metadata.visionApiUsed).toBe(false);
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0].url).toMatch(/^https:\/\/mock\.example\.com\//);
  });

  it('returns an error result (not a throw) for an unrecognized image format', async () => {
    const file = makeImageFile('bad.png', Buffer.from('not an image'));
    const result = await extractImage(file);

    expect(result.matches).toEqual([]);
    expect(result.metadata.error).toMatch(/unsupported/i);
  });

  it('throws when the file path does not exist', async () => {
    await expect(extractImage('/nonexistent/path/photo.png')).rejects.toThrow();
  });

  it('converts a HEIC file to JPEG before analysis', async () => {
    mockConvert.mockResolvedValue(new Uint8Array(JPEG_MAGIC));
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        matches: [{ url: 'https://mock.example.com/heic-1', similarity: 90, source: 'mock' }],
        metadata: { format: 'jpeg', visionApiUsed: false, latencyMs: 5, apiProvider: 'mock' },
      }),
    }) as unknown as typeof fetch;

    const file = makeImageFile('photo.heic', Buffer.from('not real heic bytes'));
    const result = await extractImage(file);

    expect(mockConvert).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'JPEG' })
    );
    expect(result.metadata.format).toBe('jpeg');
    expect(result.matches[0].url).toMatch(/^https:\/\/mock\.example\.com\//);
  });

  it('propagates a heic-convert failure as an error result, not a throw', async () => {
    mockConvert.mockRejectedValue(new Error('libheif: invalid HEIC data'));

    const file = makeImageFile('corrupt.heic', Buffer.from('garbage'));
    await expect(extractImage(file)).rejects.toThrow(/invalid HEIC data/);
  });
});
