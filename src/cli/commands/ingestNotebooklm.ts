import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { listSources, getSourceContent, listNotes } from '../../notebooklm/nlmCli';
import { spawnSync as realSpawnSync } from 'node:child_process';
import { readRegistry, findNotebook, sourceKey, noteKey, checkItem, flushPulledHash, flushQuarantine, flushIngestedAt } from '../../notebooklm/registry';
import { stagingRelativePath, isPathContained, slugifyTitle } from '../../notebooklm/stagingName';
import { createRunReport, recordItem, setSyncTreatmentStatus } from '../../notebooklm/runReport';

export interface StagedItem {
  key: string;
  relativePath: string;
  title: string;
  sourceUrl: string | null;
  origin: 'notebooklm' | 'notebooklm-derived';
  hash: string;
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
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
  const slug = slugifyTitle(entry.title);
  const staged: StagedItem[] = [];

  const sourcesResult = listSources(notebookId);
  const sourceList = sourcesResult.ok ? sourcesResult.data : [];
  if (!sourcesResult.ok) {
    recordItem(root, runId, { key: 'enumeration:sources', status: 'failed', detail: `listSources failed: ${sourcesResult.error}` });
  }

  for (const source of sourceList) {
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

    if (!isPathContained(root, relativePath)) {
      flushQuarantine(root, notebookId, key, hash, 'path containment check failed', now);
      recordItem(root, runId, { key, status: 'quarantined', detail: 'path containment check failed' });
      continue;
    }

    const fileContent = isDerived ? `<!-- provenance: derived -->\n${content}` : content;
    writeStaged(root, relativePath, fileContent);
    // Do NOT flush the pulled hash here -- staging a file is not the same as
    // successfully ingesting it. The hash is flushed only after
    // runIngestNotebooklm confirms this specific item's `trm ingest` call
    // succeeded (see C3 in the final-review fix report). An item that fails
    // ingest must keep its old/absent registry hash so the next run's
    // checkItem() sees it as new/changed and retries it, instead of being
    // permanently marked done.
    recordItem(root, runId, { key, status: 'staged' });

    staged.push({
      key,
      relativePath,
      title: source.title,
      sourceUrl: source.url,
      origin: isDerived ? 'notebooklm-derived' : 'notebooklm',
      hash,
    });
  }

  const notesResult = listNotes(notebookId);
  const noteList = notesResult.ok ? notesResult.data : [];
  if (!notesResult.ok) {
    recordItem(root, runId, { key: 'enumeration:notes', status: 'failed', detail: `listNotes failed: ${notesResult.error}` });
  }

  for (const note of noteList) {
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

    if (!isPathContained(root, relativePath)) {
      flushQuarantine(root, notebookId, key, hash, 'path containment check failed', now);
      recordItem(root, runId, { key, status: 'quarantined', detail: 'path containment check failed' });
      continue;
    }

    writeStaged(root, relativePath, note.content);
    recordItem(root, runId, { key, status: 'staged' });

    staged.push({
      key,
      relativePath,
      title: note.title,
      sourceUrl: `https://notebooklm.google.com/notebook/${notebookId}?note=${note.id}`,
      origin: 'notebooklm',
      hash,
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
  ok: boolean;
  error: string | null;
  failed: string[];
}

interface RouteReportEntry {
  sourcePath: string;
  topic: string | null;
  stagedPath?: string;
  status: string;
}

// This module compiles to dist/cli/commands/ingestNotebooklm.js, so
// '../index.js' resolves to dist/cli/index.js -- trm re-invoking its own
// compiled entrypoint via the currently-running Node binary. This is the
// same technique npm's own bin shims use, and it has zero dependency on
// PATH resolution or shell quoting, unlike spawning the string 'trm'
// directly (which cannot resolve on a machine where trm isn't globally
// linked, and even once linked, spawnSync without shell: true will not
// run a .cmd npm shim on Windows).
const TRM_CLI_ENTRYPOINT = path.resolve(__dirname, '../index.js');

function runTrm(root: string, spawn: SpawnFn, args: string[]): SpawnResult {
  return spawn(process.execPath, [TRM_CLI_ENTRYPOINT, ...args], { cwd: root, encoding: 'utf-8' });
}

function checkTrmResult(result: SpawnResult, step: string): void {
  if (result.status !== 0) {
    throw new Error(`trm ${step} failed (exit ${result.status}): ${result.stderr || result.stdout}`);
  }
}

export function runIngestNotebooklm(root: string, notebookId: string, opts: RunIngestOptions): RunIngestResult {
  const spawn = opts.spawn ?? ((cmd, args, o) => realSpawnSync(cmd, args, { ...o, encoding: 'utf-8' }) as unknown as SpawnResult);
  const runId = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomUUID().slice(0, 8)}`;

  const staged = pullAndStage(root, notebookId, runId);

  const runSyncTreatment = (): string | null => {
    let syncResult: SpawnResult;
    try {
      syncResult = runTrm(root, spawn, ['sync-treatment', '--narrative-root', opts.narrativeRoot]);
      checkTrmResult(syncResult, 'sync-treatment');
    } catch (err) {
      setSyncTreatmentStatus(root, runId, 'error');
      recordItem(root, runId, { key: 'sync-treatment', status: 'failed', detail: (err as Error).message });
      return null;
    }
    setSyncTreatmentStatus(root, runId, 'ok');
    // sync-treatment's CLI action prints result.reportPath as the first
    // line of stdout (see src/cli/index.ts's sync-treatment action).
    const firstLine = syncResult.stdout.split('\n')[0]?.trim();
    return firstLine ? firstLine : null;
  };

  if (staged.length === 0) {
    const syncTreatmentReportPath = runSyncTreatment();
    return { staged: 0, topicsExtracted: [], syncTreatmentReportPath, ok: true, error: null, failed: [] };
  }

  const notebookSlugDir = path.dirname(staged[0].relativePath); // intake/notebooklm/<slug>

  const failed: string[] = [];
  let routeSummary: { byTopic?: Record<string, number>; runStatus?: string } | null = null;
  let preRouteError: string | null = null;
  let routeResult: SpawnResult | null = null;

  try {
    const triageResult = runTrm(root, spawn, ['triage-intake', '--dir', notebookSlugDir]);
    checkTrmResult(triageResult, 'triage-intake');

    routeResult = runTrm(root, spawn, ['route-intake', '--apply']);
    checkTrmResult(routeResult, 'route-intake');

    try {
      routeSummary = routeResult.stdout ? (JSON.parse(routeResult.stdout) as { byTopic?: Record<string, number>; runStatus?: string }) : null;
    } catch {
      routeSummary = null;
    }
  } catch (err) {
    // A crash in triage-intake or route-intake before staged items are
    // routed must not silently report `staged: N` as a success -- record
    // every staged item as failed for this run and surface the error at
    // the top level, but don't rethrow: a multi-notebook sweep calling
    // runIngestNotebooklm per notebook must not have one notebook's
    // subprocess crash abort the others.
    preRouteError = (err as Error).message;
    for (const item of staged) {
      recordItem(root, runId, { key: item.key, status: 'failed', detail: `pre-route failure: ${preRouteError}` });
      failed.push(item.key);
    }
  }

  const routeSucceeded = routeSummary !== null && routeSummary.runStatus === 'completed';
  const touchedTopics = routeSucceeded ? Object.keys(routeSummary!.byTopic ?? {}).filter((t) => t !== 'unsorted') : [];

  const reportPath = path.join(root, 'intake-routing-report.json');
  // Only trust the on-disk report for per-item lookups when route-intake's own
  // subprocess output tells us this run actually completed -- otherwise the file
  // may be stale (a prior unrelated run) or absent, and reading it would risk
  // silently misrouting items based on data this run never produced.
  let report: { entries: RouteReportEntry[] } | null = null;
  if (routeSucceeded && fs.existsSync(reportPath)) {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as { entries: RouteReportEntry[] };
  }

  // Topics actually affected by THIS run's successfully-ingested items --
  // not route-intake's vault-wide byTopic summary, which includes every
  // topic that has ever received intake. Bounds the extract sweep below to
  // only what this notebook's pull actually touched.
  const extractTopics = new Set<string>();

  if (!preRouteError) {
    for (const item of staged) {
      let topic: string | null = null;
      let stagedPath: string | null = null;

      if (!routeSucceeded) {
        recordItem(root, runId, { key: item.key, status: 'failed', detail: 'route-intake did not complete successfully this run' });
        failed.push(item.key);
        continue;
      }

      // Look up ANY report entry for this item, regardless of status -- an entry
      // that exists but is 'unsorted' (no topic keyword matched) is a genuine
      // classification from route-intake and must not be overridden by the
      // single-topic fallback below.
      const routed = report?.entries.find((e) => e.sourcePath === item.relativePath);
      if (routed) {
        if (routed.topic && routed.stagedPath) {
          topic = routed.topic;
          stagedPath = routed.stagedPath;
        } else {
          // Present in the report but genuinely unsorted/unstaged -- respect that
          // classification instead of guessing via the single-topic fallback.
          recordItem(root, runId, { key: item.key, status: 'failed', detail: 'unsorted or not staged by route-intake' });
          failed.push(item.key);
          continue;
        }
      } else if (touchedTopics.length === 1) {
        // route-intake gave us no per-item information about this item at all
        // (absent from the report / report file missing) -- and its aggregate
        // byTopic makes this the only topic touched, so it's safe to assume this
        // item landed there.
        topic = touchedTopics[0];
      }

      if (!topic) {
        recordItem(root, runId, { key: item.key, status: 'failed', detail: 'unsorted or not staged by route-intake' });
        failed.push(item.key);
        continue;
      }

      try {
        const ingestResult = runTrm(root, spawn, [
          'ingest',
          `topics/charlie/${topic}`,
          item.sourceUrl ?? `local:${item.title}`,
          '--file',
          stagedPath ?? path.join(root, item.relativePath),
          '--type',
          item.key.startsWith('note:') ? 'notebooklm-note' : 'notebooklm-source',
          '--title',
          item.title,
          '--origin',
          item.origin,
        ]);
        checkTrmResult(ingestResult, 'ingest');
        // Only now -- after the ingest step for THIS item has been confirmed
        // successful -- flush its content hash into the registry. See C3 in
        // the final-review fix report: flushing at stage time meant a failed
        // ingest permanently marked the item "unchanged" on every future run.
        flushPulledHash(root, notebookId, item.key, item.hash);
        recordItem(root, runId, { key: item.key, status: 'ingested' });
        extractTopics.add(topic);
      } catch (err) {
        recordItem(root, runId, { key: item.key, status: 'failed', detail: (err as Error).message });
        failed.push(item.key);
        continue;
      }
    }
  }

  for (const topic of extractTopics) {
    try {
      const extractResult = runTrm(root, spawn, ['extract', `topics/charlie/${topic}`]);
      checkTrmResult(extractResult, 'extract');
      recordItem(root, runId, { key: `topic:${topic}`, status: 'extracted' });
    } catch (err) {
      recordItem(root, runId, { key: `topic:${topic}`, status: 'failed', detail: (err as Error).message });
      failed.push(`topic:${topic}`);
    }
  }

  const syncTreatmentReportPath = runSyncTreatment();
  flushIngestedAt(root, notebookId, new Date().toISOString());

  return {
    staged: staged.length,
    topicsExtracted: Array.from(extractTopics),
    syncTreatmentReportPath,
    ok: preRouteError === null && failed.length === 0,
    error: preRouteError,
    failed,
  };
}
