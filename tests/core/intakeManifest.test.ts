import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  intakeManifestPath,
  readIntakeManifest,
  writeIntakeEntry,
  isIntakeDone,
  findByHash,
  IntakeEntry,
} from '../../src/core/intakeManifest';

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trm-intake-'));
}

function makeEntry(overrides: Partial<IntakeEntry> = {}): IntakeEntry {
  return {
    hash: 'abc123',
    sourcePath: 'intake/mfm/photo1.jpg',
    batch: 'mfm',
    ext: '.jpg',
    sizeBytes: 1024,
    kind: 'image',
    classifiedType: 'exhibit-photo',
    isDup: false,
    status: 'done',
    classifiedAt: '2026-08-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('intakeManifest', () => {
  it('intakeManifestPath points at intake-manifest.json under root', () => {
    const root = makeRoot();
    expect(intakeManifestPath(root)).toBe(path.join(root, 'intake-manifest.json'));
  });

  it('readIntakeManifest returns an empty entries map when no file exists yet', () => {
    const root = makeRoot();
    expect(readIntakeManifest(root)).toEqual({ entries: {} });
  });

  it('writeIntakeEntry then readIntakeManifest round-trips an entry, keyed by hash', () => {
    const root = makeRoot();
    const entry = makeEntry();
    writeIntakeEntry(root, entry);
    const manifest = readIntakeManifest(root);
    expect(manifest.entries['abc123']).toEqual(entry);
  });

  it('isIntakeDone is false for an unknown hash', () => {
    const root = makeRoot();
    expect(isIntakeDone(root, 'nope')).toBe(false);
  });

  it('isIntakeDone is true only when status is done', () => {
    const root = makeRoot();
    writeIntakeEntry(root, makeEntry({ hash: 'h1', status: 'done' }));
    writeIntakeEntry(root, makeEntry({ hash: 'h2', status: 'failed', error: 'boom' }));
    expect(isIntakeDone(root, 'h1')).toBe(true);
    expect(isIntakeDone(root, 'h2')).toBe(false);
  });

  it('findByHash returns the existing entry for dedup lookups, or null', () => {
    const root = makeRoot();
    writeIntakeEntry(root, makeEntry({ hash: 'h1' }));
    expect(findByHash(root, 'h1')?.hash).toBe('h1');
    expect(findByHash(root, 'missing')).toBeNull();
  });

  it('writeIntakeEntry creates intake-manifest.json if it does not exist yet', () => {
    const root = makeRoot();
    writeIntakeEntry(root, makeEntry());
    expect(fs.existsSync(path.join(root, 'intake-manifest.json'))).toBe(true);
  });

  it('writing a second entry preserves the first (no overwrite of unrelated hashes)', () => {
    const root = makeRoot();
    writeIntakeEntry(root, makeEntry({ hash: 'h1' }));
    writeIntakeEntry(root, makeEntry({ hash: 'h2', sourcePath: 'intake/mfm/photo2.jpg' }));
    const manifest = readIntakeManifest(root);
    expect(Object.keys(manifest.entries).sort()).toEqual(['h1', 'h2']);
  });
});
