import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractImage } from '../../../src/ingestion/imageExtract';

// Minimal valid 1x1 PNG (magic bytes + IHDR stub is enough for _detectFormat).
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeImageFile(name: string, content: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-imageextract-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

describe('extractImage', () => {
  it('reads a PNG file and returns mock ExtractionResult with visionApiUsed false', async () => {
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
});
