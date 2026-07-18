import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCreate } from '../../src/cli/commands/create';
import { runIngest } from '../../src/cli/commands/ingest';
import { runExtract } from '../../src/cli/commands/extract';
import { runScore } from '../../src/cli/commands/score';
import { runCrosslink } from '../../src/cli/commands/crosslink';
import { runVersionBump } from '../../src/cli/commands/versionBump';
import { runValidate } from '../../src/cli/commands/validate';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ default_scoring_adapter: 'stub', promotion_threshold: 60, actor_source: 'cli-only', time_source: 'system' }));
  return root;
}

describe('full TRM lifecycle', () => {
  it('create -> ingest -> extract -> score -> crosslink -> version-bump -> validate', () => {
    const root = makeRoot();
    const actor = 'ACTOR-001';

    runCreate(root, 'cuba/industry/automotive', { actor, description: 'Automotive research', tags: ['history', 'industry'] });

    runIngest(root, 'cuba/industry/automotive', { actor, type: 'text', title: 'Overview', origin: 'LOC', url: 'https://example.com' });
    const rawDir = path.join(root, 'topics', 'cuba', 'industry', 'automotive', 'sources', 'raw');
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(path.join(rawDir, 'SRC-001.txt'), 'Industrial expansion accelerated in the 1920s.\n');

    const extracted = runExtract(root, 'cuba/industry/automotive', { actor });
    expect(extracted?.facts.length).toBeGreaterThan(0);

    const scored = runScore(root, 'cuba/industry/automotive', { actor });
    expect(scored?.scores.length).toBe(extracted?.facts.length);

    runCreate(root, 'willys', { actor, tags: ['industry'] });
    runCrosslink(root, 'cuba/industry/automotive', {
      actor,
      relatedTopic: 'willys',
      relationship: 'industrial context overlap',
    });

    const newVersion = runVersionBump(root, 'cuba/industry/automotive', 'minor', { actor });
    expect(newVersion).toBe('1.1.0');

    const reports = runValidate(root, 'cuba', { recursive: true });
    expect(reports.every((r) => r.valid)).toBe(true);
    expect(reports.map((r) => r.path)).toEqual(['cuba', 'cuba/industry', 'cuba/industry/automotive']);

    const rollup = runScore(root, 'cuba', { actor, rollup: true });
    expect(rollup?.scores.length).toBe(extracted?.facts.length);
  });
});
