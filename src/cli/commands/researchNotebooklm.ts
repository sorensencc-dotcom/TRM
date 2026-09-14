import {
  RegistryFile,
  NotebookRegistryEntry,
  ResearchQueueEntry,
  findNotebook,
  readRegistry,
  flushResearchQueueEntry,
} from '../../notebooklm/registry';
import { DispatchLimits } from '../../core/types';
import { loadConfig } from '../../core/config';
import { loadMiningQuestions, isUrgentAnswer, appendStalledTodo } from './mineNotebooklm';
import { researchStart, researchStatus, researchImport } from '../../notebooklm/nlmResearch';
import { queryNotebook } from '../../notebooklm/nlmCli';

export interface DispatchCandidate {
  notebookId: string;
  entry: ResearchQueueEntry;
}

function cooldownMs(entry: ResearchQueueEntry, limits: DispatchLimits): number {
  const days = entry.mode === 'fast' ? limits.cooldown_days_fast : limits.cooldown_days_deep;
  return days * 24 * 60 * 60 * 1000;
}

function isEligible(entry: ResearchQueueEntry, limits: DispatchLimits, forceResearch: boolean, now: Date): boolean {
  if (entry.status === 'STALLED_NEEDS_HUMAN' || entry.status === 'INFRASTRUCTURE_BLOCKED') return false;
  if (forceResearch) return true;
  if (!entry.last_researched_at) return true;
  return now.getTime() - new Date(entry.last_researched_at).getTime() >= cooldownMs(entry, limits);
}

function orderedEligibleEntries(entry: NotebookRegistryEntry, limits: DispatchLimits, forceResearch: boolean, now: Date): ResearchQueueEntry[] {
  const questionOrder = new Map(loadMiningQuestions().map((q, idx) => [q.id, idx]));
  return Object.values(entry.research_queue ?? {})
    .filter((e) => isEligible(e, limits, forceResearch, now))
    .sort((a, b) => (questionOrder.get(a.question_id) ?? Infinity) - (questionOrder.get(b.question_id) ?? Infinity));
}

function oldestPendingTimestamp(entry: NotebookRegistryEntry): number {
  const pending = Object.values(entry.research_queue ?? {}).filter((e) => e.status === 'PENDING');
  if (pending.length === 0) return Infinity; // no PENDING entries -- excluded from the sweep entirely
  const timestamps = pending.map((e) => (e.last_researched_at ? new Date(e.last_researched_at).getTime() : -Infinity));
  return Math.min(...timestamps);
}

function candidateNotebooksInOrder(registry: RegistryFile): NotebookRegistryEntry[] {
  return registry.notebooks
    .filter((n) => oldestPendingTimestamp(n) !== Infinity)
    .sort((a, b) => {
      const diff = oldestPendingTimestamp(a) - oldestPendingTimestamp(b);
      if (!Number.isNaN(diff) && diff !== 0) return diff;
      return a.notebook_id.localeCompare(b.notebook_id);
    });
}

export function selectDispatchPlan(
  registry: RegistryFile,
  notebookId: string | undefined,
  limits: DispatchLimits,
  forceResearch: boolean,
  now: Date
): DispatchCandidate[] {
  const notebooks = notebookId
    ? [findNotebook(registry, notebookId)].filter((n): n is NotebookRegistryEntry => n !== null)
    : candidateNotebooksInOrder(registry);

  const plan: DispatchCandidate[] = [];
  for (const notebook of notebooks) {
    if (plan.length >= limits.max_jobs_per_run_global) break;
    const eligible = orderedEligibleEntries(notebook, limits, forceResearch, now);
    const remainingGlobal = limits.max_jobs_per_run_global - plan.length;
    const take = eligible.slice(0, Math.min(limits.max_jobs_per_notebook, remainingGlobal));
    for (const entry of take) {
      plan.push({ notebookId: notebook.notebook_id, entry });
    }
  }
  return plan;
}

export interface ResearchNotebooklmResult {
  dispatched: number;
  succeeded: number;
  transientFailures: number;
  stalled: number;
  infrastructureBlocked: number;
  skipped: number;
}

const STATUS_MAX_WAIT_SECONDS = 300;

function recordTransientFailure(root: string, notebookId: string, entry: ResearchQueueEntry, limits: DispatchLimits, message: string): 'PENDING' | 'INFRASTRUCTURE_BLOCKED' {
  const failures = entry.consecutive_dispatch_failures + 1;
  const status = failures >= limits.max_consecutive_dispatch_failures ? 'INFRASTRUCTURE_BLOCKED' : 'PENDING';
  flushResearchQueueEntry(root, notebookId, entry.question_hash, {
    consecutive_dispatch_failures: failures,
    last_dispatch_error: message,
    status,
  });
  if (status === 'INFRASTRUCTURE_BLOCKED') {
    console.error(
      `research-notebooklm: notebook "${notebookId}" question "${entry.question_id}" marked INFRASTRUCTURE_BLOCKED after ${failures} consecutive dispatch failures: ${message}`
    );
  }
  return status;
}

function recordSuccess(root: string, notebookId: string, entry: ResearchQueueEntry, limits: DispatchLimits, nowIso: string): 'EXECUTED' | 'PENDING' | 'STALLED_NEEDS_HUMAN' {
  const attemptCount = entry.attempt_count + 1;
  const requery = queryNotebook(notebookId, entry.question_text);
  // A failed re-query must not be mistaken for "resolved" -- stay urgent so the
  // gap is retried next eligible run instead of silently going quiet.
  const stillUrgent = requery.ok ? isUrgentAnswer(requery.data) : true;

  let status: 'EXECUTED' | 'PENDING' | 'STALLED_NEEDS_HUMAN';
  if (!stillUrgent) {
    status = 'EXECUTED';
  } else if (attemptCount >= limits.max_attempts_before_stall) {
    status = 'STALLED_NEEDS_HUMAN';
    appendStalledTodo(root, entry.question_text, entry.gap_key);
  } else {
    status = 'PENDING';
  }

  flushResearchQueueEntry(root, notebookId, entry.question_hash, {
    attempt_count: attemptCount,
    last_researched_at: nowIso,
    consecutive_dispatch_failures: 0,
    last_dispatch_error: null,
    status,
  });
  return status;
}

function dispatchCandidate(root: string, candidate: DispatchCandidate, limits: DispatchLimits, forceResearch: boolean, nowIso: string): 'succeeded' | 'transientFailure' | 'stalled' | 'infrastructureBlocked' {
  const { notebookId, entry } = candidate;

  const startResult = researchStart(notebookId, entry.question_text, entry.mode, forceResearch);
  if (!startResult.ok) {
    return recordTransientFailure(root, notebookId, entry, limits, startResult.error) === 'INFRASTRUCTURE_BLOCKED' ? 'infrastructureBlocked' : 'transientFailure';
  }

  const statusResult = researchStatus(notebookId, startResult.data.taskId, STATUS_MAX_WAIT_SECONDS);
  if (!statusResult.ok) {
    return recordTransientFailure(root, notebookId, entry, limits, statusResult.error) === 'INFRASTRUCTURE_BLOCKED' ? 'infrastructureBlocked' : 'transientFailure';
  }
  if (!statusResult.data.completed) {
    return recordTransientFailure(root, notebookId, entry, limits, 'research task timed out before completing') === 'INFRASTRUCTURE_BLOCKED' ? 'infrastructureBlocked' : 'transientFailure';
  }

  const importResult = researchImport(notebookId, startResult.data.taskId);
  if (!importResult.ok) {
    return recordTransientFailure(root, notebookId, entry, limits, importResult.error) === 'INFRASTRUCTURE_BLOCKED' ? 'infrastructureBlocked' : 'transientFailure';
  }

  const finalStatus = recordSuccess(root, notebookId, entry, limits, nowIso);
  return finalStatus === 'STALLED_NEEDS_HUMAN' ? 'stalled' : 'succeeded';
}

export function runResearchNotebooklm(root: string, notebookId: string | undefined, opts: { forceResearch: boolean }): ResearchNotebooklmResult {
  if (notebookId) {
    const registry = readRegistry(root);
    if (!findNotebook(registry, notebookId)) {
      throw new Error(`notebooklm-registry.json has no entry for notebook "${notebookId}"`);
    }
  }

  const config = loadConfig(root);
  const registry = readRegistry(root);
  const plan = selectDispatchPlan(registry, notebookId, config.dispatch_limits, opts.forceResearch, new Date());
  const nowIso = new Date().toISOString();

  const result: ResearchNotebooklmResult = { dispatched: 0, succeeded: 0, transientFailures: 0, stalled: 0, infrastructureBlocked: 0, skipped: 0 };

  for (const candidate of plan) {
    result.dispatched++;
    const outcome = dispatchCandidate(root, candidate, config.dispatch_limits, opts.forceResearch, nowIso);
    if (outcome === 'succeeded') result.succeeded++;
    else if (outcome === 'stalled') result.stalled++;
    else if (outcome === 'infrastructureBlocked') result.infrastructureBlocked++;
    else result.transientFailures++;
  }

  return result;
}
