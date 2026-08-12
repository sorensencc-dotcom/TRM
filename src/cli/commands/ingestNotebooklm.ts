import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { listSources, getSourceContent, listNotes } from '../../notebooklm/nlmCli';
import { spawnSync as realSpawnSync } from 'node:child_process';
import { readRegistry, findNotebook, sourceKey, noteKey, checkItem, flushPulledHash, flushQuarantine, flushIngestedAt } from '../../notebooklm/registry';
import { stagingRelativePath } from '../../notebooklm/stagingName';
import { createRunReport, recordItem } from '../../notebooklm/runReport';

export interface StagedItem {
  key: string;
  relativePath: string;
  title: string;
  sourceUrl: string | null;
  origin: 'notebooklm' | 'notebooklm-derived';
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

function notebookSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function writeStaged(root: string, relativePath: string, content: string): void {
  const absPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}

export function pullAndStage(root: string, notebookId: string, runId: string): StagedItem[] {
  const registry = readRegistry(root);
  const entry = findNotebook(registry, notebookId);
  if (!entry) {
    throw new Error(`notebooklm-registry.json has no entry for notebook "${notebookId}"`);
  }

  const now = new Date().toISOString();
  createRunReport(root, runId, notebookId, now);
  const slug = notebookSlug(entry.title);
  const staged: StagedItem[] = [];

  const sourcesResult = listSources(notebookId);
  const sources = sourcesResult.ok ? sourcesResult.data : [];

  for (const source of sources) {
    const key = sourceKey(source.id);
    const contentResult = getSourceContent(source.id);

    if (!contentResult.ok) {
      flushQuarantine(root, notebookId, key, hashContent(''), contentResult.error, now);
      recordItem(root, runId, { key, status: 'quarantined', detail: contentResult.error });
      continue;
    }

    const content = contentResult.data;
    const hash = hashContent(content);
    const status = checkItem(entry, key, hash);

    if (status === 'unchanged' || status === 'quarantined-same') continue;

    if (content.trim().length === 0) {
      flushQuarantine(root, notebookId, key, hash, 'empty content', now);
      recordItem(root, runId, { key, status: 'quarantined', detail: 'empty content' });
      continue;
    }

    const isDerived = source.type === 'youtube';
    const relativePath = stagingRelativePath(slug, source.id, source.title);
    const fileContent = isDerived ? `<!-- provenance: derived -->\n${content}` : content;
    writeStaged(root, relativePath, fileContent);
    flushPulledHash(root, notebookId, key, hash);
    recordItem(root, runId, { key, status: 'staged' });

    staged.push({
      key,
      relativePath,
      title: source.title,
      sourceUrl: source.url,
      origin: isDerived ? 'notebooklm-derived' : 'notebooklm',
    });
  }

  const notesResult = listNotes(notebookId);
  const notes = notesResult.ok ? notesResult.data : [];

  for (const note of notes) {
    const key = noteKey(note.id);
    const hash = hashContent(note.content);
    const status = checkItem(entry, key, hash);

    if (status === 'unchanged' || status === 'quarantined-same') continue;

    if (note.content.trim().length === 0) {
      flushQuarantine(root, notebookId, key, hash, 'empty content', now);
      recordItem(root, runId, { key, status: 'quarantined', detail: 'empty content' });
      continue;
    }

    const relativePath = stagingRelativePath(slug, note.id, note.title);
    writeStaged(root, relativePath, note.content);
    flushPulledHash(root, notebookId, key, hash);
    recordItem(root, runId, { key, status: 'staged' });

    staged.push({
      key,
      relativePath,
      title: note.title,
      sourceUrl: `https://notebooklm.google.com/notebook/${notebookId}?note=${note.id}`,
      origin: 'notebooklm',
    });
  }

  return staged;
}

interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

type SpawnFn = (cmd: string, args: string[], opts?: object) => SpawnResult;

export interface RunIngestOptions {
  narrativeRoot: string;
  spawn?: SpawnFn;
}

export interface RunIngestResult {
  staged: number;
  topicsExtracted: string[];
  syncTreatmentReportPath: string | null;
}

interface RouteReportEntry {
  sourcePath: string;
  topic: string | null;
  stagedPath?: string;
  status: string;
}

function runTrm(root: string, spawn: SpawnFn, args: string[]): SpawnResult {
  return spawn('trm', args, { cwd: root, encoding: 'utf-8' });
}

export function runIngestNotebooklm(root: string, notebookId: string, opts: RunIngestOptions): RunIngestResult {
  const spawn = opts.spawn ?? ((cmd, args, o) => realSpawnSync(cmd, args, { ...o, encoding: 'utf-8' }) as unknown as SpawnResult);
  const runId = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomUUID().slice(0, 8)}`;

  const staged = pullAndStage(root, notebookId, runId);
  if (staged.length === 0) {
    runTrm(root, spawn, ['sync-treatment', '--narrative-root', opts.narrativeRoot]);
    return { staged: 0, topicsExtracted: [], syncTreatmentReportPath: null };
  }

  const notebookSlugDir = path.dirname(staged[0].relativePath); // intake/notebooklm/<slug>
  runTrm(root, spawn, ['triage-intake', '--dir', notebookSlugDir]);
  const routeResult = runTrm(root, spawn, ['route-intake', '--apply']);
  const routeSummary = JSON.parse(routeResult.stdout || '{}') as { byTopic?: Record<string, number> };
  const touchedTopics = Object.keys(routeSummary.byTopic ?? {}).filter((t) => t !== 'unsorted');

  const reportPath = path.join(root, 'intake-routing-report.json');
  let report: { entries: RouteReportEntry[] } | null = null;
  if (fs.existsSync(reportPath)) {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as { entries: RouteReportEntry[] };
  }

  for (const item of staged) {
    let topic: string | null = null;
    let stagedPath: string | null = null;

    const routed = report?.entries.find((e) => e.sourcePath === item.relativePath && e.status === 'staged');
    if (routed) {
      topic = routed.topic;
      stagedPath = routed.stagedPath ?? null;
    } else if (touchedTopics.length === 1) {
      // route-intake's aggregate byTopic makes this the only topic touched --
      // safe to assume this item landed there even without a per-item report entry.
      topic = touchedTopics[0];
    }

    if (!topic) {
      recordItem(root, runId, { key: item.key, status: 'failed', detail: 'unsorted or not staged by route-intake' });
      continue;
    }

    try {
      runTrm(root, spawn, [
        'ingest',
        `topics/charlie/${topic}`,
        item.sourceUrl ?? `local:${item.title}`,
        '--file',
        stagedPath ?? path.join(root, item.relativePath),
        '--type',
        item.origin === 'notebooklm-derived' ? 'notebooklm-source' : item.key.startsWith('note:') ? 'notebooklm-note' : 'notebooklm-source',
        '--title',
        item.title,
        '--origin',
        item.origin,
      ]);
      recordItem(root, runId, { key: item.key, status: 'ingested' });
    } catch (err) {
      recordItem(root, runId, { key: item.key, status: 'failed', detail: (err as Error).message });
      continue;
    }
  }

  for (const topic of touchedTopics) {
    runTrm(root, spawn, ['extract', `topics/charlie/${topic}`]);
  }

  runTrm(root, spawn, ['sync-treatment', '--narrative-root', opts.narrativeRoot]);
  flushIngestedAt(root, notebookId, new Date().toISOString());

  return { staged: staged.length, topicsExtracted: touchedTopics, syncTreatmentReportPath: null };
}
