import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCreate } from '../../src/cli/commands/create';
import { runIngest } from '../../src/cli/commands/ingest';
import { exportBundle } from '../../src/reporting/exportBundle';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-report-'));
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({ default_scoring_adapter: 'stub', promotion_threshold: 80, actor_source: 'cli-only', time_source: 'system' })
  );
  return root;
}

function writeExtract(root: string, topicPath: string, facts: unknown[]) {
  const dir = path.join(root, 'topics', ...topicPath.split('/'), 'extracts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'extract.json'), JSON.stringify({ facts }));
}

describe('exportBundle', () => {
  it('produces a bundle with correct shape, counts, and unchanged topicPath', () => {
    const root = makeRoot();
    runCreate(root, 'charlie/cuba', { actor: 'ACTOR-001' });
    runIngest(root, 'charlie/cuba', { actor: 'ACTOR-001', type: 'pdf', title: 'Doc', origin: 'LOC', url: 'x' });
    writeExtract(root, 'charlie/cuba', [
      { id: 'FCT-001', text: 'A fact.', source_id: 'SRC-001', confidence: 0.9, categories: ['biography'] },
    ]);

    const bundle = exportBundle(root, 'charlie/cuba');

    expect(bundle.version).toBe('1.0.0');
    expect(bundle.topicPath).toBe('charlie/cuba');
    expect(bundle.sourceCount).toBe(1);
    expect(bundle.factCount).toBe(1);
    expect(bundle.stats).toEqual({ sourceCount: 1, factCount: 1 });
    expect(bundle.facts[0]).toEqual({ text: 'A fact.', sourceId: 'SRC-001', confidence: 0.9, categories: ['biography'] });
    expect(bundle.sources[0].id).toBe('SRC-001');
    expect(bundle.theme).toBe('cic');
  });

  it('flattens a nested topic path into a hyphenated slug', () => {
    const root = makeRoot();
    runCreate(root, 'charlie/cuba', { actor: 'ACTOR-001' });
    const bundle = exportBundle(root, 'charlie/cuba');
    expect(bundle.topicSlug).toBe('charlie-cuba');
  });

  it('treats a missing extract.json as zero facts, not an error', () => {
    const root = makeRoot();
    runCreate(root, 'charlie/cuba', { actor: 'ACTOR-001' });
    const bundle = exportBundle(root, 'charlie/cuba');
    expect(bundle.facts).toEqual([]);
    expect(bundle.factCount).toBe(0);
  });

  it('throws if the topic node does not exist', () => {
    const root = makeRoot();
    expect(() => exportBundle(root, 'nonexistent/topic')).toThrow();
  });

  it('defaults theme to "cic" when not specified', () => {
    const root = makeRoot();
    runCreate(root, 'charlie/cuba', { actor: 'ACTOR-001' });
    const bundle = exportBundle(root, 'charlie/cuba');
    expect(bundle.theme).toBe('cic');
  });
});
