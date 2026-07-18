import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

jest.mock('node:child_process', () => ({
  spawnSync: jest.fn(() => ({
    stdout: JSON.stringify({
      type: 'result',
      is_error: false,
      result: JSON.stringify({
        facts: [{ text: 'Mocked fact.', confidence: 0.8, categories: ['history'] }],
        summary: 'Mocked summary.',
      }),
    }),
    status: 0,
  })),
}));

import { spawnSync } from 'node:child_process';
import { runCreate } from '../../src/cli/commands/create';
import { runIngest } from '../../src/cli/commands/ingest';
import { runExtract } from '../../src/cli/commands/extract';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-'));
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({ default_scoring_adapter: 'stub', promotion_threshold: 80, actor_source: 'cli-only', time_source: 'system' })
  );
  return root;
}

function setUpSource(root: string) {
  runCreate(root, 'cuba', { actor: 'ACTOR-001' });
  runIngest(root, 'cuba', { actor: 'ACTOR-001', type: 'text', title: 'x', origin: 'x', url: 'x' });
  const rawDir = path.join(root, 'topics', 'cuba', 'sources', 'raw');
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(path.join(rawDir, 'SRC-001.txt'), 'Some raw text.\n');
}

describe('runExtract default runner wiring', () => {
  beforeEach(() => {
    (spawnSync as jest.Mock).mockClear();
  });

  it('uses claudeCodeRunner (spawns claude CLI) by default, not stubRunner', () => {
    const root = makeRoot();
    setUpSource(root);

    const result = runExtract(root, 'cuba', { actor: 'ACTOR-001' });

    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(result?.facts).toHaveLength(1);
    expect(result?.facts[0].text).toBe('Mocked fact.');
    expect(result?.facts[0].categories).toEqual(['history']);
  });

  it('--stub bypasses claude CLI entirely and uses the naive splitter', () => {
    const root = makeRoot();
    setUpSource(root);

    const result = runExtract(root, 'cuba', { actor: 'ACTOR-001', stub: true });

    expect(spawnSync).not.toHaveBeenCalled();
    expect(result?.facts[0].text).toBe('Some raw text.');
  });
});
