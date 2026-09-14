import { selectDispatchPlan } from './researchNotebooklm';
import { RegistryFile, ResearchQueueEntry } from '../../notebooklm/registry';
import { DEFAULT_DISPATCH_LIMITS } from '../../core/config';

function entry(overrides: Partial<ResearchQueueEntry> = {}): ResearchQueueEntry {
  return {
    question_hash: 'h1',
    question_text: 'What open questions or unresolved contradictions exist across these sources?',
    question_id: 'open-contradictions',
    gap_key: 'nb:open-contradictions:x',
    mode: 'fast',
    attempt_count: 0,
    consecutive_dispatch_failures: 0,
    last_researched_at: null,
    last_dispatch_error: null,
    status: 'PENDING',
    ...overrides,
  };
}

function registryWith(notebooks: Array<{ id: string; queue: Record<string, ResearchQueueEntry> }>): RegistryFile {
  return {
    version: 1,
    notebooks: notebooks.map((n) => ({
      notebook_id: n.id,
      title: n.id,
      url: `https://x/${n.id}`,
      last_pulled_hashes: {},
      quarantined: {},
      last_ingested_at: null,
      last_mined_at: null,
      last_mined_answer_keys: [],
      research_queue: n.queue,
    })),
  };
}

describe('selectDispatchPlan', () => {
  const now = new Date('2026-09-13T00:00:00.000Z');

  it('selects the explicit notebook only, ignoring others', () => {
    const registry = registryWith([
      { id: 'nb-1', queue: { h1: entry() } },
      { id: 'nb-2', queue: { h2: entry({ question_hash: 'h2' }) } },
    ]);
    const plan = selectDispatchPlan(registry, 'nb-1', DEFAULT_DISPATCH_LIMITS, false, now);
    expect(plan.map((c) => c.notebookId)).toEqual(['nb-1']);
  });

  it('skips STALLED_NEEDS_HUMAN and INFRASTRUCTURE_BLOCKED entries', () => {
    const registry = registryWith([
      {
        id: 'nb-1',
        queue: {
          h1: entry({ status: 'STALLED_NEEDS_HUMAN' }),
          h2: entry({ question_hash: 'h2', status: 'INFRASTRUCTURE_BLOCKED' }),
          h3: entry({ question_hash: 'h3', status: 'PENDING' }),
        },
      },
    ]);
    const plan = selectDispatchPlan(registry, 'nb-1', DEFAULT_DISPATCH_LIMITS, false, now);
    expect(plan.map((c) => c.entry.question_hash)).toEqual(['h3']);
  });

  it('skips entries inside the cooldown window unless forceResearch', () => {
    const recentlyResearched = entry({ last_researched_at: '2026-09-12T00:00:00.000Z' }); // 1 day ago, fast cooldown is 14 days
    const registry = registryWith([{ id: 'nb-1', queue: { h1: recentlyResearched } }]);

    expect(selectDispatchPlan(registry, 'nb-1', DEFAULT_DISPATCH_LIMITS, false, now)).toHaveLength(0);
    expect(selectDispatchPlan(registry, 'nb-1', DEFAULT_DISPATCH_LIMITS, true, now)).toHaveLength(1);
  });

  it('applies the per-notebook cap', () => {
    const registry = registryWith([
      {
        id: 'nb-1',
        queue: {
          h1: entry({ question_hash: 'h1', question_id: 'open-contradictions' }),
          h2: entry({ question_hash: 'h2', question_id: 'under-sourced' }),
          h3: entry({ question_hash: 'h3', question_id: 'adjacent-topics' }),
          h4: entry({ question_hash: 'h4', question_id: 'follow-up' }),
        },
      },
    ]);
    const limits = { ...DEFAULT_DISPATCH_LIMITS, max_jobs_per_notebook: 2, max_jobs_per_run_global: 10 };
    const plan = selectDispatchPlan(registry, 'nb-1', limits, false, now);
    expect(plan).toHaveLength(2);
    expect(plan.map((c) => c.entry.question_id)).toEqual(['open-contradictions', 'under-sourced']); // question order
  });

  it('applies the global cap across notebooks, ordering never-researched notebooks first, tie-broken by id', () => {
    const registry = registryWith([
      { id: 'nb-b', queue: { h1: entry({ last_researched_at: null }) } },
      { id: 'nb-a', queue: { h2: entry({ question_hash: 'h2', last_researched_at: null }) } },
      { id: 'nb-c', queue: { h3: entry({ question_hash: 'h3', last_researched_at: '2020-01-01T00:00:00.000Z' }) } },
    ]);
    const limits = { ...DEFAULT_DISPATCH_LIMITS, max_jobs_per_notebook: 5, max_jobs_per_run_global: 2 };
    const plan = selectDispatchPlan(registry, undefined, limits, false, now);
    expect(plan.map((c) => c.notebookId)).toEqual(['nb-a', 'nb-b']); // both null last_researched_at, tie-broken a<b; nb-c excluded by global cap
  });

  it('excludes notebooks with no eligible PENDING entries from the omitted-id sweep', () => {
    const registry = registryWith([
      { id: 'nb-1', queue: { h1: entry({ status: 'EXECUTED' }) } },
      { id: 'nb-2', queue: { h2: entry({ question_hash: 'h2', status: 'PENDING' }) } },
    ]);
    const plan = selectDispatchPlan(registry, undefined, DEFAULT_DISPATCH_LIMITS, false, now);
    expect(plan.map((c) => c.notebookId)).toEqual(['nb-2']);
  });

  it('prioritizes never-researched notebooks over already-researched ones, regardless of alphabetical order', () => {
    // Regression test: nb-zzz (never researched) should come before nb-aaa (already researched)
    // even though alphabetically nb-aaa < nb-zzz. Tests that -Infinity comparison is not suppressed.
    const registry = registryWith([
      { id: 'nb-zzz', queue: { h1: entry({ last_researched_at: null }) } },
      { id: 'nb-aaa', queue: { h2: entry({ question_hash: 'h2', last_researched_at: '2020-01-01T00:00:00.000Z' }) } },
    ]);
    const plan = selectDispatchPlan(registry, undefined, DEFAULT_DISPATCH_LIMITS, false, now);
    expect(plan.map((c) => c.notebookId)).toEqual(['nb-zzz', 'nb-aaa']);
  });
});
