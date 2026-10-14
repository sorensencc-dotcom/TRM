import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadMiningQuestions,
  answerKey,
  runMineNotebooklm,
  isUrgentAnswer,
  appendStalledTodo,
  extractAtomicGaps,
  computeBatteryEntropy,
  loadDynamicGapQuestions,
  buildSourceFilter,
  filterPrimarySources,
  isSyntheticSource,
  synthesizeDynamicQuestions,
} from './mineNotebooklm';
import * as nlmCli from '../../notebooklm/nlmCli';
import { registryPath, readRegistry, findNotebook, setupTestingSandbox, KB_TESTING_SANDBOX_UUID,
  KB_TESTING_FIXTURE_SOURCE_ID, KB_TESTING_FIXTURE_TITLE } from '../../notebooklm/registry';
import { spawnSync } from 'node:child_process';

jest.mock('../../notebooklm/nlmCli');
jest.mock('node:child_process');

function seedRegistry(root: string): void {
  fs.writeFileSync(
    registryPath(root),
    JSON.stringify({
      version: 1,
      notebooks: [
        {
          notebook_id: 'nb-1',
          title: 'Willow Run Videos',
          url: 'https://notebooklm.google.com/notebook/nb-1',
          last_pulled_hashes: {},
          quarantined: {},
          last_ingested_at: null,
          last_mined_at: null,
          last_mined_answer_keys: [],
        },
      ],
    })
  );
}

describe('mineNotebooklm', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-nlmmine-'));
    seedRegistry(root);
    fs.writeFileSync(
      path.join(root, 'config.json'),
      JSON.stringify({ default_scoring_adapter: 'stub', promotion_threshold: 80, actor_source: 'env', time_source: 'system' })
    );
    jest.resetAllMocks();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('kb-testing isolated mining', () => {
    function setup(): void {
      fs.unlinkSync(registryPath(root));
      fs.unlinkSync(path.join(root, 'config.json'));
      setupTestingSandbox(root);
    }

    it('requires an empty setup vault and refuses a production registry', () => {
      expect(() => setupTestingSandbox(root)).toThrow('empty vault');
      const registry = readRegistry(root);
      registry.notebooks[0].notebook_id = KB_TESTING_SANDBOX_UUID;
      fs.writeFileSync(registryPath(root), JSON.stringify(registry));
      expect(() => runMineNotebooklm(root, KB_TESTING_SANDBOX_UUID, {})).toThrow('isolated vault');
      expect(nlmCli.listSources).not.toHaveBeenCalled();
    });

    it.each([undefined, { ok: false, error: 'offline' }, { ok: true, data: [] },
      { ok: true, data: [{ id: 'wrong-id', title: KB_TESTING_FIXTURE_TITLE }] }])('fails closed before querying when fixture cannot be verified (%p)', (sources) => {
      setup();
      (nlmCli.listSources as jest.Mock).mockReturnValue(sources);
      expect(() => runMineNotebooklm(root, KB_TESTING_SANDBOX_UUID, {})).toThrow('pinned fixture');
      expect(nlmCli.queryNotebookDetailed).not.toHaveBeenCalled();
      expect(nlmCli.queryNotebook).not.toHaveBeenCalled();
      expect(findNotebook(readRegistry(root), KB_TESTING_SANDBOX_UUID)?.last_mined_at).toBeNull();
    });

    it('runs three fixture-pinned questions, paces duplicates and failures, and isolates repeat effects', () => {
      setup();
      const matrix = '## Active Research Gaps\n- [ ] **KB - Testing Sandbox (Live Verification) (real-gap)**: never dispatch\n';
      fs.writeFileSync(path.join(root, 'trm-research-gaps.md'), matrix);
      (nlmCli.listSources as jest.Mock).mockReturnValue({ ok: true, data: [
        { id: KB_TESTING_FIXTURE_SOURCE_ID, title: KB_TESTING_FIXTURE_TITLE },
        { id: 'unrelated', title: 'Other primary source' },
      ] });
      (nlmCli.queryNotebookDetailed as jest.Mock).mockReturnValue({ ok: true, data: { answer: 'needs verification: sandbox fact', conversation_id: 'conversation-1' } });
      const wait = jest.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
      try {
        const first = runMineNotebooklm(root, KB_TESTING_SANDBOX_UUID, {});
        expect(first.newEntries).toBe(3);
        expect(runMineNotebooklm(root, KB_TESTING_SANDBOX_UUID, {}).newEntries).toBe(0);
        (nlmCli.queryNotebookDetailed as jest.Mock).mockReturnValue({ ok: false, error: 'offline' });
        expect(runMineNotebooklm(root, KB_TESTING_SANDBOX_UUID, {}).newEntries).toBe(0);
        expect(wait).toHaveBeenCalledTimes(6);
        for (const call of wait.mock.calls) expect(call[3]).toBe(3500);
        const calls = (nlmCli.queryNotebookDetailed as jest.Mock).mock.calls;
        expect(calls.slice(0, 3).map((call) => call[1]).join(' ')).toMatch(/ALPHA-101.*BRAVO-202.*CHARLIE-303/);
        for (const call of calls) expect(call).toEqual([KB_TESTING_SANDBOX_UUID, expect.any(String), {
          sourceIds: [KB_TESTING_FIXTURE_SOURCE_ID], newConversation: false, timeoutSeconds: 120,
        }]);
        expect(nlmCli.queryNotebook).not.toHaveBeenCalled();
        expect(spawnSync).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(root, 'TODOS.md'))).toBe(false);
        expect(fs.readFileSync(path.join(root, 'trm-research-gaps.md'), 'utf8')).toBe(matrix);
        expect(findNotebook(readRegistry(root), KB_TESTING_SANDBOX_UUID)?.research_queue).toEqual({});
        expect(fs.readFileSync(path.join(root, first.docPath), 'utf8').split('\n').filter((line) => line.startsWith('| For Entity'))).toHaveLength(3);
      } finally { wait.mockRestore(); }
    });

    it('requires exact notebook identity for deterministic sandbox questions', () => {
      const questions = synthesizeDynamicQuestions({ notebook_id: KB_TESTING_SANDBOX_UUID, title: 'renamed' });
      expect(questions.map((question) => question.id)).toEqual(['sandbox-alpha-101', 'sandbox-bravo-202', 'sandbox-charlie-303']);
      expect(synthesizeDynamicQuestions({ title: KB_TESTING_FIXTURE_TITLE, slug: 'kb-testing' })).not.toEqual(questions);
    });
  });

  it('extractAtomicGaps decomposes markdown lists and bold headers into atomic items', () => {
    const rawAnswer = `Across the historical records, several contradictions exist:
1. **Bennett vs Sorensen**: Direct conflict on board composition and 1943 transition.
2. **Mental Acuity**: Disputed timeline regarding Henry Ford's operational status.
* **Cuban Claim Valuation**: FCSC records state $1.2M while personal ledgers state $2.5M.`;

    const items = extractAtomicGaps('nb-1', 'open-contradictions', rawAnswer);
    expect(items).toHaveLength(3);
    expect(items[0].title).toBe('Bennett vs Sorensen');
    expect(items[0].text).toContain('Direct conflict on board composition');
    expect(items[1].title).toBe('Mental Acuity');
    expect(items[2].title).toBe('Cuban Claim Valuation');
    expect(items[0].key).toContain('nb-1:open-contradictions:');
  });

  it('loadMiningQuestions returns the 5 research questions or 4 operational questions based on category', () => {
    const researchQuestions = loadMiningQuestions(undefined, 'research');
    expect(researchQuestions.map((q) => q.id)).toEqual([
      'open-contradictions',
      'under-sourced',
      'adjacent-topics',
      'follow-up',
      'non-obvious-connections',
    ]);

    const opQuestions = loadMiningQuestions(undefined, 'operational');
    expect(opQuestions.map((q) => q.id)).toEqual([
      'unresolved-bottlenecks',
      'unverified-assumptions',
      'tooling-gaps',
      'system-improvements',
    ]);
  });

  describe('computeBatteryEntropy', () => {
    it('returns 1.0 when previous question set is empty', () => {
      const entropy = computeBatteryEntropy(['q1', 'q2', 'q3'], []);
      expect(entropy).toBe(1.0);
    });

    it('returns 0.0 when question sets are 100% identical (boilerplate loop)', () => {
      const entropy = computeBatteryEntropy(
        ['open-contradictions', 'under-sourced', 'adjacent-topics'],
        ['open-contradictions', 'under-sourced', 'adjacent-topics']
      );
      expect(entropy).toBe(0.0);
    });

    it('returns positive entropy when net-new dynamic inquiries are added', () => {
      const entropy = computeBatteryEntropy(
        ['dynamic-gap-1', 'dynamic-gap-2', 'open-contradictions'],
        ['open-contradictions', 'under-sourced', 'adjacent-topics', 'follow-up']
      );
      expect(entropy).toBeGreaterThan(0.5);
    });
  });

  describe('loadDynamicGapQuestions', () => {
    it('extracts active gaps matching notebook title from trm-research-gaps.md', () => {
      const gapsPath = path.join(root, 'trm-research-gaps.md');
      fs.writeFileSync(
        gapsPath,
        `## Active Research Gaps\n- [ ] **Willow Run Videos (open-contradictions - B-24 Turret Gear Ratio)**: Discrepancy in engineering drawing #401.\n- [ ] **Other Notebook (something)**: Other info.\n`
      );

      const dynamic = loadDynamicGapQuestions(root, 'Willow Run Videos');
      expect(dynamic.length).toBeGreaterThanOrEqual(1);
      expect(dynamic[0].text).toContain('B-24 Turret Gear Ratio');
      expect(dynamic[0].id).toContain('dynamic-gap-');
    });

    it('returns empty array when no research gaps exist or match', () => {
      const dynamic = loadDynamicGapQuestions(root, 'Unmatched Notebook');
      expect(dynamic).toEqual([]);
    });
  });

  it('answerKey is stable for identical inputs and changes when the answer changes', () => {
    const k1 = answerKey('nb-1', 'open-contradictions', 'Answer A');
    const k2 = answerKey('nb-1', 'open-contradictions', 'Answer A');
    const k3 = answerKey('nb-1', 'open-contradictions', 'Answer B');
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
  });

  it('writes new rows to research-gaps doc and TODOS.md, and is idempotent on a second identical run', () => {
    (nlmCli.queryNotebook as jest.Mock).mockImplementation((_nb: string, question: string) => ({
      ok: true,
      data: question.includes('contradictions') ? 'No source found for the 1943 production date.' : 'Some other answer.',
    }));

    fs.writeFileSync(path.join(root, 'TODOS.md'), '# TODOS\n\n## Open\n\n## Completed\n');

    const first = runMineNotebooklm(root, 'nb-1', {});
    expect(first.newEntries).toBe(5);

    const docContent = fs.readFileSync(path.join(root, first.docPath), 'utf-8');
    expect(docContent).toContain('No source found for the 1943 production date.');

    const todos = fs.readFileSync(path.join(root, 'TODOS.md'), 'utf-8');
    expect(todos).toContain('No source found for the 1943 production date.');

    const second = runMineNotebooklm(root, 'nb-1', {});
    expect(second.newEntries).toBe(0);
  });

  it('quarantine-style MCP errors on a question do not throw and do not add a row', () => {
    (nlmCli.queryNotebook as jest.Mock).mockReturnValue({ ok: false, error: 'timeout' });
    fs.writeFileSync(path.join(root, 'TODOS.md'), '# TODOS\n\n## Open\n\n## Completed\n');

    const result = runMineNotebooklm(root, 'nb-1', {});
    expect(result.newEntries).toBe(0);
  });

  it('dispatches operational questions when notebook category is operational', () => {
    fs.writeFileSync(
      registryPath(root),
      JSON.stringify({
        version: 1,
        notebooks: [
          {
            notebook_id: 'nb-op',
            title: 'Sigil Protocol & Federation',
            category: 'operational',
            url: 'https://notebooklm.google.com/notebook/nb-op',
            last_pulled_hashes: {},
            quarantined: {},
            last_ingested_at: null,
            last_mined_at: null,
            last_mined_answer_keys: [],
          },
        ],
      })
    );

    const askedQuestions: string[] = [];
    (nlmCli.queryNotebook as jest.Mock).mockImplementation((_nb: string, question: string) => {
      askedQuestions.push(question);
      return { ok: true, data: 'Operational insight result.' };
    });

    const res = runMineNotebooklm(root, 'nb-op', {});
    expect(res.newEntries).toBe(4);
    expect(askedQuestions).toHaveLength(4);
    expect(askedQuestions[0]).toContain('technical blockers');
  });

  it('replaces existing question rows in place without duplicating table rows when answers change', () => {
    (nlmCli.queryNotebook as jest.Mock).mockImplementation((_nb: string, question: string) => ({
      ok: true,
      data: question.includes('contradictions') ? 'Version 1 contradiction.' : 'Version 1 answer.',
    }));

    const first = runMineNotebooklm(root, 'nb-1', {});
    expect(first.newEntries).toBe(5);

    const docPath = path.join(root, first.docPath);
    let lines = fs.readFileSync(docPath, 'utf-8').trim().split('\n');
    const tableRows1 = lines.filter((l) => l.startsWith('| What ') || l.startsWith('| Find '));
    expect(tableRows1.length).toBe(5);
    expect(tableRows1.find((r) => r.includes('Version 1 contradiction.'))).toBeDefined();

    // Now answer changes on next run
    (nlmCli.queryNotebook as jest.Mock).mockImplementation((_nb: string, question: string) => ({
      ok: true,
      data: question.includes('contradictions') ? 'Version 2 contradiction updated.' : 'Version 2 answer updated.',
    }));

    const second = runMineNotebooklm(root, 'nb-1', {});
    expect(second.newEntries).toBe(5);

    lines = fs.readFileSync(docPath, 'utf-8').trim().split('\n');
    const tableRows2 = lines.filter((l) => l.startsWith('| What ') || l.startsWith('| Find '));
    expect(tableRows2.length).toBe(5);
    expect(tableRows2.find((r) => r.includes('Version 2 contradiction updated.'))).toBeDefined();
    expect(tableRows2.find((r) => r.includes('Version 1 contradiction.'))).toBeUndefined();
  });

  it('preserves existing research-gaps sources when replacement upload fails', () => {
    (nlmCli.queryNotebook as jest.Mock).mockReturnValue({ ok: false, error: 'timeout' });
    (spawnSync as jest.Mock).mockImplementation((_command: string, args: string[]) => {
      if (args.includes('list')) {
        return { status: 0, stdout: JSON.stringify([{ id: 'old-source', title: 'Willow Run Videos research gaps' }]) };
      }
      if (args.includes('add')) return { status: 1, stdout: '', stderr: 'upload failed' };
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });

    runMineNotebooklm(root, 'nb-1', {});

    expect(spawnSync).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(['source', 'delete', 'old-source']),
      expect.anything(),
    );
  });

  it('constrains queries to top 20 source IDs with 180s timeout when notebook has >50 sources', () => {
    const mockSources = Array.from({ length: 60 }, (_, i) => ({
      id: `src-${i}`,
      title: `Source ${i}`,
    }));
    (nlmCli.listSources as jest.Mock).mockReturnValue({ ok: true, data: mockSources });
    (nlmCli.queryNotebook as jest.Mock).mockReturnValue({ ok: true, data: 'Answer from constrained sources' });

    runMineNotebooklm(root, 'nb-1', {});

    expect(nlmCli.queryNotebook).toHaveBeenCalledWith(
      'nb-1',
      expect.any(String),
      expect.objectContaining({
        sourceIds: mockSources.slice(0, 20).map((s) => s.id),
        timeoutSeconds: 180,
      })
    );
  });

  it('isUrgentAnswer matches the three urgency patterns and nothing else', () => {
    expect(isUrgentAnswer('This needs verification against another source.')).toBe(true);
    expect(isUrgentAnswer('We recommend investigating this further.')).toBe(true);
    expect(isUrgentAnswer('No source found for this claim.')).toBe(true);
    expect(isUrgentAnswer('This is well-corroborated by three sources.')).toBe(false);
  });

  it('queues an urgent answer into research_queue with the default dispatch mode', () => {
    fs.writeFileSync(
      path.join(root, 'config.json'),
      JSON.stringify({
        default_scoring_adapter: 'stub',
        promotion_threshold: 80,
        actor_source: 'env',
        time_source: 'system',
        dispatch_limits: { default_mode: 'fast' },
      })
    );
    (nlmCli.queryNotebook as jest.Mock).mockImplementation((_nb: string, question: string) => ({
      ok: true,
      data: question.includes('contradictions') ? 'No source found for the 1943 production date.' : 'Some other answer.',
    }));

    runMineNotebooklm(root, 'nb-1', {});

    const entry = findNotebook(readRegistry(root), 'nb-1')!;
    const queued = Object.values(entry.research_queue!);
    expect(queued).toHaveLength(1);
    expect(queued[0].question_id).toBe('open-contradictions');
    expect(queued[0].mode).toBe('fast');
    expect(queued[0].status).toBe('PENDING');
  });

  it('does not re-queue or reset an already-queued gap on a repeat mining run', () => {
    fs.writeFileSync(
      path.join(root, 'config.json'),
      JSON.stringify({
        default_scoring_adapter: 'stub', promotion_threshold: 80, actor_source: 'env', time_source: 'system',
      })
    );
    (nlmCli.queryNotebook as jest.Mock).mockImplementation((_nb: string, question: string) => ({
      ok: true,
      data: question.includes('contradictions') ? 'No source found for the 1943 production date.' : 'Some other answer.',
    }));

    runMineNotebooklm(root, 'nb-1', {});
    const registry = readRegistry(root);
    const entry = findNotebook(registry, 'nb-1')!;
    const hash = Object.keys(entry.research_queue!)[0];
    entry.research_queue![hash].attempt_count = 2;
    fs.writeFileSync(registryPath(root), JSON.stringify(registry, null, 2));

    // Same answer again, plus a second question that changes to also be urgent
    (nlmCli.queryNotebook as jest.Mock).mockImplementation((_nb: string, question: string) => ({
      ok: true,
      data: question.includes('contradictions') ? 'No source found for the 1943 production date.' : 'Some other answer.',
    }));
    runMineNotebooklm(root, 'nb-1', {});

    const afterEntry = findNotebook(readRegistry(root), 'nb-1')!;
    expect(afterEntry.research_queue![hash].attempt_count).toBe(2); // untouched, not reset to 0
  });

  it('appendStalledTodo appends a [STALLED] line once and is idempotent on the same gap_key', () => {
    fs.writeFileSync(path.join(root, 'TODOS.md'), '# TODOS\n\n## Open\n\n## Completed\n');

    appendStalledTodo(root, 'What open questions exist?', 'nb-1:open-contradictions:abc');
    appendStalledTodo(root, 'What open questions exist?', 'nb-1:open-contradictions:abc');

    const todos = fs.readFileSync(path.join(root, 'TODOS.md'), 'utf-8');
    const occurrences = todos.split('nb-1:open-contradictions:abc').length - 1;
    expect(occurrences).toBe(1);
    expect(todos).toContain('[STALLED]');
  });

  describe('buildSourceFilter & Synthetic Source Exclusion', () => {
    it('filters out synthetic meta sources including TRM gaps, guide, and pack files', () => {
      const mockSources = [
        { id: 'src-pdf-1', title: '64-167-65_SorensenCharlesE.pdf', type: 'pdf' },
        { id: 'src-gap', title: 'TRM Research Gaps & Synthesis', type: 'generated_text' },
        { id: 'src-guide', title: 'Ecosystem Architecture Guide (Current).md', type: 'generated_text' },
        { id: 'src-pack', title: 'pack_post_war.txt', type: 'generated_text' },
        { id: 'src-web', title: 'Historical Archive Page', type: 'web_page' },
      ];

      const primary = filterPrimarySources(mockSources);
      expect(primary.map((s) => s.id)).toEqual(['src-pdf-1', 'src-web']);

      const filter = buildSourceFilter(mockSources);
      expect(filter.sourceIds).not.toContain('src-gap');
      expect(filter.sourceIds).not.toContain('src-guide');
      expect(filter.sourceIds).not.toContain('src-pack');
      expect(filter.primaryCount).toBe(2);
    });

    it('constrains queries and sets 180s timeout when a single PDF exceeds 100,000 tokens', () => {
      const mockSources = [
        { id: 'src-heavy-pdf', title: '64-167-65_SorensenCharlesE.pdf', type: 'pdf', char_count: 1_600_000 }, // ~400k tokens
        { id: 'src-web', title: 'Benson Ford Directory', type: 'web_page', char_count: 4_000 },
      ];

      const filter = buildSourceFilter(mockSources);
      expect(filter.isConstrained).toBe(true);
      expect(filter.hasHeavyPdf).toBe(true);
      expect(filter.timeoutSeconds).toBe(180);
      expect(filter.sourceIds).toEqual(['src-heavy-pdf', 'src-web']);
    });

    it('constrains queries and sets 180s timeout when total tokens exceed 250,000', () => {
      const mockSources = [
        { id: 'src-1', title: 'Book Volume 1', type: 'web_page', char_count: 600_000 }, // ~150k tokens
        { id: 'src-2', title: 'Book Volume 2', type: 'web_page', char_count: 500_000 }, // ~125k tokens
      ];

      const filter = buildSourceFilter(mockSources);
      expect(filter.isConstrained).toBe(true);
      expect(filter.timeoutSeconds).toBe(180);
      expect(filter.totalTokens).toBeGreaterThan(250_000);
    });

    it('passes newConversation: true and filtered sourceIds on every queryNotebook call', () => {
      const mockSources = [
        { id: 'primary-1', title: 'Primary Document 1', type: 'web_page', char_count: 10_000 },
        { id: 'meta-gap', title: 'TRM Research Gaps & Synthesis', type: 'generated_text' },
      ];
      (nlmCli.listSources as jest.Mock).mockReturnValue({ ok: true, data: mockSources });
      (nlmCli.queryNotebook as jest.Mock).mockReturnValue({ ok: true, data: 'Answer content' });

      runMineNotebooklm(root, 'nb-1', {});

      expect(nlmCli.queryNotebook).toHaveBeenCalledWith(
        'nb-1',
        expect.any(String),
        expect.objectContaining({
          sourceIds: ['primary-1'],
          newConversation: true,
        })
      );
    });
  });

  describe('synthesizeDynamicQuestions', () => {
    it('synthesizes entity-anchored questions for post-war, willow-run, and cuba', () => {
      const postWar = synthesizeDynamicQuestions({ title: 'CIC - Post-War', slug: 'post-war' });
      expect(postWar.length).toBe(5);
      expect(postWar.some((q) => q.text.includes('Willys-Overland'))).toBe(true);
      expect(postWar.some((q) => q.text.includes('Brooks Stevens'))).toBe(true);

      const willow = synthesizeDynamicQuestions({ title: 'CIC - Willow Run & Aviation Engineering', slug: 'willow-run' });
      expect(willow.length).toBe(5);
      expect(willow.some((q) => q.text.includes('B-24'))).toBe(true);
      expect(willow.some((q) => q.text.includes('Davis high-lift wing'))).toBe(true);

      const cuba = synthesizeDynamicQuestions({ title: 'CIC - Cuban Seizures & Retired Assets', slug: 'cuba-claims' });
      expect(cuba.length).toBe(5);
      expect(cuba.some((q) => q.text.includes('Cuban Law 890'))).toBe(true);
      expect(cuba.some((q) => q.text.includes('Compañía Litográfica de la Habana'))).toBe(true);
    });
  });
});
