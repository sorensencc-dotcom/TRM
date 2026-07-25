import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { rawSourcePath, writeRawEnvelope, readRawEnvelope, RawSourceEnvelope } from '../../src/core/rawSource';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-'));
  fs.mkdirSync(path.join(root, 'topics', 'cuba'), { recursive: true });
  return root;
}

describe('rawSource', () => {
  it('rawSourcePath points at sources/raw/{id}.json under the topic dir', () => {
    const root = makeRoot();
    const p = rawSourcePath(root, 'cuba', 'SRC-001');
    expect(p).toBe(path.join(root, 'topics', 'cuba', 'sources', 'raw', 'SRC-001.json'));
  });

  it('writeRawEnvelope then readRawEnvelope round-trips a text envelope', () => {
    const root = makeRoot();
    const envelope: RawSourceEnvelope = {
      sourceId: 'SRC-001',
      kind: 'text',
      capturedAt: '2026-07-25T00:00:00.000Z',
      text: 'Fact one.\nFact two.',
    };
    writeRawEnvelope(root, 'cuba', envelope);
    const read = readRawEnvelope(root, 'cuba', 'SRC-001');
    expect(read).toEqual(envelope);
  });

  it('writeRawEnvelope then readRawEnvelope round-trips an image envelope', () => {
    const root = makeRoot();
    const envelope: RawSourceEnvelope = {
      sourceId: 'SRC-002',
      kind: 'image',
      capturedAt: '2026-07-25T00:00:00.000Z',
      image: {
        matches: [],
        metadata: { format: 'png', size: 8, processedAt: '2026-07-25T00:00:00.000Z', visionApiUsed: false },
        mock: true,
      },
    };
    writeRawEnvelope(root, 'cuba', envelope);
    const read = readRawEnvelope(root, 'cuba', 'SRC-002');
    expect(read).toEqual(envelope);
  });

  it('readRawEnvelope returns null when the source has no raw file', () => {
    const root = makeRoot();
    expect(readRawEnvelope(root, 'cuba', 'SRC-999')).toBeNull();
  });

  it('writeRawEnvelope creates sources/raw if it does not exist yet', () => {
    const root = makeRoot();
    writeRawEnvelope(root, 'cuba', { sourceId: 'SRC-001', kind: 'text', capturedAt: '2026-07-25T00:00:00.000Z', text: 'x' });
    expect(fs.existsSync(path.join(root, 'topics', 'cuba', 'sources', 'raw', 'SRC-001.json'))).toBe(true);
  });
});
