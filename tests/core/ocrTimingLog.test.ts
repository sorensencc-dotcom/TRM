import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendOcrTiming, readOcrTiming } from '../../src/core/ocrTimingLog';

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trm-ocrtiming-'));
}

describe('ocrTimingLog', () => {
  it('returns an empty array when no log file exists yet', () => {
    const root = makeRoot();
    expect(readOcrTiming(root)).toEqual([]);
  });

  it('appends and reads back entries in order', () => {
    const root = makeRoot();
    const entry1 = { schema_version: 1 as const, topic: 'charlie/benson-ford', file: 'a.jpg', source_type: 'jpg', ms: 3200, retries: 0, outcome: 'success' as const, ts: '2026-07-28T00:00:00.000Z' };
    const entry2 = { ...entry1, file: 'b.jpg', ms: 91000, retries: 1, outcome: 'failure' as const };
    appendOcrTiming(root, entry1);
    appendOcrTiming(root, entry2);

    const entries = readOcrTiming(root);
    expect(entries).toEqual([entry1, entry2]);
  });
});
