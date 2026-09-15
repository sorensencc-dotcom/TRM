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
import { queryNotebook, addSource } from '../../notebooklm/nlmCli';
import { searchWeb } from '../../research/webSearch';
import { writeEvidenceMarkdown } from '../../research/evidenceWriter';

export interface DispatchCandidate {
  notebookId: string;
  entry: ResearchQueueEntry;
}

function cooldownMs(entry: ResearchQueueEntry, limits: DispatchLimits): number {
  const days = entry.mode === 'fast' ? limits.cooldown_days_fast : limits.cooldown_days_deep;
  return days * 24 * 60 * 60 * 1000;
}

function isEligible(entry: ResearchQueueEntry, limits: DispatchLimits, forceResearch: boolean, now: Date): boolean {
  // EXECUTED is terminal: the loop closes once a gap is resolved. A resolved
  // gap does not get automatically re-researched -- if the gap reopens, a
  // fresh mining run creates a new queue entry. force-research bypasses
  // cooldown, not resolved status.
  if (entry.status !== 'PENDING') return false;
  if (forceResearch) return true;
  if (!entry.last_researched_at) return true;
  const lastResearchedMs = new Date(entry.last_researched_at).getTime();
  // A malformed timestamp must fail open (treated as never-researched), not
  // permanently ineligible: `now - NaN` is always NaN, and `NaN >= cooldownMs`
  // is always false, which would otherwise wedge the entry in cooldown forever.
  if (Number.isNaN(lastResearchedMs)) return true;
  return now.getTime() - lastResearchedMs >= cooldownMs(entry, limits);
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

function countAllEligible(registry: RegistryFile, notebookId: string | undefined, limits: DispatchLimits, forceResearch: boolean, now: Date): number {
  const notebooks = notebookId
    ? [findNotebook(registry, notebookId)].filter((n): n is NotebookRegistryEntry => n !== null)
    : candidateNotebooksInOrder(registry);
  return notebooks.reduce((sum, notebook) => sum + orderedEligibleEntries(notebook, limits, forceResearch, now).length, 0);
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
  plan?: Array<{ notebookId: string; questionId: string; webStrategy?: 'web' | 'auto' | 'notebook' }>;
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

type WebFallbackOutcome = { status: 'EVIDENCE_IMPORTED' } | { status: 'FAILED'; error: string };

// Spec: "one clear error per run, not per-gap spam" -- when PARALLEL_API_KEY
// is unset, every candidate that would otherwise reach the web fallback
// fails with this same message, but the underlying cause is only ever
// logged once (by the caller in runResearchNotebooklm), not once per gap.
const MISSING_PARALLEL_API_KEY_ERROR = 'PARALLEL_API_KEY is not set';

async function runWebFallback(
  root: string,
  notebookId: string,
  entry: ResearchQueueEntry,
  nowIso: string
): Promise<WebFallbackOutcome> {
  try {
    const result = await searchWeb(entry.question_text);
    if (result.hits.length === 0) {
      throw new Error('Parallel search returned zero hits');
    }
    const evidencePath = writeEvidenceMarkdown(root, entry.question_id, entry.question_text, result);
    const uploadResult = addSource(notebookId, evidencePath, `TRM Evidence: ${entry.question_id}`);
    if (!uploadResult.ok) {
      throw new Error(uploadResult.error);
    }
    flushResearchQueueEntry(root, notebookId, entry.question_hash, {
      status: 'EVIDENCE_IMPORTED',
      imported_source: evidencePath,
      last_updated_at: nowIso,
      consecutive_dispatch_failures: 0,
      last_dispatch_error: null,
    });
    return { status: 'EVIDENCE_IMPORTED' };
  } catch (err) {
    return { status: 'FAILED', error: (err as Error).message };
  }
}

async function recordSuccess(
  root: string,
  notebookId: string,
  entry: ResearchQueueEntry,
  limits: DispatchLimits,
  nowIso: string,
  parallelKeyMissing: boolean
): Promise<'EXECUTED' | 'PENDING' | 'STALLED_NEEDS_HUMAN' | 'EVIDENCE_IMPORTED'> {
  const attemptCount = entry.attempt_count + 1;
  const requery = queryNotebook(notebookId, entry.question_text);
  // A failed re-query must not be mistaken for "resolved" -- stay urgent so the
  // gap is retried next eligible run instead of silently going quiet.
  const stillUrgent = requery.ok ? isUrgentAnswer(requery.data) : true;

  if (!stillUrgent) {
    flushResearchQueueEntry(root, notebookId, entry.question_hash, {
      attempt_count: attemptCount,
      last_researched_at: nowIso,
      consecutive_dispatch_failures: 0,
      last_dispatch_error: null,
      status: 'EXECUTED',
    });
    return 'EXECUTED';
  }

  if (attemptCount < limits.max_attempts_before_stall) {
    flushResearchQueueEntry(root, notebookId, entry.question_hash, {
      attempt_count: attemptCount,
      last_researched_at: nowIso,
      consecutive_dispatch_failures: 0,
      last_dispatch_error: null,
      status: 'PENDING',
    });
    return 'PENDING';
  }

  // Last resort: about to stall, try the web fallback first -- unless the
  // entry is pinned to notebook-only research, in which case it must go
  // straight to STALLED_NEEDS_HUMAN without ever calling searchWeb. If
  // PARALLEL_API_KEY is missing for this whole run, skip calling
  // runWebFallback entirely (the caller already logged this once) instead of
  // hitting the same doomed searchWeb call and logging again per candidate.
  if (entry.web_strategy !== 'notebook' && !parallelKeyMissing) {
    const fallbackEntry = { ...entry, attempt_count: attemptCount };
    const fallbackOutcome = await runWebFallback(root, notebookId, fallbackEntry, nowIso);
    if (fallbackOutcome.status === 'EVIDENCE_IMPORTED') {
      return 'EVIDENCE_IMPORTED';
    }
    console.error(
      `research-notebooklm: notebook "${notebookId}" question "${entry.question_id}" web fallback failed before stalling: ${fallbackOutcome.error}`
    );
  }

  appendStalledTodo(root, entry.question_text, entry.gap_key);
  flushResearchQueueEntry(root, notebookId, entry.question_hash, {
    attempt_count: attemptCount,
    last_researched_at: nowIso,
    consecutive_dispatch_failures: 0,
    last_dispatch_error: null,
    status: 'STALLED_NEEDS_HUMAN',
  });
  return 'STALLED_NEEDS_HUMAN';
}

async function dispatchCandidate(
  root: string,
  candidate: DispatchCandidate,
  limits: DispatchLimits,
  forceResearch: boolean,
  nowIso: string,
  parallelKeyMissing: boolean
): Promise<'succeeded' | 'transientFailure' | 'stalled' | 'infrastructureBlocked'> {
  const { notebookId, entry } = candidate;

  if (entry.web_strategy === 'web') {
    // PARALLEL_API_KEY missing for this run: skip the doomed searchWeb call
    // and route straight through the same failure handling a real fallback
    // failure would get, without an additional per-candidate log (the
    // caller already logged the missing key once for the whole run).
    const outcome = parallelKeyMissing
      ? ({ status: 'FAILED', error: MISSING_PARALLEL_API_KEY_ERROR } as const)
      : await runWebFallback(root, notebookId, entry, nowIso);
    if (outcome.status === 'EVIDENCE_IMPORTED') {
      return 'succeeded';
    }
    return recordTransientFailure(root, notebookId, entry, limits, outcome.error) === 'INFRASTRUCTURE_BLOCKED'
      ? 'infrastructureBlocked'
      : 'transientFailure';
  }

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

  const finalStatus = await recordSuccess(root, notebookId, entry, limits, nowIso, parallelKeyMissing);
  return finalStatus === 'STALLED_NEEDS_HUMAN' ? 'stalled' : 'succeeded';
}

export async function runResearchNotebooklm(
  root: string,
  notebookId: string | undefined,
  opts: { forceResearch: boolean; limit?: number; dryRun?: boolean }
): Promise<ResearchNotebooklmResult> {
  const config = loadConfig(root);
  const registry = readRegistry(root);
  if (notebookId && !findNotebook(registry, notebookId)) {
    throw new Error(`notebooklm-registry.json has no entry for notebook "${notebookId}"`);
  }

  const now = new Date();
  const plan = selectDispatchPlan(registry, notebookId, config.dispatch_limits, opts.forceResearch, now);
  const boundedPlan = opts.limit !== undefined ? plan.slice(0, opts.limit) : plan;

  // Checked once per run (not per-candidate): spec requires "one clear error
  // per run, not per-gap spam" when PARALLEL_API_KEY is unset. Candidates
  // that never touch the web-fallback path (pure notebook research, or
  // web_strategy: "notebook") are unaffected by this flag entirely.
  const parallelKeyMissing = !process.env.PARALLEL_API_KEY;
  if (parallelKeyMissing) {
    console.error(
      `research-notebooklm: ${MISSING_PARALLEL_API_KEY_ERROR}; skipping web-strategy/fallback dispatch for this run`
    );
  }

  const result: ResearchNotebooklmResult = { dispatched: 0, succeeded: 0, transientFailures: 0, stalled: 0, infrastructureBlocked: 0, skipped: 0 };
  result.skipped = countAllEligible(registry, notebookId, config.dispatch_limits, opts.forceResearch, now) - boundedPlan.length;

  if (opts.dryRun) {
    result.dispatched = boundedPlan.length;
    result.plan = boundedPlan.map((c) => ({
      notebookId: c.notebookId,
      questionId: c.entry.question_id,
      webStrategy: c.entry.web_strategy,
    }));
    return result;
  }

  const nowIso = now.toISOString();

  for (const candidate of boundedPlan) {
    result.dispatched++;
    const outcome = await dispatchCandidate(root, candidate, config.dispatch_limits, opts.forceResearch, nowIso, parallelKeyMissing);
    if (outcome === 'succeeded') result.succeeded++;
    else if (outcome === 'stalled') result.stalled++;
    else if (outcome === 'infrastructureBlocked') result.infrastructureBlocked++;
    else result.transientFailures++;
  }

  return result;
}
