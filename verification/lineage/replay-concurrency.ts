import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendOperation, readLineage } from '../../src/lineage/hasher';
import { LockConflictError } from '../../src/sync/lock';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-lineage-replay-'));
const originalExists = fs.existsSync;
const mutableFs = fs as { existsSync: typeof fs.existsSync };
let nested = false;
let nestedError: unknown;

try {
  mutableFs.existsSync = ((file: fs.PathLike) => {
    if (!nested && String(file).endsWith(`${path.sep}lineage.json`)) {
      nested = true;
      try {
        appendOperation(root, 'cuba', { op: 'EXTRACT', actor: 'B', timestamp: 't2' }, { source_id: 'B' });
      } catch (err) {
        nestedError = err;
      }
    }
    return originalExists.call(fs, file);
  }) as typeof fs.existsSync;

  appendOperation(root, 'cuba', { op: 'INGEST', actor: 'A', timestamp: 't1' }, { source_id: 'A' });
  const lineage = readLineage(root, 'cuba');
  assert.ok(nestedError instanceof LockConflictError, `the second append must be rejected while the first holds the topic lock: ${String(nestedError)}`);
  assert.equal(lineage.operations.length, 1, 'the rejected append must not overwrite the successful append');
  assert.equal(lineage.operations[0].actor, 'A');
  console.log('replayed lost-update trace: concurrent append was rejected and the successful operation remained persisted');
} finally {
  mutableFs.existsSync = originalExists;
  fs.rmSync(root, { recursive: true, force: true });
}
