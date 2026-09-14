// src/notebooklm/nlmResearch.ts
import { spawnSync } from 'node:child_process';

export type ResearchCallResult<T> = { ok: true; data: T } | { ok: false; error: string };

interface RawSpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

// nlm research start/status/import have no --json output (confirmed via
// `nlm research start/status/import --help`, 2026-09-13) unlike source/query
// subcommands. Patterns below are live-calibrated against real CLI stdout
// (Task 1, Step 1, 2026-09-13, notebook a77247be-7685-4072-a676-bd43f5db69dc).
// Raw captured `nlm research status` output (in_progress and completed):
//   Research Status:
//     Status: in_progress
//     Task ID: 61a34873-b709-47c1-8575-1ee225e4cf82
//     Sources found: 0
//   Research Status:
//     Status: completed
//     Task ID: 61a34873-b709-47c1-8575-1ee225e4cf82
//     Sources found: 10
//
// Live-calibration finding that changed the plan: `status` never emits
// "timed out"/"times out" text. On both an immediate check (--max-wait 0)
// and after --max-wait is exhausted without completion, the CLI prints the
// identical `Status: in_progress` line and exits 0. So instead of detecting
// a timeout phrase, completion is detected positively via `Status: completed`
// and everything else (including a genuine timeout) is treated as not
// completed.
const TASK_ID_PATTERN = /task[\s_-]*id[:\s]+([A-Za-z0-9._-]+)/i;
const STATUS_COMPLETED_PATTERN = /status:\s*completed/i;

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

// question_text is sourced from config/mining-questions.json and reaches this
// cmd.exe /d /s /c wrapper unescaped -- it must not contain shell
// metacharacters (&, |, ^, >), matching the same latent-risk convention used
// in mineNotebooklm.ts's nlm invocations.
function runNlm(args: string[], timeoutMs: number): RawSpawnResult {
  const result =
    process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'nlm', ...args], { encoding: 'utf-8', timeout: timeoutMs })
      : spawnSync('nlm', args, { encoding: 'utf-8', timeout: timeoutMs });
  return result as unknown as RawSpawnResult;
}

// Fixed timeout for start/import: these calls don't wait on the research task
// itself (only status polling does), so a bounded ceiling is enough to stop a
// wedged `nlm` binary from blocking the nightly scheduled task indefinitely.
const FIXED_CALL_TIMEOUT_MS = 120_000;

function failureFrom(result: RawSpawnResult, fallback: string): { ok: false; error: string } {
  if (result.error) return { ok: false, error: result.error.message };
  const message = stripAnsi(result.stderr || result.stdout || fallback).trim();
  return { ok: false, error: message.length > 0 ? message : fallback };
}

export function researchStart(
  notebookId: string,
  query: string,
  mode: 'fast' | 'deep',
  force: boolean
): ResearchCallResult<{ taskId: string }> {
  const args = ['research', 'start', query, '--notebook-id', notebookId, '--source', 'web', '--mode', mode];
  if (force) args.push('--force');

  const result = runNlm(args, FIXED_CALL_TIMEOUT_MS);
  if (result.error || result.status !== 0) {
    return failureFrom(result, `nlm research start exited with status ${result.status}`);
  }

  const match = stripAnsi(result.stdout).match(TASK_ID_PATTERN);
  if (!match) {
    return { ok: false, error: `could not find a task id in nlm research start output: ${result.stdout.trim()}` };
  }
  return { ok: true, data: { taskId: match[1] } };
}

export function researchStatus(
  notebookId: string,
  taskId: string,
  maxWaitSeconds: number
): ResearchCallResult<{ completed: boolean }> {
  const args = ['research', 'status', notebookId, '--task-id', taskId, '--max-wait', String(maxWaitSeconds)];

  const result = runNlm(args, (maxWaitSeconds + 60) * 1000);
  if (result.error || result.status !== 0) {
    return failureFrom(result, `nlm research status exited with status ${result.status}`);
  }

  const completed = STATUS_COMPLETED_PATTERN.test(stripAnsi(result.stdout));
  return { ok: true, data: { completed } };
}

export function researchImport(notebookId: string, taskId: string): ResearchCallResult<void> {
  const args = ['research', 'import', notebookId, taskId, '--cited-only'];

  const result = runNlm(args, FIXED_CALL_TIMEOUT_MS);
  if (result.error || result.status !== 0) {
    return failureFrom(result, `nlm research import exited with status ${result.status}`);
  }
  return { ok: true, data: undefined };
}
