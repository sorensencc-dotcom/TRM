import { RegistryFile, NotebookRegistryEntry, ResearchQueueEntry, findNotebook } from '../../notebooklm/registry';
import { DispatchLimits } from '../../core/types';
import { loadMiningQuestions } from './mineNotebooklm';

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
