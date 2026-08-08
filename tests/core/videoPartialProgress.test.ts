import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readVideoPartialProgress,
  writeVideoPartialProgress,
  clearVideoPartialProgress,
} from '../../src/core/videoPartialProgress';

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trm-videopartial-'));
}

describe('videoPartialProgress', () => {
  it('returns null when no progress file exists yet', () => {
    const root = makeRoot();
    expect(readVideoPartialProgress(root, 'abc123')).toBeNull();
  });

  it('writes and reads back progress for a given hash', () => {
    const root = makeRoot();
    const progress = {
      transcript: 'hello world',
      frameAnalyses: [{ timestampMs: 0, labels: [{ description: 'x', score: 0.5 }] }],
    };
    writeVideoPartialProgress(root, 'abc123', progress);

    expect(readVideoPartialProgress(root, 'abc123')).toEqual(progress);
  });

  it('keys progress independently per hash', () => {
    const root = makeRoot();
    writeVideoPartialProgress(root, 'hash-a', { transcript: 'a' });
    writeVideoPartialProgress(root, 'hash-b', { transcript: 'b' });

    expect(readVideoPartialProgress(root, 'hash-a')).toEqual({ transcript: 'a' });
    expect(readVideoPartialProgress(root, 'hash-b')).toEqual({ transcript: 'b' });
  });

  it('returns null after clearing', () => {
    const root = makeRoot();
    writeVideoPartialProgress(root, 'abc123', { transcript: 'hello' });
    clearVideoPartialProgress(root, 'abc123');

    expect(readVideoPartialProgress(root, 'abc123')).toBeNull();
  });

  it('clearing a non-existent progress file does not throw', () => {
    const root = makeRoot();
    expect(() => clearVideoPartialProgress(root, 'never-written')).not.toThrow();
  });

  it('returns null for a corrupt progress file rather than throwing', () => {
    const root = makeRoot();
    const opsDir = path.join(root, '.trm-ops', 'video-partial');
    fs.mkdirSync(opsDir, { recursive: true });
    fs.writeFileSync(path.join(opsDir, 'abc123.json'), 'not valid json{{{');

    expect(readVideoPartialProgress(root, 'abc123')).toBeNull();
  });
});
