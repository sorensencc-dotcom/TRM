import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomic } from '../core/atomicWrite';

export type RunItemStatus = 'staged' | 'ingested' | 'extracted' | 'quarantined' | 'failed';

export interface RunReportItem {
  key: string;
  status: RunItemStatus;
  detail?: string;
}

export interface RunReport {
  runId: string;
  notebookId: string;
  startedAt: string;
  items: RunReportItem[];
  syncTreatmentStatus?: 'ok' | 'skipped-topics' | 'error';
}

function reportsDir(root: string): string {
  return path.join(root, '.nlm-ingest-reports');
}

export function runReportPath(root: string, runId: string): string {
  return path.join(reportsDir(root), `${runId}.json`);
}

export function createRunReport(root: string, runId: string, notebookId: string, startedAt: string): void {
  const report: RunReport = { runId, notebookId, startedAt, items: [] };
  writeFileAtomic(runReportPath(root, runId), JSON.stringify(report, null, 2));
}

export function readRunReport(root: string, runId: string): RunReport {
  return JSON.parse(fs.readFileSync(runReportPath(root, runId), 'utf-8'));
}

export function recordItem(root: string, runId: string, item: RunReportItem): void {
  const report = readRunReport(root, runId);
  report.items.push(item);
  writeFileAtomic(runReportPath(root, runId), JSON.stringify(report, null, 2));
}

export function findMostRecentRunReport(root: string): RunReport | null {
  const dir = reportsDir(root);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) return null;

  let latest: RunReport | null = null;
  for (const file of files) {
    const report: RunReport = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
    if (!latest || report.startedAt > latest.startedAt) latest = report;
  }
  return latest;
}
