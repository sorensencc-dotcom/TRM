import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeBatteryEntropy } from '../../src/cli/commands/mineNotebooklm';

export interface NotebookTelemetryAuditItem {
  id: string;
  title: string;
  category: string;
  lastActivityAt: string | null;
  lastQuestionIds: string[];
  driveMirrorExists: boolean;
}

export interface AuditReport {
  pass: boolean;
  staleNotebooks: string[];
  boilerplateNotebooks: string[];
  missingDriveMirrors: string[];
  unregisteredNotebooks: string[];
}

export function auditNotebookCluster(
  telemetry: NotebookTelemetryAuditItem[],
  canonicalNotebookIds: string[],
  nowMs: number = Date.now(),
  maxAgeHours: number = 24
): AuditReport {
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  const staleNotebooks: string[] = [];
  const boilerplateNotebooks: string[] = [];
  const missingDriveMirrors: string[] = [];
  const reportedIds = new Set(telemetry.map((t) => t.id));

  const unregisteredNotebooks = canonicalNotebookIds.filter((id) => !reportedIds.has(id));

  for (const item of telemetry) {
    // 1. Recency check
    if (!item.lastActivityAt) {
      staleNotebooks.push(`${item.title} (${item.id}): never active`);
    } else {
      const activityMs = new Date(item.lastActivityAt).getTime();
      if (nowMs - activityMs > maxAgeMs) {
        const hoursAgo = Math.round((nowMs - activityMs) / (1000 * 60 * 60));
        staleNotebooks.push(`${item.title} (${item.id}): inactive for ${hoursAgo}h`);
      }
    }

    // 2. Drive mirror parity check
    if (!item.driveMirrorExists) {
      missingDriveMirrors.push(`${item.title} (${item.id})`);
    }

    // 3. Question entropy check (4-question static loop detection)
    const staticBattery = ['open-contradictions', 'under-sourced', 'adjacent-topics', 'follow-up'];
    const entropy = computeBatteryEntropy(item.lastQuestionIds, staticBattery);
    if (entropy === 0.0 && item.lastQuestionIds.length >= 4) {
      boilerplateNotebooks.push(`${item.title} (${item.id}): zero entropy against static 4-question battery`);
    }
  }

  const pass =
    staleNotebooks.length === 0 &&
    boilerplateNotebooks.length === 0 &&
    missingDriveMirrors.length === 0 &&
    unregisteredNotebooks.length === 0;

  return {
    pass,
    staleNotebooks,
    boilerplateNotebooks,
    missingDriveMirrors,
    unregisteredNotebooks,
  };
}

describe('Staleness & Audit Telemetry Invariants', () => {
  const canonicalIds = ['nb-1', 'nb-2', 'nb-3'];
  const now = new Date('2026-10-08T20:00:00.000Z').getTime();

  it('detects dormant/stale notebooks violating <24h SLA', () => {
    const telemetry: NotebookTelemetryAuditItem[] = [
      {
        id: 'nb-1',
        title: 'KB - Operations',
        category: 'operational',
        lastActivityAt: '2026-10-08T18:00:00.000Z', // 2h ago -> FRESH
        lastQuestionIds: ['unresolved-bottlenecks', 'unverified-assumptions'],
        driveMirrorExists: true,
      },
      {
        id: 'nb-2',
        title: 'KB - Governance',
        category: 'operational',
        lastActivityAt: '2026-09-16T12:00:00.000Z', // 22 days ago -> STALE
        lastQuestionIds: [],
        driveMirrorExists: true,
      },
      {
        id: 'nb-3',
        title: 'Personal OS',
        category: 'operational',
        lastActivityAt: null, // never -> STALE
        lastQuestionIds: [],
        driveMirrorExists: true,
      },
    ];

    const report = auditNotebookCluster(telemetry, canonicalIds, now, 24);
    expect(report.pass).toBe(false);
    expect(report.staleNotebooks).toHaveLength(2);
    expect(report.staleNotebooks[0]).toContain('KB - Governance');
    expect(report.staleNotebooks[1]).toContain('Personal OS');
  });

  it('flags zero-entropy boilerplate stagnation loops', () => {
    const telemetry: NotebookTelemetryAuditItem[] = [
      {
        id: 'nb-1',
        title: 'Willow Run',
        category: 'research',
        lastActivityAt: '2026-10-08T18:00:00.000Z',
        // Injected questions match 100% static 4-question template
        lastQuestionIds: ['open-contradictions', 'under-sourced', 'adjacent-topics', 'follow-up'],
        driveMirrorExists: true,
      },
      {
        id: 'nb-2',
        title: 'Ford Politics',
        category: 'research',
        lastActivityAt: '2026-10-08T18:00:00.000Z',
        // Injected questions include dynamic gap
        lastQuestionIds: ['dynamic-gap-01', 'open-contradictions', 'under-sourced'],
        driveMirrorExists: true,
      },
      {
        id: 'nb-3',
        title: 'Post-War',
        category: 'research',
        lastActivityAt: '2026-10-08T18:00:00.000Z',
        lastQuestionIds: ['dynamic-gap-02', 'follow-up'],
        driveMirrorExists: true,
      },
    ];

    const report = auditNotebookCluster(telemetry, canonicalIds, now, 24);
    expect(report.boilerplateNotebooks).toHaveLength(1);
    expect(report.boilerplateNotebooks[0]).toContain('Willow Run');
  });

  it('catches missing Google Drive mirror folders', () => {
    const telemetry: NotebookTelemetryAuditItem[] = [
      {
        id: 'nb-1',
        title: 'KB - Operations',
        category: 'operational',
        lastActivityAt: '2026-10-08T18:00:00.000Z',
        lastQuestionIds: ['unresolved-bottlenecks'],
        driveMirrorExists: true,
      },
      {
        id: 'nb-2',
        title: 'KB - Governance',
        category: 'operational',
        lastActivityAt: '2026-10-08T18:00:00.000Z',
        lastQuestionIds: ['unresolved-bottlenecks'],
        driveMirrorExists: false, // Drive mirror missing!
      },
      {
        id: 'nb-3',
        title: 'Personal OS',
        category: 'operational',
        lastActivityAt: '2026-10-08T18:00:00.000Z',
        lastQuestionIds: ['unresolved-bottlenecks'],
        driveMirrorExists: true,
      },
    ];

    const report = auditNotebookCluster(telemetry, canonicalIds, now, 24);
    expect(report.missingDriveMirrors).toHaveLength(1);
    expect(report.missingDriveMirrors[0]).toContain('KB - Governance');
  });

  it('catches coverage collapse when canonical notebooks are omitted', () => {
    // Only nb-1 reported; nb-2 and nb-3 skipped completely
    const telemetry: NotebookTelemetryAuditItem[] = [
      {
        id: 'nb-1',
        title: 'Rewrite Labs',
        category: 'operational',
        lastActivityAt: '2026-10-08T18:00:00.000Z',
        lastQuestionIds: ['unresolved-bottlenecks'],
        driveMirrorExists: true,
      },
    ];

    const report = auditNotebookCluster(telemetry, canonicalIds, now, 24);
    expect(report.pass).toBe(false);
    expect(report.unregisteredNotebooks).toEqual(['nb-2', 'nb-3']);
  });

  it('passes 100% when all notebooks meet recency, entropy, drive, and coverage SLAs', () => {
    const telemetry: NotebookTelemetryAuditItem[] = [
      {
        id: 'nb-1',
        title: 'KB - Operations',
        category: 'operational',
        lastActivityAt: '2026-10-08T18:00:00.000Z',
        lastQuestionIds: ['dynamic-gap-1', 'unresolved-bottlenecks'],
        driveMirrorExists: true,
      },
      {
        id: 'nb-2',
        title: 'KB - Governance',
        category: 'operational',
        lastActivityAt: '2026-10-08T18:00:00.000Z',
        lastQuestionIds: ['dynamic-gap-2', 'unresolved-bottlenecks'],
        driveMirrorExists: true,
      },
      {
        id: 'nb-3',
        title: 'Personal OS',
        category: 'operational',
        lastActivityAt: '2026-10-08T18:00:00.000Z',
        lastQuestionIds: ['dynamic-gap-3', 'unresolved-bottlenecks'],
        driveMirrorExists: true,
      },
    ];

    const report = auditNotebookCluster(telemetry, canonicalIds, now, 24);
    expect(report.pass).toBe(true);
    expect(report.staleNotebooks).toHaveLength(0);
    expect(report.boilerplateNotebooks).toHaveLength(0);
    expect(report.missingDriveMirrors).toHaveLength(0);
    expect(report.unregisteredNotebooks).toHaveLength(0);
  });
});
