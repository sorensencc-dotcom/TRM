import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCreate } from '../../src/cli/commands/create';
import { runScore } from '../../src/cli/commands/score';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ default_scoring_adapter: 'stub', promotion_threshold: 80, actor_source: 'cli-only', time_source: 'system' }));
  return root;
}

function writeExtract(root: string, topicPath: string, facts: any[]) {
  const dir = path.join(root, 'topics', ...topicPath.split('/'), 'extracts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'extract.json'), JSON.stringify({ facts }, null, 2));
}

describe('runScore', () => {
  it('scores facts and writes score.json validated against the schema', () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    writeExtract(root, 'cuba', [{ id: 'FCT-001', text: 'x', source_id: 'SRC-001', confidence: 0.95, categories: ['history', 'genealogy'] }]);
    const result = runScore(root, 'cuba', { actor: 'ACTOR-001' });
    expect(result?.scores[0].promoted).toBe(true);
    const scorePath = path.join(root, 'topics', 'cuba', 'extracts', 'score.json');
    expect(JSON.parse(fs.readFileSync(scorePath, 'utf-8')).scores).toHaveLength(1);
  });

  it('rolls up child scores without writing a merged file', () => {
    const root = makeRoot();
    runCreate(root, 'cuba/industry', { actor: 'ACTOR-001' });
    writeExtract(root, 'cuba/industry', [{ id: 'FCT-001', text: 'x', source_id: 'SRC-001', confidence: 0.9, categories: [] }]);
    runScore(root, 'cuba/industry', { actor: 'ACTOR-001' });

    const result = runScore(root, 'cuba', { actor: 'ACTOR-001', rollup: true });
    expect(result?.scores).toHaveLength(1);
    expect(result?.rolledUpFrom).toContain('cuba/industry');
    expect(fs.existsSync(path.join(root, 'topics', 'cuba', 'extracts', 'score.json'))).toBe(false);
  });

  it('rollup tags each score with topic_path, disambiguating colliding fact_ids across nodes', () => {
    const root = makeRoot();
    runCreate(root, 'cuba/industry', { actor: 'ACTOR-001' });
    runCreate(root, 'cuba/genealogy', { actor: 'ACTOR-001' });
    writeExtract(root, 'cuba/industry', [{ id: 'FCT-001', text: 'industry fact', source_id: 'SRC-001', confidence: 0.9, categories: [] }]);
    writeExtract(root, 'cuba/genealogy', [{ id: 'FCT-001', text: 'genealogy fact', source_id: 'SRC-001', confidence: 0.7, categories: [] }]);
    runScore(root, 'cuba/industry', { actor: 'ACTOR-001' });
    runScore(root, 'cuba/genealogy', { actor: 'ACTOR-001' });

    const result = runScore(root, 'cuba', { actor: 'ACTOR-001', rollup: true }) as { scores: any[]; rolledUpFrom: string[] };
    expect(result.scores).toHaveLength(2);
    expect(result.scores.every((s) => typeof s.fact_id === 'string')).toBe(true);
    const byTopic = Object.fromEntries(result.scores.map((s) => [s.topic_path, s]));
    expect(byTopic['cuba/industry'].fact_id).toBe('FCT-001');
    expect(byTopic['cuba/genealogy'].fact_id).toBe('FCT-001');
    expect(byTopic['cuba/industry']).not.toBe(byTopic['cuba/genealogy']);
  });

  it('dry-run writes nothing', () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    writeExtract(root, 'cuba', [{ id: 'FCT-001', text: 'x', source_id: 'SRC-001', confidence: 0.5, categories: [] }]);
    const result = runScore(root, 'cuba', { actor: 'ACTOR-001', dryRun: true });
    expect(result).not.toBeNull();
    expect(fs.existsSync(path.join(root, 'topics', 'cuba', 'extracts', 'score.json'))).toBe(false);
  });
});
