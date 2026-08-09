import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readVideoPartialProgress,
  writeVideoPartialProgress,
  clearVideoPartialProgress,
  computeOptionsFingerprint,
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
      optionsFingerprint: computeOptionsFingerprint({
        effectiveStartMs: 0,
        effectiveEndMs: 60000,
        keywordsUsed: [],
        keywordSource: 'none' as const,
      }),
      transcript: 'hello world',
      frameAnalyses: [{ timestampMs: 0, labels: [{ description: 'x', score: 0.5 }] }],
    };
    writeVideoPartialProgress(root, 'abc123', progress);

    expect(readVideoPartialProgress(root, 'abc123')).toEqual(progress);
  });

  it('keys progress independently per hash', () => {
    const root = makeRoot();
    const fingerprint = computeOptionsFingerprint({
      effectiveStartMs: 0,
      effectiveEndMs: 60000,
      keywordsUsed: [],
      keywordSource: 'none' as const,
    });
    writeVideoPartialProgress(root, 'hash-a', { optionsFingerprint: fingerprint, transcript: 'a' });
    writeVideoPartialProgress(root, 'hash-b', { optionsFingerprint: fingerprint, transcript: 'b' });

    expect(readVideoPartialProgress(root, 'hash-a')).toEqual({ optionsFingerprint: fingerprint, transcript: 'a' });
    expect(readVideoPartialProgress(root, 'hash-b')).toEqual({ optionsFingerprint: fingerprint, transcript: 'b' });
  });

  it('returns null after clearing', () => {
    const root = makeRoot();
    const fingerprint = computeOptionsFingerprint({
      effectiveStartMs: 0,
      effectiveEndMs: 60000,
      keywordsUsed: [],
      keywordSource: 'none' as const,
    });
    writeVideoPartialProgress(root, 'abc123', { optionsFingerprint: fingerprint, transcript: 'hello' });
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

describe('computeOptionsFingerprint', () => {
  it('is stable regardless of keywordsUsed input ordering', () => {
    const a = computeOptionsFingerprint({
      effectiveStartMs: 0,
      effectiveEndMs: 1000,
      keywordsUsed: ['b', 'a'],
      keywordSource: 'manual',
    });
    const b = computeOptionsFingerprint({
      effectiveStartMs: 0,
      effectiveEndMs: 1000,
      keywordsUsed: ['a', 'b'],
      keywordSource: 'manual',
    });
    expect(a).toBe(b);
  });

  it('differs when effectiveStartMs/effectiveEndMs differ', () => {
    const a = computeOptionsFingerprint({ effectiveStartMs: 0, effectiveEndMs: 1000, keywordsUsed: [], keywordSource: 'none' });
    const b = computeOptionsFingerprint({ effectiveStartMs: 500, effectiveEndMs: 1000, keywordsUsed: [], keywordSource: 'none' });
    expect(a).not.toBe(b);
  });

  it('differs when keywordsUsed or keywordSource differ', () => {
    const base = { effectiveStartMs: 0, effectiveEndMs: 1000 };
    const a = computeOptionsFingerprint({ ...base, keywordsUsed: ['car'], keywordSource: 'manual' });
    const b = computeOptionsFingerprint({ ...base, keywordsUsed: ['car', 'accident'], keywordSource: 'manual' });
    const c = computeOptionsFingerprint({ ...base, keywordsUsed: ['car'], keywordSource: 'auto' });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});
