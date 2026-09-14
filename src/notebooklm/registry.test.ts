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
  questionHash,
  upsertResearchQueueEntry,
  flushResearchQueueEntry,
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

  it('readRegistry normalizes a missing research_queue to an empty object', () => {
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

    const entry = findNotebook(readRegistry(root), 'nb-1')!;
    expect(entry.research_queue).toEqual({});
  });

  it('questionHash is stable for identical text and differs for different text', () => {
    expect(questionHash('What open questions exist?')).toBe(questionHash('What open questions exist?'));
    expect(questionHash('What open questions exist?')).not.toBe(questionHash('Something else?'));
  });

  it('upsertResearchQueueEntry creates a PENDING entry with zeroed counters', () => {
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

    upsertResearchQueueEntry(root, 'nb-1', { id: 'open-contradictions', text: 'What open questions?' }, 'nb-1:open-contradictions:hash', 'fast');

    const entry = findNotebook(readRegistry(root), 'nb-1')!;
    const hash = questionHash('What open questions?');
    expect(entry.research_queue![hash]).toEqual({
      question_hash: hash,
      question_text: 'What open questions?',
      question_id: 'open-contradictions',
      gap_key: 'nb-1:open-contradictions:hash',
      mode: 'fast',
      attempt_count: 0,
      consecutive_dispatch_failures: 0,
      last_researched_at: null,
      last_dispatch_error: null,
      status: 'PENDING',
    });
  });

  it('upsertResearchQueueEntry leaves an existing entry untouched', () => {
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

    upsertResearchQueueEntry(root, 'nb-1', { id: 'q1', text: 'Q' }, 'gap-1', 'fast');
    flushResearchQueueEntry(root, 'nb-1', questionHash('Q'), { attempt_count: 2, status: 'EXECUTED' });
    upsertResearchQueueEntry(root, 'nb-1', { id: 'q1', text: 'Q' }, 'gap-1', 'fast');

    const entry = findNotebook(readRegistry(root), 'nb-1')!;
    expect(entry.research_queue![questionHash('Q')].attempt_count).toBe(2);
    expect(entry.research_queue![questionHash('Q')].status).toBe('EXECUTED');
  });

  it('flushResearchQueueEntry patches only the given fields', () => {
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
    upsertResearchQueueEntry(root, 'nb-1', { id: 'q1', text: 'Q' }, 'gap-1', 'fast');

    flushResearchQueueEntry(root, 'nb-1', questionHash('Q'), { consecutive_dispatch_failures: 1, last_dispatch_error: 'timeout' });

    const entry = findNotebook(readRegistry(root), 'nb-1')!.research_queue![questionHash('Q')];
    expect(entry.consecutive_dispatch_failures).toBe(1);
    expect(entry.last_dispatch_error).toBe('timeout');
    expect(entry.status).toBe('PENDING'); // untouched fields survive the patch
  });

  it('flushResearchQueueEntry throws for an unknown question_hash', () => {
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

    expect(() => flushResearchQueueEntry(root, 'nb-1', 'no-such-hash', { status: 'EXECUTED' })).toThrow(/no entry for question_hash/);
  });

  it('flushResearchQueueEntry accepts web_strategy, imported_source, last_updated_at, and EVIDENCE_IMPORTED status', () => {
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

    upsertResearchQueueEntry(root, 'nb-1', { id: 'q1', text: 'Q' }, 'gap-1', 'fast');
    flushResearchQueueEntry(root, 'nb-1', questionHash('Q'), {
      status: 'EVIDENCE_IMPORTED',
      imported_source: 'gap-q1-evidence.md',
      last_updated_at: '2026-09-14T00:00:00.000Z',
    });

    const entry = findNotebook(readRegistry(root), 'nb-1')!.research_queue![questionHash('Q')];
    expect(entry.status).toBe('EVIDENCE_IMPORTED');
    expect(entry.imported_source).toBe('gap-q1-evidence.md');
    expect(entry.last_updated_at).toBe('2026-09-14T00:00:00.000Z');
  });

  it('upsertResearchQueueEntry accepts an optional web_strategy and defaults it to undefined', () => {
    seedRegistry(root, {
      version: 1,
      notebooks: [
        {
          notebook_id: 'nb-2', title: 'T', url: 'https://x',
          last_pulled_hashes: {}, quarantined: {},
          last_ingested_at: null, last_mined_at: null, last_mined_answer_keys: [],
        },
        {
          notebook_id: 'nb-3', title: 'T', url: 'https://x',
          last_pulled_hashes: {}, quarantined: {},
          last_ingested_at: null, last_mined_at: null, last_mined_answer_keys: [],
        },
      ],
    });

    upsertResearchQueueEntry(root, 'nb-2', { id: 'q2', text: 'Q2' }, 'gap-2', 'fast', 'web');
    const entry = findNotebook(readRegistry(root), 'nb-2')!.research_queue![questionHash('Q2')];
    expect(entry.web_strategy).toBe('web');

    upsertResearchQueueEntry(root, 'nb-3', { id: 'q3', text: 'Q3' }, 'gap-3', 'fast');
    const entryNoStrategy = findNotebook(readRegistry(root), 'nb-3')!.research_queue![questionHash('Q3')];
    expect(entryNoStrategy.web_strategy).toBeUndefined();
  });
});
