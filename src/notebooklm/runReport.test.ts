import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRunReport, recordItem, readRunReport, findMostRecentRunReport, runReportPath } from './runReport';

describe('runReport', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-nlmreport-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('createRunReport writes an initial report with no items', () => {
    createRunReport(root, 'run-1', 'nb-1', '2026-08-12T00:00:00.000Z');

    const report = readRunReport(root, 'run-1');
    expect(report).toEqual({ runId: 'run-1', notebookId: 'nb-1', startedAt: '2026-08-12T00:00:00.000Z', items: [] });
    expect(fs.existsSync(runReportPath(root, 'run-1'))).toBe(true);
  });

  it('recordItem appends items across multiple calls', () => {
    createRunReport(root, 'run-1', 'nb-1', '2026-08-12T00:00:00.000Z');

    recordItem(root, 'run-1', { key: 'source:s1', status: 'ingested' });
    recordItem(root, 'run-1', { key: 'source:s2', status: 'quarantined', detail: 'empty content' });

    const report = readRunReport(root, 'run-1');
    expect(report.items).toEqual([
      { key: 'source:s1', status: 'ingested' },
      { key: 'source:s2', status: 'quarantined', detail: 'empty content' },
    ]);
  });

  it('findMostRecentRunReport returns the report with the latest startedAt', () => {
    createRunReport(root, 'run-1', 'nb-1', '2026-08-12T00:00:00.000Z');
    createRunReport(root, 'run-2', 'nb-1', '2026-08-13T00:00:00.000Z');

    const latest = findMostRecentRunReport(root);
    expect(latest?.runId).toBe('run-2');
  });

  it('findMostRecentRunReport returns null when no reports exist', () => {
    expect(findMostRecentRunReport(root)).toBeNull();
  });
});
