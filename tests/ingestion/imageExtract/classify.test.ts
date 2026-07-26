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
});
