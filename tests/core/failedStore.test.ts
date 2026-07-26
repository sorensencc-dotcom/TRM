import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { appendFailure, readFailed, clearFailure } from '../../src/core/failedStore';

describe('failedStore', () => {
  let root: string;
  const topicPath = 'test-topic';

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'trm-failed-test-'));
  });

  afterEach(async () => {
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  it('appendFailure then readFailed returns the entry', () => {
    appendFailure(root, topicPath, 'hash-a', '/path/a.txt', 'boom');

    const entries = readFailed(root, topicPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ hash: 'hash-a', sourcePath: '/path/a.txt', error: 'boom' });
  });

  it('appending N failures then reading returns all N', () => {
    for (let i = 0; i < 5; i++) {
      appendFailure(root, topicPath, `hash-${i}`, `/path/${i}.txt`, `err-${i}`);
    }
    expect(readFailed(root, topicPath)).toHaveLength(5);
  });

  it('appending twice for the same hash results in exactly one entry, not two', () => {
    appendFailure(root, topicPath, 'hash-x', '/path/x.txt', 'first error');
    appendFailure(root, topicPath, 'hash-x', '/path/x.txt', 'second error');

    const entries = readFailed(root, topicPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].error).toBe('second error');
  });

  it('clearFailure removes the entry for that hash, leaving N-1', () => {
    appendFailure(root, topicPath, 'hash-1', '/path/1.txt', 'e1');
    appendFailure(root, topicPath, 'hash-2', '/path/2.txt', 'e2');
    appendFailure(root, topicPath, 'hash-3', '/path/3.txt', 'e3');

    clearFailure(root, topicPath, 'hash-2');

    const entries = readFailed(root, topicPath);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.hash).sort()).toEqual(['hash-1', 'hash-3']);
  });

  it('clearFailure on an unknown hash is a no-op', () => {
    appendFailure(root, topicPath, 'hash-1', '/path/1.txt', 'e1');
    clearFailure(root, topicPath, 'nonexistent');
    expect(readFailed(root, topicPath)).toHaveLength(1);
  });

  it('readFailed on an untouched topic returns an empty list', () => {
    expect(readFailed(root, topicPath)).toEqual([]);
  });
});
