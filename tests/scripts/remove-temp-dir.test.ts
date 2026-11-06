import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { removeTempDir, sweepStaleTempDirs } = require('../../scripts/remove-temp-dir.cjs');

describe('sweepStaleTempDirs', () => {
  it('removes old prefixed dirs and keeps recent or unrelated ones', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-wiki-sweep-'));
    const old = path.join(root, 'trm-wiki-sync-1');
    const recent = path.join(root, 'trm-wiki-sync-2');
    const other = path.join(root, 'unrelated-3');
    for (const d of [old, recent, other]) fs.mkdirSync(d);
    const past = new Date(Date.now() - 2 * 3600000);
    fs.utimesSync(old, past, past);
    fs.utimesSync(other, past, past);

    expect(sweepStaleTempDirs(root, 'trm-wiki-sync-', { warn: jest.fn() })).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns 0 when the root cannot be read', () => {
    expect(sweepStaleTempDirs(path.join(os.tmpdir(), 'trm-wiki-no-such-root-xyz'), 'trm-wiki-sync-')).toBe(0);
  });
});

function makeDirWithReadOnlyFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-wiki-rm-'));
  const nested = path.join(dir, '.git', 'objects', 'pack');
  fs.mkdirSync(nested, { recursive: true });
  const file = path.join(nested, 'pack-1.idx');
  fs.writeFileSync(file, 'x');
  fs.chmodSync(file, 0o444);
  return dir;
}

describe('removeTempDir', () => {
  it('removes a directory that holds read-only files', () => {
    const dir = makeDirWithReadOnlyFile();
    const warn = jest.fn();
    expect(removeTempDir(dir, { warn })).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('retries once after the first removal fails with EPERM', () => {
    const dir = makeDirWithReadOnlyFile();
    const real = fs.rmSync;
    const rm = jest
      .fn()
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      })
      .mockImplementation((p: string, o: fs.RmOptions) => real(p, o));
    expect(removeTempDir(dir, { rm, warn: jest.fn() })).toBe(true);
    expect(rm).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('warns and returns false instead of throwing when removal keeps failing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-wiki-rm-'));
    const rm = jest.fn(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });
    const warn = jest.fn();
    expect(() => removeTempDir(dir, { rm, warn })).not.toThrow();
    expect(removeTempDir(dir, { rm, warn })).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('EPERM'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns true when the directory is already gone', () => {
    expect(removeTempDir(path.join(os.tmpdir(), 'trm-wiki-rm-missing-xyz'))).toBe(true);
  });
});
