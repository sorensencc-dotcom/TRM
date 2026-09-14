// src/notebooklm/nlmResearch.test.ts
import { spawnSync } from 'node:child_process';
import { researchStart, researchStatus, researchImport } from './nlmResearch';

jest.mock('node:child_process');

function mockSpawn(status: number | null, stdout: string, stderr = ''): void {
  (spawnSync as jest.Mock).mockReturnValue({ status, stdout, stderr });
}

describe('nlmResearch', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('researchStart extracts the task id from a successful start', () => {
    // Fixture mirrors real `nlm research start` stdout captured 2026-09-13
    // against a live notebook (see task-1-report.md).
    mockSpawn(
      0,
      '✓ Research started\n  Query: what is X\n  Source: web\n  Mode: fast\n  Notebook ID: nb-1\n  Task ID: 61a34873-b709-47c1-8575-1ee225e4cf82\n\nEstimated time: ~30 seconds\n'
    );
    const result = researchStart('nb-1', 'what is X', 'fast', false);
    expect(result).toEqual({ ok: true, data: { taskId: '61a34873-b709-47c1-8575-1ee225e4cf82' } });
  });

  it('researchStart returns a transient failure on nonzero exit', () => {
    mockSpawn(1, '', 'Error: API error (code 5): NOT_FOUND');
    const result = researchStart('nb-1', 'what is X', 'fast', false);
    expect(result).toEqual({ ok: false, error: 'Error: API error (code 5): NOT_FOUND' });
  });

  it('researchStart returns a failure when no task id can be found in stdout', () => {
    mockSpawn(0, 'Something unexpected happened but exit was 0.\n');
    const result = researchStart('nb-1', 'what is X', 'fast', false);
    expect(result.ok).toBe(false);
  });

  it('researchStart passes --force only when requested', () => {
    mockSpawn(0, 'Task ID: rt-1\n');
    researchStart('nb-1', 'q', 'deep', true);
    const args = (spawnSync as jest.Mock).mock.calls[0][1] as string[];
    expect(args).toContain('--force');
    expect(args).toContain('--mode');
    expect(args).toContain('deep');
  });

  it('researchStatus reports completed when the CLI reports status: completed', () => {
    // Fixture mirrors real `nlm research status` stdout captured 2026-09-13
    // on a completed task -- the CLI has no "completed"/success prose, only
    // a `Status: completed` field line.
    mockSpawn(
      0,
      'Research Status:\n  Status: completed\n  Task ID: 61a34873-b709-47c1-8575-1ee225e4cf82\n  Sources found: 10\n'
    );
    const result = researchStatus('nb-1', 'rt-abc123', 300);
    expect(result).toEqual({ ok: true, data: { completed: true } });
  });

  it('researchStatus reports not-completed when the CLI reports status: in_progress (including on max-wait exhaustion)', () => {
    // Live-calibrated finding: the CLI never emits "timed out" text anywhere.
    // Whether checked immediately (--max-wait 0) or after --max-wait expires
    // without completion, the output is identical: `Status: in_progress`,
    // exit 0. The brief's TIMED_OUT_PATTERN assumption did not hold live --
    // see task-1-report.md for the captured stdout from both cases.
    mockSpawn(
      0,
      'Research Status:\n  Status: in_progress\n  Task ID: rt-abc123\n  Sources found: 0\n'
    );
    const result = researchStatus('nb-1', 'rt-abc123', 300);
    expect(result).toEqual({ ok: true, data: { completed: false } });
  });

  it('researchStatus returns a transient failure on nonzero exit', () => {
    mockSpawn(1, '', 'Error: Failed to poll research: API error (code 5): NOT_FOUND');
    const result = researchStatus('nb-1', 'rt-abc123', 300);
    expect(result).toEqual({ ok: false, error: 'Error: Failed to poll research: API error (code 5): NOT_FOUND' });
  });

  it('researchImport succeeds on exit 0', () => {
    mockSpawn(0, '✓ Imported 9 sources.\n');
    const result = researchImport('nb-1', 'rt-abc123');
    expect(result).toEqual({ ok: true, data: undefined });
  });

  it('researchImport returns a transient failure on nonzero exit', () => {
    mockSpawn(1, '', 'Error: import failed');
    const result = researchImport('nb-1', 'rt-abc123');
    expect(result).toEqual({ ok: false, error: 'Error: import failed' });
  });
});
