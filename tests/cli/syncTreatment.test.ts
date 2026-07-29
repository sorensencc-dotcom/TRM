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
});
