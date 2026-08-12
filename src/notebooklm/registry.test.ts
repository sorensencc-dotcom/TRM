import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  registryPath,
  readRegistry,
  findNotebook,
  sourceKey,
  noteKey,
  checkItem,
  flushPulledHash,
  flushQuarantine,
  flushIngestedAt,
  RegistryFile,
} from './registry';

function seedRegistry(root: string, registry: RegistryFile): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(registryPath(root), JSON.stringify(registry, null, 2));
}

describe('registry', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-nlmregistry-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('readRegistry returns an empty registry when the file does not exist', () => {
    expect(readRegistry(root)).toEqual({ version: 1, notebooks: [] });
  });

  it('sourceKey and noteKey are namespaced and cannot collide', () => {
    expect(sourceKey('abc')).toBe('source:abc');
    expect(noteKey('abc')).toBe('note:abc');
    expect(sourceKey('abc')).not.toBe(noteKey('abc'));
  });

  it('checkItem classifies new, unchanged, and changed items', () => {
    const entry = {
      notebook_id: 'nb-1',
      title: 'T',
      url: 'https://x',
      last_pulled_hashes: { 'source:s1': 'hash-a' },
      quarantined: {},
      last_ingested_at: null,
      last_mined_at: null,
      last_mined_answer_keys: [],
    };

    expect(checkItem(entry, 'source:new', 'hash-z')).toBe('new');
    expect(checkItem(entry, 'source:s1', 'hash-a')).toBe('unchanged');
    expect(checkItem(entry, 'source:s1', 'hash-b')).toBe('changed');
  });

  it('checkItem classifies quarantined-same vs quarantined-retry', () => {
    const entry = {
      notebook_id: 'nb-1',
      title: 'T',
      url: 'https://x',
      last_pulled_hashes: {},
      quarantined: {
        'source:bad': { hash: 'hash-empty', reason: 'empty content', first_seen_at: 't0', last_seen_at: 't0', attempts: 1 },
      },
      last_ingested_at: null,
      last_mined_at: null,
      last_mined_answer_keys: [],
    };

    expect(checkItem(entry, 'source:bad', 'hash-empty')).toBe('quarantined-same');
    expect(checkItem(entry, 'source:bad', 'hash-now-real-content')).toBe('quarantined-retry');
  });

  it('flushPulledHash updates one key via atomic write without disturbing others', () => {
    seedRegistry(root, {
      version: 1,
      notebooks: [
        {
          notebook_id: 'nb-1',
          title: 'T',
          url: 'https://x',
          last_pulled_hashes: { 'source:s1': 'old-hash' },
          quarantined: {},
          last_ingested_at: null,
          last_mined_at: null,
          last_mined_answer_keys: [],
        },
      ],
    });

    flushPulledHash(root, 'nb-1', 'source:s2', 'new-hash');

    const registry = readRegistry(root);
    const entry = findNotebook(registry, 'nb-1')!;
    expect(entry.last_pulled_hashes).toEqual({ 'source:s1': 'old-hash', 'source:s2': 'new-hash' });
  });

  it('flushQuarantine writes a quarantine entry and increments attempts on repeat', () => {
    seedRegistry(root, {
      version: 1,
      notebooks: [
        {
          notebook_id: 'nb-1', title: 'T', url: 'https://x',
          last_pulled_hashes: {}, quarantined: {},
          last_ingested_at: null, last_mined_at: null, last_mined_answer_keys: [],
        },
      ],
    });

    flushQuarantine(root, 'nb-1', 'source:bad', 'hash-empty', 'empty content', '2026-08-12T00:00:00.000Z');
    flushQuarantine(root, 'nb-1', 'source:bad', 'hash-empty', 'empty content', '2026-08-13T00:00:00.000Z');

    const entry = findNotebook(readRegistry(root), 'nb-1')!;
    expect(entry.quarantined['source:bad']).toEqual({
      hash: 'hash-empty',
      reason: 'empty content',
      first_seen_at: '2026-08-12T00:00:00.000Z',
      last_seen_at: '2026-08-13T00:00:00.000Z',
      attempts: 2,
    });
  });

  it('flushIngestedAt clears a quarantine entry when a fresh hash succeeds and updates last_ingested_at', () => {
    seedRegistry(root, {
      version: 1,
      notebooks: [
        {
          notebook_id: 'nb-1', title: 'T', url: 'https://x',
          last_pulled_hashes: {},
          quarantined: { 'source:bad': { hash: 'h', reason: 'r', first_seen_at: 't', last_seen_at: 't', attempts: 1 } },
          last_ingested_at: null, last_mined_at: null, last_mined_answer_keys: [],
        },
      ],
    });

    flushIngestedAt(root, 'nb-1', '2026-08-12T00:00:00.000Z');

    const entry = findNotebook(readRegistry(root), 'nb-1')!;
    expect(entry.last_ingested_at).toBe('2026-08-12T00:00:00.000Z');
  });
});
