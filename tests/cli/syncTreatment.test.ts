import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runSyncTreatment } from '../../src/cli/commands/syncTreatment';

function makeVault(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-sync-vault-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ default_scoring_adapter: 'stub', promotion_threshold: 80, actor_source: 'cli-only', time_source: 'system' }));
  return root;
}

function makeNarrative(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-sync-narrative-'));
  fs.mkdirSync(path.join(root, 'treatment'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'treatment', 'CIC_SOURCING_DEPENDENCY_MAP_v1.json'),
    JSON.stringify({ matchSchemaVersion: 1, items: [{ id: 'V-5.3', beat: '5.3', claim: 'Sorensen visits Willow Run' }] })
  );
  return root;
}

function writeTopicExtract(vaultRoot: string, topic: string, facts: unknown[]): void {
  const dir = path.join(vaultRoot, 'topics', 'charlie', topic, 'extracts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'extract.json'), JSON.stringify({ facts }));
}

describe('runSyncTreatment', () => {
  let vaultRoot: string;
  let narrativeRoot: string;

  beforeEach(() => {
    vaultRoot = makeVault();
    narrativeRoot = makeNarrative();
  });

  afterEach(() => {
    fs.rmSync(vaultRoot, { recursive: true, force: true });
    fs.rmSync(narrativeRoot, { recursive: true, force: true });
  });

  it('writes a report with new facts and updates the cursor on first run', () => {
    writeTopicExtract(vaultRoot, 'willow-run', [
      { id: 'FCT-001', text: 'Sorensen visits Willow Run.', source_id: 'SRC-001', confidence: 0.9, categories: ['biography'] },
    ]);

    const result = runSyncTreatment({ vaultRoot, narrativeRoot, topic: 'willow-run' });

    expect(result.exitCode).toBe(0);
    const md = fs.readFileSync(result.reportPath, 'utf-8');
    expect(md).toMatch(/Sorensen visits Willow Run/);
  });

  it('report contains the new fact and cursor file now lists its factKey', () => {
    writeTopicExtract(vaultRoot, 'willow-run', [
      { id: 'FCT-001', text: 'Sorensen visits Willow Run.', source_id: 'SRC-001', confidence: 0.9, categories: ['biography'] },
    ]);

    const result = runSyncTreatment({ vaultRoot, narrativeRoot, topic: 'willow-run' });
    const md = fs.readFileSync(result.reportPath, 'utf-8');
    expect(md).toMatch(/Sorensen visits Willow Run/);

    const cursorPath = path.join(vaultRoot, 'topics', 'charlie', 'willow-run', '.sync-cursor.json');
    const cursor = JSON.parse(fs.readFileSync(cursorPath, 'utf-8'));
    expect(cursor.lastSyncedFactKeys).toHaveLength(1);
  });

  it('rerun immediately after produces "No new facts detected." and leaves the cursor unchanged', () => {
    writeTopicExtract(vaultRoot, 'willow-run', [
      { id: 'FCT-001', text: 'Sorensen visits Willow Run.', source_id: 'SRC-001', confidence: 0.9, categories: ['biography'] },
    ]);
    runSyncTreatment({ vaultRoot, narrativeRoot, topic: 'willow-run' });

    const cursorPath = path.join(vaultRoot, 'topics', 'charlie', 'willow-run', '.sync-cursor.json');
    const cursorBefore = fs.readFileSync(cursorPath, 'utf-8');

    const second = runSyncTreatment({ vaultRoot, narrativeRoot, topic: 'willow-run' });
    expect(fs.readFileSync(second.reportPath, 'utf-8')).toMatch(/No new facts detected\./);
    expect(fs.readFileSync(cursorPath, 'utf-8')).toBe(cursorBefore);
  });

  it('skips a topic with malformed extract.json, reports exit code 2, and continues other topics', () => {
    fs.mkdirSync(path.join(vaultRoot, 'topics', 'charlie', 'cuba', 'extracts'), { recursive: true });
    fs.writeFileSync(path.join(vaultRoot, 'topics', 'charlie', 'cuba', 'extracts', 'extract.json'), '{not json');
    writeTopicExtract(vaultRoot, 'willow-run', [
      { id: 'FCT-001', text: 'Sorensen visits Willow Run.', source_id: 'SRC-001', confidence: 0.9, categories: ['biography'] },
    ]);

    const result = runSyncTreatment({ vaultRoot, narrativeRoot });
    expect(result.exitCode).toBe(2);
    const md = fs.readFileSync(result.reportPath, 'utf-8');
    expect(md).toMatch(/## Skipped topics/);
    expect(md).toMatch(/cuba/);
    expect(md).toMatch(/Sorensen visits Willow Run/);
  });

  it('reports zero-topics case cleanly when no topic directories exist', () => {
    const result = runSyncTreatment({ vaultRoot, narrativeRoot });
    expect(result.exitCode).toBe(0);
    const md = fs.readFileSync(result.reportPath, 'utf-8');
    expect(md).toMatch(/No new facts detected\.|No topics found\./);
  });

  it('skips a topic with a factKey collision instead of merging the facts', () => {
    writeTopicExtract(vaultRoot, 'willow-run', [
      { id: 'FCT-001', text: 'Same text here.', source_id: 'SRC-001', confidence: 0.9, categories: [] },
      { id: 'FCT-002', text: 'Same text here.', source_id: 'SRC-001', confidence: 0.9, categories: [] },
    ]);

    const result = runSyncTreatment({ vaultRoot, narrativeRoot, topic: 'willow-run' });
    expect(result.exitCode).toBe(2);
    const md = fs.readFileSync(result.reportPath, 'utf-8');
    expect(md).toMatch(/## Skipped topics/);
    expect(md).toMatch(/willow-run/);
  });

  it.todo('near-identical facts from separate source documents are collapsed or flagged by a production dedup/scoring entry point; none exists in current src/scoring or src/registry');

  it('--dry-run writes a report but does not update the cursor', () => {
    writeTopicExtract(vaultRoot, 'willow-run', [
      { id: 'FCT-001', text: 'Sorensen visits Willow Run.', source_id: 'SRC-001', confidence: 0.9, categories: ['biography'] },
    ]);

    const result = runSyncTreatment({ vaultRoot, narrativeRoot, topic: 'willow-run', dryRun: true });
    expect(path.basename(result.reportPath)).toMatch(/DRYRUN/);

    const cursorPath = path.join(vaultRoot, 'topics', 'charlie', 'willow-run', '.sync-cursor.json');
    expect(fs.existsSync(cursorPath)).toBe(false);
  });

  it('resets a malformed cursor for one topic without affecting others', () => {
    writeTopicExtract(vaultRoot, 'willow-run', [
      { id: 'FCT-001', text: 'Sorensen visits Willow Run.', source_id: 'SRC-001', confidence: 0.9, categories: ['biography'] },
    ]);
    writeTopicExtract(vaultRoot, 'cuba', [
      { id: 'FCT-001', text: 'Sorensen visits Cuba.', source_id: 'SRC-002', confidence: 0.9, categories: ['biography'] },
    ]);
    runSyncTreatment({ vaultRoot, narrativeRoot }); // establishes both cursors

    const willowCursorPath = path.join(vaultRoot, 'topics', 'charlie', 'willow-run', '.sync-cursor.json');
    fs.writeFileSync(willowCursorPath, '{not json');

    const result = runSyncTreatment({ vaultRoot, narrativeRoot });
    expect(result.exitCode).toBe(0); // reset alone doesn't set partialRun/exit 2
    const md = fs.readFileSync(result.reportPath, 'utf-8');
    expect(md).toMatch(/## Cursor resets/);
    expect(md).toMatch(/willow-run/);
  });

  it('produces byte-identical report content across two runs given the same fixture state', () => {
    writeTopicExtract(vaultRoot, 'willow-run', [
      { id: 'FCT-001', text: 'Sorensen visits Willow Run.', source_id: 'SRC-001', confidence: 0.9, categories: ['biography'] },
    ]);

    const first = runSyncTreatment({ vaultRoot, narrativeRoot, topic: 'willow-run', dryRun: true });
    const firstBody = fs.readFileSync(first.reportPath, 'utf-8').replace(/runId: .*/, 'runId: X').replace(/runAt: .*/, 'runAt: X');

    fs.rmSync(path.join(vaultRoot, 'topics', 'charlie', 'willow-run', '.sync-cursor.json'), { force: true });
    const second = runSyncTreatment({ vaultRoot, narrativeRoot, topic: 'willow-run', dryRun: true });
    const secondBody = fs.readFileSync(second.reportPath, 'utf-8').replace(/runId: .*/, 'runId: X').replace(/runAt: .*/, 'runAt: X');

    expect(firstBody).toBe(secondBody);
  });

  it('exits 2 and reports the failure when a cursor write fails after the report is written', () => {
    writeTopicExtract(vaultRoot, 'willow-run', [
      { id: 'FCT-001', text: 'Sorensen visits Willow Run.', source_id: 'SRC-001', confidence: 0.9, categories: ['biography'] },
    ]);

    // Windows: a directory's read-only attribute does not reliably block file creation inside it
    // the way POSIX permission bits do, so the cursor write may still succeed. Force the failure
    // deterministically instead by making fs.writeFileSync throw only for the cursor's temp file
    // (the atomic-write helper writes to "<cursorPath>.tmp-..." before renaming into place), so the
    // report write (already completed by this point) and the lock file write are unaffected.
    // `import * as fs` bindings compiled by ts-jest expose a non-configurable getter, so
    // Object.defineProperty/jest.spyOn on that binding throws "Cannot redefine property".
    // Grabbing the module via a runtime require() instead returns the real, mutable module
    // object that every other file's static `fs` import reads through to live, so mutating
    // it here propagates to atomicWrite.ts without needing to touch this file's own binding.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rawFs = require('fs');
    const realWriteFileSync = rawFs.writeFileSync;
    const cursorPath = path.join(vaultRoot, 'topics', 'charlie', 'willow-run', '.sync-cursor.json');
    Object.defineProperty(rawFs, 'writeFileSync', {
      configurable: true,
      writable: true,
      value: (file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
        if (typeof file === 'string' && file.startsWith(`${cursorPath}.tmp-`)) {
          throw new Error('disk full');
        }
        return realWriteFileSync(file, data, options);
      },
    });

    try {
      const result = runSyncTreatment({ vaultRoot, narrativeRoot, topic: 'willow-run' });
      expect(result.exitCode).toBe(2);
      expect(result.stderr.some((line) => line.includes('cursor write failed'))).toBe(true);
      expect(fs.existsSync(result.reportPath)).toBe(true);
    } finally {
      Object.defineProperty(rawFs, 'writeFileSync', { configurable: true, writable: true, value: realWriteFileSync });
    }
  });
});
