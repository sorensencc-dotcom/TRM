import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCreate } from '../../src/cli/commands/create';
import { runScore } from '../../src/cli/commands/score';
import { runValidate } from '../../src/cli/commands/validate';

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

describe('runValidate', () => {
  it('passes for an untouched, freshly scored node', () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    writeExtract(root, 'cuba', [{ id: 'FCT-001', text: 'x', source_id: 'SRC-001', confidence: 0.9, categories: [] }]);
    runScore(root, 'cuba', { actor: 'ACTOR-001' });
    const [report] = runValidate(root, 'cuba', {});
    expect(report.valid).toBe(true);
  });

  it('fails when score.json was hand-edited after the SCORE lineage op', () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    writeExtract(root, 'cuba', [{ id: 'FCT-001', text: 'x', source_id: 'SRC-001', confidence: 0.9, categories: [] }]);
    runScore(root, 'cuba', { actor: 'ACTOR-001' });

    const scorePath = path.join(root, 'topics', 'cuba', 'extracts', 'score.json');
    const score = JSON.parse(fs.readFileSync(scorePath, 'utf-8'));
    score.scores[0].promoted = true;
    fs.writeFileSync(scorePath, JSON.stringify(score, null, 2));

    const [report] = runValidate(root, 'cuba', {});
    expect(report.valid).toBe(false);
    expect(report.errors.some((e) => /score\.json/.test(e))).toBe(true);
  });

  it('recurses into descendants when --recursive is set', () => {
    const root = makeRoot();
    runCreate(root, 'cuba/industry', { actor: 'ACTOR-001' });
    const reports = runValidate(root, 'cuba', { recursive: true });
    expect(reports.map((r) => r.path)).toEqual(['cuba', 'cuba/industry']);
  });

  it('warns (but does not fail) when a source JSON is flagged mock: true', () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    writeExtract(root, 'cuba', [{ id: 'FCT-001', text: 'x', source_id: 'SRC-001', confidence: 0.9, categories: [] }]);
    runScore(root, 'cuba', { actor: 'ACTOR-001' });

    const rawDir = path.join(root, 'topics', 'cuba', 'sources', 'raw');
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(
      path.join(rawDir, 'SRC-001.json'),
      JSON.stringify({ mock: true, matches: [], metadata: { visionApiUsed: false } })
    );

    const [report] = runValidate(root, 'cuba', {});
    expect(report.valid).toBe(true);
    expect(report.warnings).toContain('SRC-001 is mock image-extraction data, not a verified fact source');
  });

  it('does not warn for a non-mock source JSON', () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    writeExtract(root, 'cuba', [{ id: 'FCT-001', text: 'x', source_id: 'SRC-001', confidence: 0.9, categories: [] }]);
    runScore(root, 'cuba', { actor: 'ACTOR-001' });

    const rawDir = path.join(root, 'topics', 'cuba', 'sources', 'raw');
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(
      path.join(rawDir, 'SRC-001.json'),
      JSON.stringify({ mock: false, matches: [], metadata: { visionApiUsed: true } })
    );

    const [report] = runValidate(root, 'cuba', {});
    expect(report.warnings).toEqual([]);
  });
});
