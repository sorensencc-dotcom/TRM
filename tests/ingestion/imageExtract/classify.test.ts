import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { classifyImage } from '../../../src/ingestion/imageExtract/classify';

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

  it('falls back to photo for formats/files it cannot measure', async () => {
    const result = await classifyImage(path.join(fixturesDir, 'photo-empty.bin'));
    expect(result).toBe('photo');
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
