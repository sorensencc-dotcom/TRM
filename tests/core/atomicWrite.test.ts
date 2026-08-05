import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeFileAtomic, writeFileExclusive, copyFileAtomic } from '../../src/core/atomicWrite';

describe('atomicWrite', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-atomic-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writeFileAtomic creates parent dirs and writes content', () => {
    const file = path.join(dir, 'nested', 'file.json');
    writeFileAtomic(file, '{"a":1}');
    expect(fs.readFileSync(file, 'utf-8')).toBe('{"a":1}');
  });

  it('writeFileAtomic leaves no temp file behind', () => {
    const file = path.join(dir, 'file.json');
    writeFileAtomic(file, '{}');
    const entries = fs.readdirSync(dir);
    expect(entries).toEqual(['file.json']);
  });

  it('writeFileAtomic overwrites an existing file', () => {
    const file = path.join(dir, 'file.json');
    writeFileAtomic(file, 'v1');
    writeFileAtomic(file, 'v2');
    expect(fs.readFileSync(file, 'utf-8')).toBe('v2');
  });

  it('concurrent writes leave a complete, parseable JSON document', async () => {
    const file = path.join(dir, 'manifest.json');
    const payloads = Array.from({ length: 20 }, (_, i) => JSON.stringify({ entries: { [`hash-${i}`]: { status: 'done' } } }));
    await Promise.all(payloads.map((payload) => Promise.resolve().then(() => writeFileAtomic(file, payload))));
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(parsed.entries).toBeDefined();
    expect(Object.values(parsed.entries)[0]).toEqual({ status: 'done' });
    expect(fs.readdirSync(dir).filter((entry) => entry.includes('.tmp-'))).toEqual([]);
  });

  it('writeFileExclusive succeeds when the file does not exist', () => {
    const file = path.join(dir, 'report.md');
    writeFileExclusive(file, 'content');
    expect(fs.readFileSync(file, 'utf-8')).toBe('content');
  });

  it('writeFileExclusive throws and does not modify an existing file', () => {
    const file = path.join(dir, 'report.md');
    writeFileExclusive(file, 'original');
    expect(() => writeFileExclusive(file, 'overwrite-attempt')).toThrow();
    expect(fs.readFileSync(file, 'utf-8')).toBe('original');
  });

  it('writeFileExclusive leaves no temp file behind after a collision', () => {
    const file = path.join(dir, 'report.md');
    writeFileExclusive(file, 'original');
    try {
      writeFileExclusive(file, 'overwrite-attempt');
    } catch {
      // expected
    }
    const entries = fs.readdirSync(dir);
    expect(entries).toEqual(['report.md']);
  });

  it('copyFileAtomic copies file contents and creates parent dirs', () => {
    const src = path.join(dir, 'source.bin');
    fs.writeFileSync(src, Buffer.from([1, 2, 3, 4]));
    const dest = path.join(dir, 'nested', 'dest.bin');

    copyFileAtomic(src, dest);

    expect(fs.readFileSync(dest)).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('copyFileAtomic leaves no temp file behind on success', () => {
    const src = path.join(dir, 'source.bin');
    fs.writeFileSync(src, 'hello');
    const dest = path.join(dir, 'dest.bin');

    copyFileAtomic(src, dest);

    const entries = fs.readdirSync(dir);
    expect(entries.sort()).toEqual(['dest.bin', 'source.bin']);
  });

  it('copyFileAtomic never leaves a partial file at the destination name when the copy throws', () => {
    const src = path.join(dir, 'source.bin');
    fs.writeFileSync(src, 'hello');
    const dest = path.join(dir, 'dest.bin');
    const copySpy = jest.spyOn(fs, 'copyFileSync').mockImplementation(() => {
      throw new Error('simulated disk-full mid-copy');
    });

    try {
      expect(() => copyFileAtomic(src, dest)).toThrow('simulated disk-full mid-copy');
      expect(fs.existsSync(dest)).toBe(false);
    } finally {
      copySpy.mockRestore();
    }
  });
});
