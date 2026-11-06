import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { removeTempDir } = require('../../scripts/remove-temp-dir.cjs');

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
