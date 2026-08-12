import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadMiningQuestions, answerKey, runMineNotebooklm } from './mineNotebooklm';
import * as nlmCli from '../../notebooklm/nlmCli';
import { registryPath } from '../../notebooklm/registry';

jest.mock('../../notebooklm/nlmCli');

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
    jest.resetAllMocks();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
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
});
