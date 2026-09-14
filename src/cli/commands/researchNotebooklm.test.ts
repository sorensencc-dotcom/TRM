import { selectDispatchPlan, runResearchNotebooklm } from './researchNotebooklm';
import { RegistryFile, ResearchQueueEntry } from '../../notebooklm/registry';
import { DEFAULT_DISPATCH_LIMITS } from '../../core/config';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registryPath, readRegistry, findNotebook, questionHash } from '../../notebooklm/registry';
import * as nlmResearch from '../../notebooklm/nlmResearch';
import * as nlmCli from '../../notebooklm/nlmCli';

jest.mock('../../notebooklm/nlmResearch');
jest.mock('../../notebooklm/nlmCli');

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

  it('never dispatches an EXECUTED entry, even with forceResearch: true (the loop closes once)', () => {
    const registry = registryWith([
      { id: 'nb-1', queue: { h1: entry({ status: 'EXECUTED', last_researched_at: '2020-01-01T00:00:00.000Z' }) } },
    ]);
    expect(selectDispatchPlan(registry, 'nb-1', DEFAULT_DISPATCH_LIMITS, false, now)).toHaveLength(0);
    expect(selectDispatchPlan(registry, 'nb-1', DEFAULT_DISPATCH_LIMITS, true, now)).toHaveLength(0);
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

function seedRunRegistry(root: string, queueEntry: object): void {
  fs.writeFileSync(
    registryPath(root),
    JSON.stringify({
      version: 1,
      notebooks: [
        {
          notebook_id: 'nb-1',
          title: 'T',
          url: 'https://x',
          last_pulled_hashes: {},
          quarantined: {},
          last_ingested_at: null,
          last_mined_at: null,
          last_mined_answer_keys: [],
          research_queue: { [questionHash('What open questions or unresolved contradictions exist across these sources?')]: queueEntry },
        },
      ],
    })
  );
}

function baseEntry(overrides: object = {}) {
  return {
    question_hash: questionHash('What open questions or unresolved contradictions exist across these sources?'),
    question_text: 'What open questions or unresolved contradictions exist across these sources?',
    question_id: 'open-contradictions',
    gap_key: 'nb-1:open-contradictions:x',
    mode: 'fast',
    attempt_count: 0,
    consecutive_dispatch_failures: 0,
    last_researched_at: null,
    last_dispatch_error: null,
    status: 'PENDING',
    ...overrides,
  };
}

describe('runResearchNotebooklm', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-nlmresearch-'));
    fs.writeFileSync(
      path.join(root, 'config.json'),
      JSON.stringify({ default_scoring_adapter: 'stub', promotion_threshold: 80, actor_source: 'env', time_source: 'system' })
    );
    jest.resetAllMocks();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('on full success with a resolved gap, marks EXECUTED and starts the cooldown', () => {
    seedRunRegistry(root, baseEntry());
    (nlmResearch.researchStart as jest.Mock).mockReturnValue({ ok: true, data: { taskId: 'rt-1' } });
    (nlmResearch.researchStatus as jest.Mock).mockReturnValue({ ok: true, data: { completed: true } });
    (nlmResearch.researchImport as jest.Mock).mockReturnValue({ ok: true, data: undefined });
    (nlmCli.queryNotebook as jest.Mock).mockReturnValue({ ok: true, data: 'Fully resolved, well-sourced now.' });

    const result = runResearchNotebooklm(root, 'nb-1', { forceResearch: false });

    expect(result.succeeded).toBe(1);
    const entry = findNotebook(readRegistry(root), 'nb-1')!.research_queue![baseEntry().question_hash];
    expect(entry.status).toBe('EXECUTED');
    expect(entry.attempt_count).toBe(1);
    expect(entry.last_researched_at).not.toBeNull();
    expect(entry.consecutive_dispatch_failures).toBe(0);
  });

  it('on success but still urgent, with attempts remaining, stays PENDING', () => {
    seedRunRegistry(root, baseEntry({ attempt_count: 0 }));
    (nlmResearch.researchStart as jest.Mock).mockReturnValue({ ok: true, data: { taskId: 'rt-1' } });
    (nlmResearch.researchStatus as jest.Mock).mockReturnValue({ ok: true, data: { completed: true } });
    (nlmResearch.researchImport as jest.Mock).mockReturnValue({ ok: true, data: undefined });
    (nlmCli.queryNotebook as jest.Mock).mockReturnValue({ ok: true, data: 'Still no source found for this.' });

    runResearchNotebooklm(root, 'nb-1', { forceResearch: false });

    const entry = findNotebook(readRegistry(root), 'nb-1')!.research_queue![baseEntry().question_hash];
    expect(entry.status).toBe('PENDING');
    expect(entry.attempt_count).toBe(1);
  });

  it('on success but still urgent, at max_attempts_before_stall, transitions to STALLED_NEEDS_HUMAN and appends a TODOS.md line', () => {
    fs.writeFileSync(path.join(root, 'TODOS.md'), '# TODOS\n\n## Open\n\n## Completed\n');
    seedRunRegistry(root, baseEntry({ attempt_count: 2 })); // default max_attempts_before_stall is 3
    (nlmResearch.researchStart as jest.Mock).mockReturnValue({ ok: true, data: { taskId: 'rt-1' } });
    (nlmResearch.researchStatus as jest.Mock).mockReturnValue({ ok: true, data: { completed: true } });
    (nlmResearch.researchImport as jest.Mock).mockReturnValue({ ok: true, data: undefined });
    (nlmCli.queryNotebook as jest.Mock).mockReturnValue({ ok: true, data: 'Still no source found for this.' });

    runResearchNotebooklm(root, 'nb-1', { forceResearch: false });

    const entry = findNotebook(readRegistry(root), 'nb-1')!.research_queue![baseEntry().question_hash];
    expect(entry.status).toBe('STALLED_NEEDS_HUMAN');
    expect(entry.attempt_count).toBe(3);
    const todos = fs.readFileSync(path.join(root, 'TODOS.md'), 'utf-8');
    expect(todos).toContain('[STALLED]');
    expect(todos).toContain('nb-1:open-contradictions:x');
  });

  it('on success and no longer urgent, transitions to EXECUTED even when attempt_count is about to hit max_attempts_before_stall', () => {
    // stillUrgent is checked before the attempt-cap/stall check: a resolved
    // gap must not be marked STALLED_NEEDS_HUMAN just because this attempt
    // happened to be the one that would have hit the cap.
    seedRunRegistry(root, baseEntry({ attempt_count: 2 })); // default max_attempts_before_stall is 3
    (nlmResearch.researchStart as jest.Mock).mockReturnValue({ ok: true, data: { taskId: 'rt-1' } });
    (nlmResearch.researchStatus as jest.Mock).mockReturnValue({ ok: true, data: { completed: true } });
    (nlmResearch.researchImport as jest.Mock).mockReturnValue({ ok: true, data: undefined });
    (nlmCli.queryNotebook as jest.Mock).mockReturnValue({ ok: true, data: 'Fully resolved, well-sourced now.' });

    runResearchNotebooklm(root, 'nb-1', { forceResearch: false });

    const entry = findNotebook(readRegistry(root), 'nb-1')!.research_queue![baseEntry().question_hash];
    expect(entry.status).toBe('EXECUTED');
    expect(entry.attempt_count).toBe(3);
  });

  it('a transient researchStart failure leaves attempt_count/cooldown untouched and increments consecutive_dispatch_failures', () => {
    seedRunRegistry(root, baseEntry());
    (nlmResearch.researchStart as jest.Mock).mockReturnValue({ ok: false, error: 'network blip' });

    runResearchNotebooklm(root, 'nb-1', { forceResearch: false });

    const entry = findNotebook(readRegistry(root), 'nb-1')!.research_queue![baseEntry().question_hash];
    expect(entry.status).toBe('PENDING');
    expect(entry.attempt_count).toBe(0);
    expect(entry.last_researched_at).toBeNull();
    expect(entry.consecutive_dispatch_failures).toBe(1);
    expect(entry.last_dispatch_error).toBe('network blip');
  });

  it('a status timeout on exit 0 is treated as a transient failure, not a success', () => {
    seedRunRegistry(root, baseEntry());
    (nlmResearch.researchStart as jest.Mock).mockReturnValue({ ok: true, data: { taskId: 'rt-1' } });
    (nlmResearch.researchStatus as jest.Mock).mockReturnValue({ ok: true, data: { completed: false } });

    runResearchNotebooklm(root, 'nb-1', { forceResearch: false });

    const entry = findNotebook(readRegistry(root), 'nb-1')!.research_queue![baseEntry().question_hash];
    expect(entry.status).toBe('PENDING');
    expect(entry.attempt_count).toBe(0);
    expect(entry.consecutive_dispatch_failures).toBe(1);
    expect(nlmResearch.researchImport).not.toHaveBeenCalled();
  });

  it('reaching max_consecutive_dispatch_failures transitions to INFRASTRUCTURE_BLOCKED', () => {
    seedRunRegistry(root, baseEntry({ consecutive_dispatch_failures: 4 })); // default max is 5
    (nlmResearch.researchStart as jest.Mock).mockReturnValue({ ok: false, error: 'still failing' });

    runResearchNotebooklm(root, 'nb-1', { forceResearch: false });

    const entry = findNotebook(readRegistry(root), 'nb-1')!.research_queue![baseEntry().question_hash];
    expect(entry.status).toBe('INFRASTRUCTURE_BLOCKED');
    expect(entry.consecutive_dispatch_failures).toBe(5);
  });

  it('a query failure on the post-success re-query keeps the entry PENDING rather than marking EXECUTED', () => {
    seedRunRegistry(root, baseEntry());
    (nlmResearch.researchStart as jest.Mock).mockReturnValue({ ok: true, data: { taskId: 'rt-1' } });
    (nlmResearch.researchStatus as jest.Mock).mockReturnValue({ ok: true, data: { completed: true } });
    (nlmResearch.researchImport as jest.Mock).mockReturnValue({ ok: true, data: undefined });
    (nlmCli.queryNotebook as jest.Mock).mockReturnValue({ ok: false, error: 'timeout' });

    runResearchNotebooklm(root, 'nb-1', { forceResearch: false });

    const entry = findNotebook(readRegistry(root), 'nb-1')!.research_queue![baseEntry().question_hash];
    expect(entry.status).toBe('PENDING');
    expect(entry.attempt_count).toBe(1); // the dispatch itself still counts as a completed attempt
  });

  it('throws when an explicit notebookId is not present in the registry', () => {
    fs.writeFileSync(registryPath(root), JSON.stringify({ version: 1, notebooks: [] }));
    expect(() => runResearchNotebooklm(root, 'no-such-notebook', { forceResearch: false })).toThrow(
      /notebooklm-registry\.json has no entry for notebook "no-such-notebook"/
    );
  });

  it('a --force-research bypasses cooldown but does not dispatch a STALLED or BLOCKED entry', () => {
    seedRunRegistry(root, baseEntry({ status: 'STALLED_NEEDS_HUMAN', last_researched_at: '2026-09-12T00:00:00.000Z' }));

    runResearchNotebooklm(root, 'nb-1', { forceResearch: true });

    expect(nlmResearch.researchStart).not.toHaveBeenCalled();
  });
});
