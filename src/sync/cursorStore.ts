import * as fs from 'node:fs';
import { writeFileAtomic } from '../core/atomicWrite';

export const CURSOR_VERSION = 1;

export interface Cursor {
  cursorVersion: number;
  lastSyncedFactKeys: string[];
  lastRunAt: string;
  factCountAtLastSuccessfulSync: number;
}

export interface CursorReadResult {
  cursor: Cursor;
  wasReset: boolean;
  resetReason?: string;
}

function emptyCursor(): Cursor {
  return { cursorVersion: CURSOR_VERSION, lastSyncedFactKeys: [], lastRunAt: '', factCountAtLastSuccessfulSync: 0 };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

export function readCursor(cursorPath: string): CursorReadResult {
  if (!fs.existsSync(cursorPath)) {
    return { cursor: emptyCursor(), wasReset: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(cursorPath, 'utf-8'));
  } catch {
    return { cursor: emptyCursor(), wasReset: true, resetReason: `cursor JSON parse failure at "${cursorPath}"` };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return {
      cursor: emptyCursor(),
      wasReset: true,
      resetReason: `cursor JSON parsed to non-object value at "${cursorPath}"`,
    };
  }

  const candidate = parsed as Partial<Cursor>;

  if (candidate.cursorVersion !== CURSOR_VERSION) {
    return {
      cursor: emptyCursor(),
      wasReset: true,
      resetReason: `unsupported cursorVersion ${JSON.stringify(candidate.cursorVersion)} at "${cursorPath}" (expected ${CURSOR_VERSION})`,
    };
  }

  if (!isStringArray(candidate.lastSyncedFactKeys)) {
    return {
      cursor: emptyCursor(),
      wasReset: true,
      resetReason: `lastSyncedFactKeys is not an array of strings at "${cursorPath}"`,
    };
  }

  return {
    cursor: {
      cursorVersion: candidate.cursorVersion,
      lastSyncedFactKeys: candidate.lastSyncedFactKeys,
      lastRunAt: typeof candidate.lastRunAt === 'string' ? candidate.lastRunAt : '',
      factCountAtLastSuccessfulSync:
        typeof candidate.factCountAtLastSuccessfulSync === 'number' ? candidate.factCountAtLastSuccessfulSync : 0,
    },
    wasReset: false,
  };
}

export function diffNewFactKeys(cursor: Cursor, currentKeys: string[]): string[] {
  const known = new Set(cursor.lastSyncedFactKeys);
  return currentKeys.filter((key) => !known.has(key));
}

export function writeCursor(cursorPath: string, cursor: Cursor): void {
  writeFileAtomic(cursorPath, JSON.stringify(cursor, null, 2));
}
