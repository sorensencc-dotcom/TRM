import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runRouteIntake } from '../../../src/cli/commands/routeIntake';
import { openIntakeManifest, IntakeEntry } from '../../../src/core/intakeManifest';

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
