import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// copyFileSync/existsSync are non-configurable native methods, so jest.spyOn can't wrap
// them directly (see tests/core/atomicWrite.test.ts for the same constraint). Use a
// module-level mock that conditionally throws for the two crash-simulation tests below,
// falling through to the real implementation otherwise.
let mockCopyFileThrowOnce = false;
let mockExistsSyncThrowPath: string | null = null;

jest.mock('node:fs', () => {
  const actual = jest.requireActual('node:fs');
  return {
    ...actual,
    copyFileSync: (...args: unknown[]) => {
      if (mockCopyFileThrowOnce) {
        mockCopyFileThrowOnce = false;
        throw new Error('simulated copy failure');
      }
      return (actual.copyFileSync as (...a: unknown[]) => unknown)(...args);
    },
    existsSync: (p: unknown) => {
      if (mockExistsSyncThrowPath !== null && p === mockExistsSyncThrowPath) {
        throw new Error('simulated unexpected fs error');
      }
      return (actual.existsSync as (a: unknown) => boolean)(p);
    },
  };
});

import { runRouteIntake } from '../../../src/cli/commands/routeIntake';
import { openIntakeManifest, IntakeEntry } from '../../../src/core/intakeManifest';
import { createNode } from '../../../src/core/topicNode';
import { acquireLock } from '../../../src/sync/lock';

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trm-routeintake-'));
}

function writeConfig(root: string, contents: unknown): string {
  const dir = path.join(root, 'config');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'topic-routing.json');
  fs.writeFileSync(file, JSON.stringify(contents));
  return file;
}

function writeManifestEntry(root: string, entry: Partial<IntakeEntry> & { hash: string; sourcePath: string }): void {
  const session = openIntakeManifest(root);
  session.write({
    batch: 'dump',
    ext: path.extname(entry.sourcePath),
    sizeBytes: 100,
    kind: 'text',
    classifiedType: 'text',
    isDup: false,
    status: 'done',
    classifiedAt: new Date().toISOString(),
    ...entry,
  } as IntakeEntry);
  session.flush();
}

const CONFIG = {
  cuba: ['cuba'],
  'willow-run': ['willow run'],
};

describe('runRouteIntake (dry-run)', () => {
  it('classifies a single unambiguous match and writes a would-stage report entry', async () => {
    const root = makeRoot();
    writeConfig(root, CONFIG);
    writeManifestEntry(root, { hash: 'h1', sourcePath: 'intake/dump/Cuba Trip/photo1.jpg' });

    const summary = await runRouteIntake(root, {});

    expect(summary.runStatus).toBe('completed');
    expect(summary.byTopic.cuba).toBe(1);
    const report = JSON.parse(fs.readFileSync(path.join(root, 'intake-routing-report.json'), 'utf-8'));
    expect(report.applied).toBe(false);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]).toMatchObject({ topic: 'cuba', status: 'would-stage', ambiguous: false });
    // dry-run never touches topics/
    expect(fs.existsSync(path.join(root, 'topics'))).toBe(false);
  });

  it('always includes an unsorted key in byTopic, even when every entry matches a real topic', async () => {
    const root = makeRoot();
    writeConfig(root, CONFIG);
    writeManifestEntry(root, { hash: 'h1', sourcePath: 'intake/dump/Cuba Trip/photo1.jpg' });

    const summary = await runRouteIntake(root, {});

    expect(summary.byTopic.unsorted).toBe(0);
  });

  it('reports no match as unsorted, not ambiguous', async () => {
    const root = makeRoot();
    writeConfig(root, CONFIG);
    writeManifestEntry(root, { hash: 'h1', sourcePath: 'intake/dump/Downloads/random.pdf' });

    const summary = await runRouteIntake(root, {});

    expect(summary.byTopic.unsorted).toBe(1);
    expect(summary.ambiguousCount).toBe(0);
  });

  it('reports a cross-topic tie as unsorted and ambiguous', async () => {
    const root = makeRoot();
    writeConfig(root, { 'topic-a': ['amber gulch'], 'topic-b': ['coral ridge'] });
    writeManifestEntry(root, { hash: 'h1', sourcePath: 'intake/dump/Amber Gulch Coral Ridge/file.jpg' });

    const summary = await runRouteIntake(root, {});

    expect(summary.byTopic.unsorted).toBe(1);
    expect(summary.ambiguousCount).toBe(1);
    const report = JSON.parse(fs.readFileSync(path.join(root, 'intake-routing-report.json'), 'utf-8'));
    expect(report.entries[0].ambiguous).toBe(true);
  });

  it('expands dupPaths into separate report rows, each classified independently', async () => {
    const root = makeRoot();
    writeConfig(root, CONFIG);
    writeManifestEntry(root, {
      hash: 'h1',
      sourcePath: 'intake/dump/Willow Run/scan1.jpg',
      dupPaths: ['intake/dump/Cuba Trip/scan1-copy.jpg'],
    });

    const summary = await runRouteIntake(root, {});

    expect(summary.totalConsidered).toBe(2);
    const report = JSON.parse(fs.readFileSync(path.join(root, 'intake-routing-report.json'), 'utf-8'));
    const topics = report.entries.map((e: { topic: string }) => e.topic).sort();
    expect(topics).toEqual(['cuba', 'willow-run']);
  });

  it('excludes failed-status manifest entries entirely', async () => {
    const root = makeRoot();
    writeConfig(root, CONFIG);
    writeManifestEntry(root, { hash: 'h1', sourcePath: 'intake/dump/Cuba Trip/bad.pdf', status: 'failed', error: 'unsupported extension' });

    const summary = await runRouteIntake(root, {});

    expect(summary.totalConsidered).toBe(0);
  });

  it('throws before classification when a manifest sourcePath escapes root', async () => {
    const root = makeRoot();
    writeConfig(root, CONFIG);
    writeManifestEntry(root, { hash: 'h1', sourcePath: '../outside/evil.jpg' });

    await expect(runRouteIntake(root, {})).rejects.toThrow(/root|escape|outside/i);
    expect(fs.existsSync(path.join(root, 'intake-routing-report.json'))).toBe(false);
  });

  it('throws before reading the manifest when config is missing', async () => {
    const root = makeRoot();
    // no config written
    writeManifestEntry(root, { hash: 'h1', sourcePath: 'intake/dump/Cuba Trip/photo1.jpg' });

    await expect(runRouteIntake(root, {})).rejects.toThrow(/topic-routing/i);
  });

  it('matchedKeyword preserves the config spelling, not the normalized form', async () => {
    const root = makeRoot();
    writeConfig(root, { 'michigan-flight-museum': ['Michigan Flight Museum'] });
    writeManifestEntry(root, { hash: 'h1', sourcePath: 'intake/dump/michigan-flight-museum/photo1.jpg' });

    await runRouteIntake(root, {});

    const report = JSON.parse(fs.readFileSync(path.join(root, 'intake-routing-report.json'), 'utf-8'));
    expect(report.entries[0].matchedKeyword).toBe('Michigan Flight Museum');
  });
});

describe('runRouteIntake (--apply)', () => {
  it('stages a matched file into topics/charlie/<topic>/_staging-intake-<runId>/', async () => {
    const root = makeRoot();
    writeConfig(root, CONFIG);
    createNode(root, 'charlie/cuba', 'ACTOR-TEST');
    const srcDir = path.join(root, 'intake', 'dump', 'Cuba Trip');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'photo1.jpg'), 'bytes');
    writeManifestEntry(root, { hash: 'h1', sourcePath: 'intake/dump/Cuba Trip/photo1.jpg' });

    const summary = await runRouteIntake(root, { apply: true, runId: 'test-run-1' });

    expect(summary.runStatus).toBe('completed');
    const stagedPath = path.join(root, 'topics', 'charlie', 'cuba', '_staging-intake-test-run-1', 'photo1.jpg');
    expect(fs.readFileSync(stagedPath, 'utf-8')).toBe('bytes');
    // original untouched
    expect(fs.readFileSync(path.join(srcDir, 'photo1.jpg'), 'utf-8')).toBe('bytes');
    const report = JSON.parse(fs.readFileSync(path.join(root, 'intake-routing-report.json'), 'utf-8'));
    expect(report.applied).toBe(true);
    expect(report.entries[0]).toMatchObject({ status: 'staged', stagedPath });
  });

  it('never creates a staging directory for unsorted files', async () => {
    const root = makeRoot();
    writeConfig(root, CONFIG);
    const srcDir = path.join(root, 'intake', 'dump', 'Downloads');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'random.pdf'), 'bytes');
    writeManifestEntry(root, { hash: 'h1', sourcePath: 'intake/dump/Downloads/random.pdf' });

    await runRouteIntake(root, { apply: true, runId: 'test-run-2' });

    expect(fs.existsSync(path.join(root, 'topics'))).toBe(false);
  });

  it('resolves a basename collision within one run with a hash suffix', async () => {
    const root = makeRoot();
    writeConfig(root, CONFIG);
    createNode(root, 'charlie/cuba', 'ACTOR-TEST');
    const dirA = path.join(root, 'intake', 'dump', 'Cuba Trip', 'A');
    const dirB = path.join(root, 'intake', 'dump', 'Cuba Trip', 'B');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    fs.writeFileSync(path.join(dirA, 'photo.jpg'), 'aaa');
    fs.writeFileSync(path.join(dirB, 'photo.jpg'), 'bbb');
    writeManifestEntry(root, { hash: 'h1', sourcePath: 'intake/dump/Cuba Trip/A/photo.jpg' });
    writeManifestEntry(root, { hash: 'h2', sourcePath: 'intake/dump/Cuba Trip/B/photo.jpg' });

    await runRouteIntake(root, { apply: true, runId: 'test-run-3' });

    const stagingDir = path.join(root, 'topics', 'charlie', 'cuba', '_staging-intake-test-run-3');
    const staged = fs.readdirSync(stagingDir);
    expect(staged).toHaveLength(2);
    expect(new Set(staged).size).toBe(2); // no overwrite
  });

  it('aborts before staging when a matched topic has no topic.json, but still writes a report', async () => {
    const root = makeRoot();
    writeConfig(root, CONFIG);
    // no createNode call -- 'cuba' topic node deliberately absent
    const srcDir = path.join(root, 'intake', 'dump', 'Cuba Trip');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'photo1.jpg'), 'bytes');
    writeManifestEntry(root, { hash: 'h1', sourcePath: 'intake/dump/Cuba Trip/photo1.jpg' });

    const summary = await runRouteIntake(root, { apply: true, runId: 'test-run-4' });

    expect(summary.runStatus).toBe('preflight-failed');
    expect(fs.existsSync(path.join(root, 'topics', 'charlie', 'cuba'))).toBe(false);
    const report = JSON.parse(fs.readFileSync(path.join(root, 'intake-routing-report.json'), 'utf-8'));
    expect(report.applied).toBe(false);
    expect(report.error).toMatch(/cuba/i);
    expect(report.entries[0].status).toBe('would-stage'); // classification still shown
  });

  it('marks a missing source file as status "missing" without failing the whole run', async () => {
    const root = makeRoot();
    writeConfig(root, CONFIG);
    createNode(root, 'charlie/cuba', 'ACTOR-TEST');
    // note: no file written to disk for this sourcePath
    writeManifestEntry(root, { hash: 'h1', sourcePath: 'intake/dump/Cuba Trip/gone.jpg' });

    const summary = await runRouteIntake(root, { apply: true, runId: 'test-run-5' });

    expect(summary.runStatus).toBe('completed');
    const report = JSON.parse(fs.readFileSync(path.join(root, 'intake-routing-report.json'), 'utf-8'));
    expect(report.entries[0]).toMatchObject({ status: 'missing' });
    expect(report.entries[0].error).toBeDefined();
  });

  it('marks a copy failure as status "failed" and still completes the run for other entries', async () => {
    const root = makeRoot();
    writeConfig(root, CONFIG);
    createNode(root, 'charlie/cuba', 'ACTOR-TEST');
    const srcDir = path.join(root, 'intake', 'dump', 'Cuba Trip');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'photo1.jpg'), 'bytes');
    fs.writeFileSync(path.join(srcDir, 'photo2.jpg'), 'bytes');
    writeManifestEntry(root, { hash: 'h1', sourcePath: 'intake/dump/Cuba Trip/photo1.jpg' });
    writeManifestEntry(root, { hash: 'h2', sourcePath: 'intake/dump/Cuba Trip/photo2.jpg' });

    mockCopyFileThrowOnce = true;

    try {
      const summary = await runRouteIntake(root, { apply: true, runId: 'test-run-6' });
      expect(summary.runStatus).toBe('completed');
      const report = JSON.parse(fs.readFileSync(path.join(root, 'intake-routing-report.json'), 'utf-8'));
      const statuses = report.entries.map((e: { status: string }) => e.status).sort();
      expect(statuses).toEqual(['failed', 'staged']);
    } finally {
      mockCopyFileThrowOnce = false;
    }
  });

  it('fails fast with a lock conflict when a live lock is already held', async () => {
    const root = makeRoot();
    writeConfig(root, CONFIG);
    createNode(root, 'charlie/cuba', 'ACTOR-TEST');
    writeManifestEntry(root, { hash: 'h1', sourcePath: 'intake/dump/Cuba Trip/photo1.jpg' });
    acquireLock(path.join(root, 'intake-routing.lock'), 'other-run');

    await expect(runRouteIntake(root, { apply: true })).rejects.toThrow(/lock/i);
  });

  it('writes a runStatus: "failed" report and releases the lock on an unexpected crash inside the lock-held region', async () => {
    const root = makeRoot();
    writeConfig(root, CONFIG);
    createNode(root, 'charlie/cuba', 'ACTOR-TEST');
    const srcDir = path.join(root, 'intake', 'dump', 'Cuba Trip');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'photo1.jpg'), 'bytes');
    writeManifestEntry(root, { hash: 'h1', sourcePath: 'intake/dump/Cuba Trip/photo1.jpg' });

    // existsSync's per-file "does the source still exist" check sits outside
    // the per-entry try/catch (only copyFileAtomic is guarded there), so a
    // throw here exercises the outer catch -> runStatus: 'failed' path, not
    // the per-entry 'missing'/'failed' path. Mock conditionally on the exact
    // source path -- a blanket mockImplementationOnce would instead intercept
    // loadTopicRoutingConfig's own existsSync check on the config file,
    // which runs first and isn't what this test means to exercise.
    const targetPath = path.join(srcDir, 'photo1.jpg');
    mockExistsSyncThrowPath = targetPath;

    try {
      await expect(runRouteIntake(root, { apply: true, runId: 'test-run-7' })).rejects.toThrow('simulated unexpected fs error');
    } finally {
      mockExistsSyncThrowPath = null;
    }

    const report = JSON.parse(fs.readFileSync(path.join(root, 'intake-routing-report.json'), 'utf-8'));
    expect(report.runStatus).toBe('failed');
    expect(report.error).toMatch(/simulated unexpected fs error/);
    // lock released despite the crash
    expect(fs.existsSync(path.join(root, 'intake-routing.lock'))).toBe(false);
  });
});
