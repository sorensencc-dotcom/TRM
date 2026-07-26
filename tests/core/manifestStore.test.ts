import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  markDone,
  markFailed,
  isDone,
  writeExtract,
  readExtract,
  listEntries,
} from '../../src/core/manifestStore';

describe('manifestStore', () => {
  let root: string;
  const topicPath = 'test-topic';

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'trm-manifest-test-'));
  });

  afterEach(async () => {
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  it('markDone then isDone returns true for that hash only', () => {
    markDone(root, topicPath, 'hash-a', '/path/a.txt');

    expect(isDone(root, topicPath, 'hash-a')).toBe(true);
    expect(isDone(root, topicPath, 'hash-b')).toBe(false);
  });

  it('markFailed records status=failed, not done', () => {
    markFailed(root, topicPath, 'hash-c', '/path/c.txt', 'boom');

    expect(isDone(root, topicPath, 'hash-c')).toBe(false);
    const entries = listEntries(root, topicPath);
    const entry = entries.find((e: { hash: string }) => e.hash === 'hash-c');
    expect(entry?.status).toBe('failed');
    expect(entry?.error).toBe('boom');
  });

  it('writeExtract then readExtract round-trips the payload', () => {
    writeExtract(root, topicPath, 'hash-d', { facts: [{ id: 'FCT-001' }] });

    const result = readExtract<{ facts: { id: string }[] }>(root, topicPath, 'hash-d');
    expect(result).toEqual({ facts: [{ id: 'FCT-001' }] });
  });

  it('readExtract returns null for an unknown hash', () => {
    expect(readExtract(root, topicPath, 'nonexistent')).toBeNull();
  });

  it('simulated crash-resume: N marked-done hashes survive and are queryable after "restart"', () => {
    // Simulate processing 5 items, killing the process, then "restarting"
    // (a fresh call against the same root/topicPath with no in-memory state).
    const hashes = ['h1', 'h2', 'h3', 'h4', 'h5'];
    for (const h of hashes) {
      markDone(root, topicPath, h, `/path/${h}.txt`);
      writeExtract(root, topicPath, h, { facts: [] });
    }

    // "Restart": fresh reads, no shared state carried over except what's on disk.
    for (const h of hashes) {
      expect(isDone(root, topicPath, h)).toBe(true);
      expect(readExtract(root, topicPath, h)).not.toBeNull();
    }
    expect(listEntries(root, topicPath)).toHaveLength(5);
  });

  it('manifest.json is never left corrupt across sequential writes', () => {
    for (let i = 0; i < 20; i++) {
      markDone(root, topicPath, `hash-${i}`, `/path/${i}.txt`);
    }
    const manifestFile = path.join(root, 'topics', topicPath, 'extracts', 'manifest.json');
    const raw = fs.readFileSync(manifestFile, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(listEntries(root, topicPath)).toHaveLength(20);
  });
});
