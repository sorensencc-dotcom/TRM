import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { hashFile, isKnownHash } from '../../src/core/contentHash';

describe('contentHash', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'trm-hash-test-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  describe('hashFile', () => {
    it('returns consistent SHA-256 hash for identical file contents', async () => {
      const file1 = path.join(tmpDir, 'file1.txt');
      const file2 = path.join(tmpDir, 'file2.txt');
      const content = 'Hello world, TRM content hash dedup test!';

      await fs.promises.writeFile(file1, content);
      await fs.promises.writeFile(file2, content);

      const hash1 = await hashFile(file1);
      const hash2 = await hashFile(file2);

      expect(hash1).toBeDefined();
      expect(hash1.length).toBe(64); // SHA-256 hex string length
      expect(hash1).toBe(hash2);
    });

    it('returns different hashes for different file contents', async () => {
      const file1 = path.join(tmpDir, 'file1.txt');
      const file2 = path.join(tmpDir, 'file2.txt');

      await fs.promises.writeFile(file1, 'Content A');
      await fs.promises.writeFile(file2, 'Content B');

      const hash1 = await hashFile(file1);
      const hash2 = await hashFile(file2);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('isKnownHash', () => {
    const testHash = 'a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3';

    it('returns true when hash exists in object manifest', () => {
      const manifestObject = {
        [testHash]: { status: 'done', sourcePath: '/path/to/file.txt' }
      };

      expect(isKnownHash(testHash, manifestObject)).toBe(true);
      expect(isKnownHash('unknownhash', manifestObject)).toBe(false);
    });

    it('returns true when hash exists in Map manifest', () => {
      const manifestMap = new Map<string, unknown>([
        [testHash, { status: 'done' }]
      ]);

      expect(isKnownHash(testHash, manifestMap)).toBe(true);
      expect(isKnownHash('unknownhash', manifestMap)).toBe(false);
    });

    it('returns true when hash exists in Set manifest', () => {
      const manifestSet = new Set<string>([testHash]);

      expect(isKnownHash(testHash, manifestSet)).toBe(true);
      expect(isKnownHash('unknownhash', manifestSet)).toBe(false);
    });

    it('handles empty or missing manifest gracefully', () => {
      expect(isKnownHash(testHash, {})).toBe(false);
      expect(isKnownHash(testHash, new Map())).toBe(false);
      expect(isKnownHash('', { [testHash]: true })).toBe(false);
    });
  });
});
