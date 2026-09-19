import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadMiningQuestions, answerKey, runMineNotebooklm, isUrgentAnswer, appendStalledTodo, extractAtomicGaps } from './mineNotebooklm';
import * as nlmCli from '../../notebooklm/nlmCli';
import { registryPath, readRegistry, findNotebook } from '../../notebooklm/registry';
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

  it('loadMiningQuestions returns the 4 fixed questions with stable ids', () => {
    const questions = loadMiningQuestions();
    expect(questions.map((q) => q.id)).toEqual(['open-contradictions', 'under-sourced', 'adjacent-topics', 'follow-up']);
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
    expect(first.newEntries).toBe(4);

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

  it('replaces existing question rows in place without duplicating table rows when answers change', () => {
    (nlmCli.queryNotebook as jest.Mock).mockImplementation((_nb: string, question: string) => ({
      ok: true,
      data: question.includes('contradictions') ? 'Version 1 contradiction.' : 'Version 1 answer.',
    }));

    const first = runMineNotebooklm(root, 'nb-1', {});
    expect(first.newEntries).toBe(4);

    const docPath = path.join(root, first.docPath);
    let lines = fs.readFileSync(docPath, 'utf-8').trim().split('\n');
    // Header + separator + 4 question rows = 6 lines (plus title/blank)
    const tableRows1 = lines.filter((l) => l.startsWith('| What '));
    expect(tableRows1.length).toBe(4);
    expect(tableRows1.find((r) => r.includes('Version 1 contradiction.'))).toBeDefined();

    // Now answer changes on next run
    (nlmCli.queryNotebook as jest.Mock).mockImplementation((_nb: string, question: string) => ({
      ok: true,
      data: question.includes('contradictions') ? 'Version 2 contradiction updated.' : 'Version 2 answer updated.',
    }));

    const second = runMineNotebooklm(root, 'nb-1', {});
    expect(second.newEntries).toBe(4);

    lines = fs.readFileSync(docPath, 'utf-8').trim().split('\n');
    const tableRows2 = lines.filter((l) => l.startsWith('| What '));
    expect(tableRows2.length).toBe(4);
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
});
