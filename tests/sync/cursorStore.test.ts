import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readCursor, writeCursor, diffNewFactKeys, CURSOR_VERSION, Cursor } from '../../src/sync/cursorStore';

describe('readCursor', () => {
  let dir: string;
  let cursorPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-cursor-'));
    cursorPath = path.join(dir, '.sync-cursor.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns an empty cursor with no reset when the file does not exist', () => {
    const { cursor, wasReset } = readCursor(cursorPath);
    expect(cursor.lastSyncedFactKeys).toEqual([]);
    expect(wasReset).toBe(false);
  });

  it('reads back a valid cursor unchanged', () => {
    const written: Cursor = {
      cursorVersion: CURSOR_VERSION,
      lastSyncedFactKeys: ['abc123'],
      lastRunAt: '2026-07-28T00:00:00.000Z',
      factCountAtLastSuccessfulSync: 1,
    };
    fs.writeFileSync(cursorPath, JSON.stringify(written));
    const { cursor, wasReset } = readCursor(cursorPath);
    expect(cursor).toEqual(written);
    expect(wasReset).toBe(false);
  });

  it('resets on invalid JSON', () => {
    fs.writeFileSync(cursorPath, '{not json');
    const { cursor, wasReset, resetReason } = readCursor(cursorPath);
    expect(cursor.lastSyncedFactKeys).toEqual([]);
    expect(wasReset).toBe(true);
    expect(resetReason).toMatch(/parse/i);
  });

  it('resets on an unsupported cursorVersion', () => {
    fs.writeFileSync(cursorPath, JSON.stringify({ cursorVersion: 99, lastSyncedFactKeys: ['x'], lastRunAt: '', factCountAtLastSuccessfulSync: 1 }));
    const { cursor, wasReset, resetReason } = readCursor(cursorPath);
    expect(cursor.lastSyncedFactKeys).toEqual([]);
    expect(wasReset).toBe(true);
    expect(resetReason).toMatch(/version/i);
  });

  it('resets when lastSyncedFactKeys is not an array of strings', () => {
    fs.writeFileSync(cursorPath, JSON.stringify({ cursorVersion: 1, lastSyncedFactKeys: 'not-an-array', lastRunAt: '', factCountAtLastSuccessfulSync: 0 }));
    const { wasReset, resetReason } = readCursor(cursorPath);
    expect(wasReset).toBe(true);
    expect(resetReason).toMatch(/lastSyncedFactKeys/);
  });
});

describe('diffNewFactKeys', () => {
  it('returns keys not present in the cursor', () => {
    const cursor: Cursor = { cursorVersion: 1, lastSyncedFactKeys: ['a', 'b'], lastRunAt: '', factCountAtLastSuccessfulSync: 2 };
    expect(diffNewFactKeys(cursor, ['a', 'b', 'c'])).toEqual(['c']);
  });

  it('returns empty array when everything is already synced', () => {
    const cursor: Cursor = { cursorVersion: 1, lastSyncedFactKeys: ['a', 'b'], lastRunAt: '', factCountAtLastSuccessfulSync: 2 };
    expect(diffNewFactKeys(cursor, ['a', 'b'])).toEqual([]);
  });

  it('returns all keys when the cursor is empty', () => {
    const cursor: Cursor = { cursorVersion: 1, lastSyncedFactKeys: [], lastRunAt: '', factCountAtLastSuccessfulSync: 0 };
    expect(diffNewFactKeys(cursor, ['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('writeCursor', () => {
  let dir: string;
  let cursorPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-cursor-write-'));
    cursorPath = path.join(dir, '.sync-cursor.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes a cursor that reads back identically', () => {
    const cursor: Cursor = {
      cursorVersion: CURSOR_VERSION,
      lastSyncedFactKeys: ['a', 'b', 'c'],
      lastRunAt: '2026-07-28T12:00:00.000Z',
      factCountAtLastSuccessfulSync: 3,
    };
    writeCursor(cursorPath, cursor);
    expect(readCursor(cursorPath).cursor).toEqual(cursor);
  });
});
