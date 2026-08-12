import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pullAndStage } from './ingestNotebooklm';
import * as nlmCli from '../../notebooklm/nlmCli';
import { readRegistry, registryPath, flushPulledHash } from '../../notebooklm/registry';
import { findMostRecentRunReport } from '../../notebooklm/runReport';

jest.mock('../../notebooklm/nlmCli');

function seedRegistry(root: string): void {
  fs.writeFileSync(
    registryPath(root),
    JSON.stringify({
      version: 1,
      notebooks: [
        {
          notebook_id: 'nb-1',
          title: 'CIC-KB',
          url: 'https://notebooklm.google.com/notebook/nb-1',
          last_pulled_hashes: {},
          quarantined: {},
          last_ingested_at: null,
          last_mined_at: null,
          last_mined_answer_keys: [],
        },
      ],
    })
  );
}

describe('pullAndStage', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-nlmingest-'));
    seedRegistry(root);
    jest.resetAllMocks();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('stages a new source and a new note as physical files under intake/notebooklm/', () => {
    (nlmCli.listSources as jest.Mock).mockReturnValue({
      ok: true,
      data: [{ id: 'src-1', title: 'Willow Run Plant', type: 'web_page', url: 'https://example.com/a' }],
    });
    (nlmCli.getSourceContent as jest.Mock).mockReturnValue({ ok: true, data: 'Real source content.' });
    (nlmCli.listNotes as jest.Mock).mockReturnValue({
      ok: true,
      data: [{ id: 'note-1', title: 'Discovery', content: 'A curated finding.' }],
    });

    const staged = pullAndStage(root, 'nb-1', 'run-1');

    expect(staged).toHaveLength(2);
    const sourceItem = staged.find((s) => s.key === 'source:src-1')!;
    expect(fs.readFileSync(path.join(root, sourceItem.relativePath), 'utf-8')).toBe('Real source content.');
    expect(sourceItem.origin).toBe('notebooklm');

    const noteItem = staged.find((s) => s.key === 'note:note-1')!;
    expect(fs.readFileSync(path.join(root, noteItem.relativePath), 'utf-8')).toBe('A curated finding.');
  });

  it('marks a youtube-typed source as derived provenance with a marker line', () => {
    (nlmCli.listSources as jest.Mock).mockReturnValue({
      ok: true,
      data: [{ id: 'src-yt', title: 'Bomber Plant Footage', type: 'youtube', url: 'https://youtube.com/x' }],
    });
    (nlmCli.getSourceContent as jest.Mock).mockReturnValue({ ok: true, data: 'Derived summary text.' });
    (nlmCli.listNotes as jest.Mock).mockReturnValue({ ok: true, data: [] });

    const staged = pullAndStage(root, 'nb-1', 'run-1');

    expect(staged[0].origin).toBe('notebooklm-derived');
    const content = fs.readFileSync(path.join(root, staged[0].relativePath), 'utf-8');
    expect(content.split('\n')[0]).toBe('<!-- provenance: derived -->');
  });

  it('skips a source whose content hash is unchanged from the registry', () => {
    (nlmCli.listSources as jest.Mock).mockReturnValue({
      ok: true,
      data: [{ id: 'src-1', title: 'Willow Run Plant', type: 'web_page', url: 'https://example.com/a' }],
    });
    (nlmCli.getSourceContent as jest.Mock).mockReturnValue({ ok: true, data: 'Unchanged content.' });
    (nlmCli.listNotes as jest.Mock).mockReturnValue({ ok: true, data: [] });

    // pullAndStage alone no longer flushes the pulled hash into the
    // registry (see C3 in the final-review fix report) -- that only
    // happens once runIngestNotebooklm confirms the item's `trm ingest`
    // step succeeded. Simulate that confirmed-ingested state directly so
    // this test still exercises checkItem()'s dedup behavior on a genuinely
    // unchanged item.
    const firstRun = pullAndStage(root, 'nb-1', 'run-1');
    flushPulledHash(root, 'nb-1', firstRun[0].key, firstRun[0].hash);
    const secondRun = pullAndStage(root, 'nb-1', 'run-2');

    expect(secondRun).toHaveLength(0);
  });

  it('re-stages the same content on a second pullAndStage call when the prior run never confirmed ingest (C3)', () => {
    (nlmCli.listSources as jest.Mock).mockReturnValue({
      ok: true,
      data: [{ id: 'src-1', title: 'Willow Run Plant', type: 'web_page', url: 'https://example.com/a' }],
    });
    (nlmCli.getSourceContent as jest.Mock).mockReturnValue({ ok: true, data: 'Content that never got ingested.' });
    (nlmCli.listNotes as jest.Mock).mockReturnValue({ ok: true, data: [] });

    const firstRun = pullAndStage(root, 'nb-1', 'run-1');
    expect(firstRun).toHaveLength(1);

    // No flushPulledHash call happened -- simulating a run where staging
    // succeeded but the downstream `trm ingest` step never confirmed
    // success. The item must be retried, not silently skipped as
    // "unchanged", on the next pull.
    const secondRun = pullAndStage(root, 'nb-1', 'run-2');
    expect(secondRun).toHaveLength(1);
    expect(secondRun[0].key).toBe('source:src-1');
  });

  it('quarantines empty content instead of staging it, and does not re-log unchanged empty content', () => {
    (nlmCli.listSources as jest.Mock).mockReturnValue({
      ok: true,
      data: [{ id: 'src-empty', title: 'Empty Source', type: 'web_page', url: 'https://example.com/e' }],
    });
    (nlmCli.getSourceContent as jest.Mock).mockReturnValue({ ok: true, data: '' });
    (nlmCli.listNotes as jest.Mock).mockReturnValue({ ok: true, data: [] });

    const first = pullAndStage(root, 'nb-1', 'run-1');
    const second = pullAndStage(root, 'nb-1', 'run-2');

    expect(first).toHaveLength(0);
    expect(second).toHaveLength(0);
    expect(fs.existsSync(path.join(root, 'intake', 'notebooklm'))).toBe(false);
  });

  it('records an enumeration failure in the run report instead of silently treating it as empty, without throwing', () => {
    (nlmCli.listSources as jest.Mock).mockReturnValue({ ok: false, error: 'nlm CLI not found on PATH' });
    (nlmCli.listNotes as jest.Mock).mockReturnValue({ ok: true, data: [] });

    const staged = pullAndStage(root, 'nb-1', 'run-1');

    expect(staged).toHaveLength(0);
    const report = findMostRecentRunReport(root)!;
    const enumItem = report.items.find((i) => i.key === 'enumeration:sources');
    expect(enumItem?.status).toBe('failed');
    expect(enumItem?.detail).toMatch(/nlm CLI not found on PATH/);
  });

  it('quarantines a source when getSourceContent returns an MCP-style error, without throwing', () => {
    (nlmCli.listSources as jest.Mock).mockReturnValue({
      ok: true,
      data: [{ id: 'src-bad', title: 'Broken', type: 'web_page', url: 'https://example.com/b' }],
    });
    (nlmCli.getSourceContent as jest.Mock).mockReturnValue({ ok: false, error: 'API error (code 5): NOT_FOUND' });
    (nlmCli.listNotes as jest.Mock).mockReturnValue({ ok: true, data: [] });

    expect(() => pullAndStage(root, 'nb-1', 'run-1')).not.toThrow();
    expect(pullAndStage(root, 'nb-1', 'run-1')).toHaveLength(0);
  });
});

import { runIngestNotebooklm } from './ingestNotebooklm';

describe('runIngestNotebooklm', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-nlmingest-run-'));
    seedRegistry(root);
    jest.resetAllMocks();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('runs triage-intake, route-intake, ingest per staged file, extract per touched topic, then sync-treatment unscoped', () => {
    (nlmCli.listSources as jest.Mock).mockReturnValue({
      ok: true,
      data: [{ id: 'src-1', title: 'Willow Run Plant', type: 'web_page', url: 'https://example.com/a' }],
    });
    (nlmCli.getSourceContent as jest.Mock).mockReturnValue({ ok: true, data: 'Willow Run bomber plant content.' });
    (nlmCli.listNotes as jest.Mock).mockReturnValue({ ok: true, data: [] });

    const calls: string[][] = [];
    const fakeSpawn = jest.fn((cmd: string, args: string[]) => {
      calls.push(args);
      expect(cmd).toBe(process.execPath);
      // args[0] is now the resolved trm CLI entrypoint path; args[1] is the
      // trm subcommand, since runTrm re-invokes trm's own compiled
      // entrypoint via process.execPath instead of spawning the string
      // 'trm' (which cannot resolve on this machine).
      if (args[1] === 'route-intake') {
        return { status: 0, stdout: JSON.stringify({ totalConsidered: 1, byTopic: { willow_run: 1 }, ambiguousCount: 0, runStatus: 'completed' }), stderr: '' };
      }
      if (args[1] === 'triage-intake') {
        return { status: 0, stdout: JSON.stringify({ totalFiles: 1, processedCount: 1, skippedCount: 0, dupCount: 0, failedCount: 0, walkErrorCount: 0, visionFallbackCount: 0, byType: { text: 1 } }), stderr: '' };
      }
      return { status: 0, stdout: '{}', stderr: '' };
    });

    const result = runIngestNotebooklm(root, 'nb-1', { narrativeRoot: 'C:\\dev\\charlie-deep-research', spawn: fakeSpawn as any });

    expect(result.staged).toBe(1);
    expect(result.ok).toBe(true);
    const commands = calls.map((c) => c[1]);
    expect(commands).toEqual(expect.arrayContaining(['triage-intake', 'route-intake', 'sync-treatment']));

    const syncCall = calls.find((c) => c[1] === 'sync-treatment')!;
    expect(syncCall.slice(1)).toEqual(['sync-treatment', '--narrative-root', 'C:\\dev\\charlie-deep-research']);

    // The staged item's hash should now be flushed into the registry, since
    // its ingest step succeeded.
    const registry = readRegistry(root);
    const entry = registry.notebooks.find((n) => n.notebook_id === 'nb-1')!;
    expect(entry.last_pulled_hashes['source:src-1']).toBeDefined();
  });

  it('continues to the next staged file when one ingest call throws', () => {
    (nlmCli.listSources as jest.Mock).mockReturnValue({
      ok: true,
      data: [
        { id: 'src-1', title: 'Good Source', type: 'web_page', url: 'https://example.com/a' },
        { id: 'src-2', title: 'Also Good', type: 'web_page', url: 'https://example.com/b' },
      ],
    });
    (nlmCli.getSourceContent as jest.Mock).mockReturnValue({ ok: true, data: 'Content here.' });
    (nlmCli.listNotes as jest.Mock).mockReturnValue({ ok: true, data: [] });

    let ingestCallCount = 0;
    const fakeSpawn = jest.fn((_cmd: string, args: string[]) => {
      if (args[1] === 'route-intake') {
        return { status: 0, stdout: JSON.stringify({ totalConsidered: 2, byTopic: { willow_run: 2 }, ambiguousCount: 0, runStatus: 'completed' }), stderr: '' };
      }
      if (args[1] === 'ingest') {
        ingestCallCount++;
        if (ingestCallCount === 1) throw new Error('simulated ingest crash');
        return { status: 0, stdout: '{}', stderr: '' };
      }
      return { status: 0, stdout: '{}', stderr: '' };
    });

    let result: ReturnType<typeof runIngestNotebooklm>;
    expect(() => {
      result = runIngestNotebooklm(root, 'nb-1', { narrativeRoot: 'C:\\dev\\charlie-deep-research', spawn: fakeSpawn as any });
    }).not.toThrow();
    expect(ingestCallCount).toBe(2);

    // Gap fix: a per-item ingest failure must surface at the top level, not
    // just in the run report -- otherwise `trm ingest-notebooklm` exits 0
    // even when an item silently failed.
    expect(result!.ok).toBe(false);
    expect(result!.failed).toEqual(['source:src-1']);

    // C3: the first item's ingest call failed -- its content hash must NOT
    // have been flushed into the registry, so it is retried (not
    // permanently marked "unchanged") on the next pullAndStage call with
    // the same content. The second item succeeded, so its hash IS flushed.
    const registry = readRegistry(root);
    const entry = registry.notebooks.find((n) => n.notebook_id === 'nb-1')!;
    expect(entry.last_pulled_hashes['source:src-1']).toBeUndefined();
    expect(entry.last_pulled_hashes['source:src-2']).toBeDefined();

    const retryStaged = pullAndStage(root, 'nb-1', 'retry-run');
    expect(retryStaged.map((s) => s.key)).toEqual(['source:src-1']);
  });

  it('does not route a genuinely unsorted item to the single touched topic via fallback', () => {
    (nlmCli.listSources as jest.Mock).mockReturnValue({
      ok: true,
      data: [
        { id: 'src-1', title: 'Willow Run Plant', type: 'web_page', url: 'https://example.com/a' },
        { id: 'src-2', title: 'Unrelated Item', type: 'web_page', url: 'https://example.com/b' },
      ],
    });
    (nlmCli.getSourceContent as jest.Mock).mockReturnValue({ ok: true, data: 'Some staged content.' });
    (nlmCli.listNotes as jest.Mock).mockReturnValue({ ok: true, data: [] });

    const willowRunRelPath = 'intake/notebooklm/cic-kb/src-1--willow-run-plant.md';
    const unrelatedRelPath = 'intake/notebooklm/cic-kb/src-2--unrelated-item.md';

    const ingestArgs: string[][] = [];
    const fakeSpawn = jest.fn((_cmd: string, args: string[]) => {
      if (args[1] === 'route-intake') {
        // Simulate route-intake's real per-item report: src-1 cleanly matched a
        // topic and was staged; src-2 legitimately matched no keyword and was
        // marked 'unsorted'. Both entries are present in the report -- the
        // single-topic fallback must not override src-2's genuine classification.
        fs.writeFileSync(
          path.join(root, 'intake-routing-report.json'),
          JSON.stringify({
            reportVersion: 1,
            generatedAt: new Date().toISOString(),
            applied: true,
            runStatus: 'completed',
            runId: 'route-run-1',
            totalConsidered: 2,
            byTopic: { willow_run: 1, unsorted: 1 },
            ambiguousCount: 0,
            entries: [
              {
                sourcePath: willowRunRelPath,
                hash: 'h1',
                topic: 'willow_run',
                matchedKeyword: 'willow run',
                ambiguous: false,
                status: 'staged',
                stagedPath: path.join(root, 'topics/charlie/willow_run/_staging-intake-route-run-1/src-1--willow-run-plant.md'),
              },
              {
                sourcePath: unrelatedRelPath,
                hash: 'h2',
                topic: null,
                matchedKeyword: null,
                ambiguous: false,
                status: 'unsorted',
              },
            ],
          })
        );
        return {
          status: 0,
          stdout: JSON.stringify({ totalConsidered: 2, byTopic: { willow_run: 1, unsorted: 1 }, ambiguousCount: 0, runStatus: 'completed' }),
          stderr: '',
        };
      }
      if (args[1] === 'ingest') {
        ingestArgs.push(args);
      }
      return { status: 0, stdout: '{}', stderr: '' };
    });

    runIngestNotebooklm(root, 'nb-1', { narrativeRoot: 'C:\\dev\\charlie-deep-research', spawn: fakeSpawn as any });

    // Only src-1 should have been ingested; src-2 must not be silently routed
    // to willow_run just because it's the only topic touched this run.
    expect(ingestArgs).toHaveLength(1);
    expect(ingestArgs[0]).toEqual(expect.arrayContaining(['Willow Run Plant']));

    const runReport = findMostRecentRunReport(root)!;
    // The item's first record is 'staged' (from pullAndStage); its outcome record
    // (from the routing lookup below) is the last one logged for this key.
    const src2Items = runReport.items.filter((i) => i.key === 'source:src-2');
    const src2Item = src2Items[src2Items.length - 1];
    expect(src2Item?.status).toBe('failed');
    expect(src2Item?.detail).toMatch(/unsorted/i);
  });
});
