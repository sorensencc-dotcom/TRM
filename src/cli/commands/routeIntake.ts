import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { readIntakeManifest, IntakeEntry } from '../../core/intakeManifest';
import { loadTopicRoutingConfig, classifyPath, normalize } from '../../core/topicRouting';
import { writeFileAtomic, copyFileAtomic } from '../../core/atomicWrite';
import { readTopicMeta } from '../../core/topicNode';
import { acquireLock, releaseLock } from '../../sync/lock';

export type RouteEntryStatus = 'staged' | 'unsorted' | 'missing' | 'failed' | 'would-stage';
export type RouteRunStatus = 'completed' | 'preflight-failed' | 'failed';

export interface RouteReportEntry {
  sourcePath: string;
  hash: string;
  topic: string | null;
  matchedKeyword: string | null;
  ambiguous: boolean;
  status: RouteEntryStatus;
  stagedPath?: string;
  error?: string;
}

export interface RouteIntakeReport {
  reportVersion: 1;
  generatedAt: string;
  applied: boolean;
  runStatus: RouteRunStatus;
  runId: string;
  totalConsidered: number;
  byTopic: Record<string, number>;
  ambiguousCount: number;
  entries: RouteReportEntry[];
  error?: string;
}

export interface RouteIntakeOptions {
  apply?: boolean;
  configPath?: string;
  runId?: string;
}

export type RouteIntakeSummary = Pick<
  RouteIntakeReport,
  'totalConsidered' | 'byTopic' | 'ambiguousCount' | 'runStatus'
>;

function reportPath(root: string): string {
  return path.join(root, 'intake-routing-report.json');
}

function resolveConfigPath(root: string, configPath?: string): string {
  if (configPath) return path.resolve(root, configPath);
  // Default config ships with the tool itself, not the vault -- resolve relative to
  // this module's own location, not the vault root. tsconfig has outDir "dist" /
  // rootDir "src" with a 1:1 mirror, so at runtime this compiled file lives at
  // <repo>/dist/cli/commands/routeIntake.js and the seed config lives at
  // <repo>/config/topic-routing.json -- three levels up from __dirname.
  return path.resolve(__dirname, '../../../config/topic-routing.json');
}

function resolvePhysicalPath(root: string, sourcePath: string): string {
  const resolved = path.resolve(root, sourcePath);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `route-intake: manifest sourcePath "${sourcePath}" resolves outside the vault root "${root}" -- refusing to classify it`
    );
  }
  return resolved;
}

function classifyEntries(root: string, entries: IntakeEntry[], config: ReturnType<typeof loadTopicRoutingConfig>): RouteReportEntry[] {
  const rows: RouteReportEntry[] = [];
  for (const entry of entries) {
    const physicalPaths = [entry.sourcePath, ...(entry.dupPaths ?? [])];
    for (const sourcePath of physicalPaths) {
      resolvePhysicalPath(root, sourcePath); // throws on escape; result unused here, absolute path resolved again at apply time
      const { result, ambiguous } = classifyPath(normalize(sourcePath), config);
      rows.push({
        sourcePath,
        hash: entry.hash,
        topic: result?.topic ?? null,
        matchedKeyword: result?.matchedKeyword ?? null,
        ambiguous,
        status: result ? 'would-stage' : 'unsorted',
      });
    }
  }
  return rows;
}

function summarize(entries: RouteReportEntry[]): { byTopic: Record<string, number>; ambiguousCount: number } {
  const byTopic: Record<string, number> = { unsorted: 0 };
  let ambiguousCount = 0;
  for (const entry of entries) {
    const key = entry.topic ?? 'unsorted';
    byTopic[key] = (byTopic[key] ?? 0) + 1;
    if (entry.ambiguous) ambiguousCount++;
  }
  return { byTopic, ambiguousCount };
}

function generateRunId(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  return `${date}-${suffix}`;
}

function stagingDir(root: string, topic: string, runId: string): string {
  return path.join(root, 'topics', 'charlie', topic, `_staging-intake-${runId}`);
}

function lockPath(root: string): string {
  return path.join(root, 'intake-routing.lock');
}

function topicNodeExists(root: string, topic: string): boolean {
  try {
    readTopicMeta(root, `charlie/${topic}`);
    return true;
  } catch {
    return false;
  }
}

export async function runRouteIntake(root: string, opts: RouteIntakeOptions): Promise<RouteIntakeSummary> {
  const config = loadTopicRoutingConfig(resolveConfigPath(root, opts.configPath));
  const manifest = readIntakeManifest(root);
  const doneEntries = Object.values(manifest.entries).filter((e) => e.status === 'done');
  const entries = classifyEntries(root, doneEntries, config);
  const { byTopic, ambiguousCount } = summarize(entries);
  const runId = opts.runId ?? generateRunId();

  const writeAndReturn = (report: RouteIntakeReport): RouteIntakeSummary => {
    writeFileAtomic(reportPath(root), JSON.stringify(report, null, 2));
    return { totalConsidered: report.totalConsidered, byTopic: report.byTopic, ambiguousCount: report.ambiguousCount, runStatus: report.runStatus };
  };

  if (!opts.apply) {
    return writeAndReturn({
      reportVersion: 1,
      generatedAt: new Date().toISOString(),
      applied: false,
      runStatus: 'completed',
      runId,
      totalConsidered: entries.length,
      byTopic,
      ambiguousCount,
      entries,
    });
  }

  const matchedTopics = [...new Set(entries.map((e) => e.topic).filter((t): t is string => t !== null))];
  const missingTopics = matchedTopics.filter((t) => !topicNodeExists(root, t));
  if (missingTopics.length > 0) {
    return writeAndReturn({
      reportVersion: 1,
      generatedAt: new Date().toISOString(),
      applied: false,
      runStatus: 'preflight-failed',
      runId,
      totalConsidered: entries.length,
      byTopic,
      ambiguousCount,
      entries,
      error: `missing topic node(s): ${missingTopics.map((t) => `topics/charlie/${t}`).join(', ')} -- run "trm create topics/charlie/<topic>" first`,
    });
  }

  acquireLock(lockPath(root), runId);
  let stagedEntries: RouteReportEntry[] = [];
  try {
    const basenamesUsed = new Map<string, Set<string>>(); // topic -> set of basenames already staged this run

    for (const entry of entries) {
      if (!entry.topic) {
        stagedEntries.push(entry);
        continue;
      }
      const absSource = path.resolve(root, entry.sourcePath);
      if (!fs.existsSync(absSource)) {
        stagedEntries.push({ ...entry, status: 'missing', error: `source file no longer exists at "${entry.sourcePath}"` });
        continue;
      }
      const destDir = stagingDir(root, entry.topic, runId);
      let basename = path.basename(entry.sourcePath);
      const usedForTopic = basenamesUsed.get(entry.topic) ?? new Set<string>();
      if (usedForTopic.has(basename)) {
        const ext = path.extname(basename);
        const stem = path.basename(basename, ext);
        basename = `${stem}-${entry.hash.slice(0, 8)}${ext}`;
      }
      usedForTopic.add(basename);
      basenamesUsed.set(entry.topic, usedForTopic);

      const destPath = path.join(destDir, basename);
      try {
        copyFileAtomic(absSource, destPath);
        stagedEntries.push({ ...entry, status: 'staged', stagedPath: destPath });
      } catch (err) {
        stagedEntries.push({ ...entry, status: 'failed', error: (err as Error).message });
      }
    }

    return writeAndReturn({
      reportVersion: 1,
      generatedAt: new Date().toISOString(),
      applied: true,
      runStatus: 'completed',
      runId,
      totalConsidered: entries.length,
      byTopic,
      ambiguousCount,
      entries: stagedEntries,
    });
  } catch (err) {
    try {
      writeAndReturn({
        reportVersion: 1,
        generatedAt: new Date().toISOString(),
        applied: stagedEntries.some((e) => e.status === 'staged'),
        runStatus: 'failed',
        runId,
        totalConsidered: entries.length,
        byTopic,
        ambiguousCount,
        entries: [...stagedEntries, ...entries.slice(stagedEntries.length)],
        error: (err as Error).message,
      });
    } catch {
      // best-effort: the original error below is what matters if this write also fails
    }
    throw err;
  } finally {
    releaseLock(lockPath(root));
  }
}
