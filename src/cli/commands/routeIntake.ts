import * as fs from 'node:fs';
import * as path from 'node:path';
import { readIntakeManifest, IntakeEntry } from '../../core/intakeManifest';
import { loadTopicRoutingConfig, classifyPath, normalize } from '../../core/topicRouting';
import { writeFileAtomic } from '../../core/atomicWrite';

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
  return path.resolve(root, configPath ?? 'config/topic-routing.json');
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
  const byTopic: Record<string, number> = {};
  let ambiguousCount = 0;
  for (const entry of entries) {
    const key = entry.topic ?? 'unsorted';
    byTopic[key] = (byTopic[key] ?? 0) + 1;
    if (entry.ambiguous) ambiguousCount++;
  }
  return { byTopic, ambiguousCount };
}

export async function runRouteIntake(root: string, opts: RouteIntakeOptions): Promise<RouteIntakeSummary> {
  const config = loadTopicRoutingConfig(resolveConfigPath(root, opts.configPath));
  const manifest = readIntakeManifest(root);
  const doneEntries = Object.values(manifest.entries).filter((e) => e.status === 'done');
  const entries = classifyEntries(root, doneEntries, config);
  const { byTopic, ambiguousCount } = summarize(entries);

  const report: RouteIntakeReport = {
    reportVersion: 1,
    generatedAt: new Date().toISOString(),
    applied: false,
    runStatus: 'completed',
    runId: opts.runId ?? 'dry-run',
    totalConsidered: entries.length,
    byTopic,
    ambiguousCount,
    entries,
  };

  writeFileAtomic(reportPath(root), JSON.stringify(report, null, 2));

  return { totalConsidered: report.totalConsidered, byTopic: report.byTopic, ambiguousCount: report.ambiguousCount, runStatus: report.runStatus };
}
