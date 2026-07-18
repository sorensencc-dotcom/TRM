import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCreate } from '../../src/cli/commands/create';
import { runIngest } from '../../src/cli/commands/ingest';
import { runExtract } from '../../src/cli/commands/extract';
import { stubRunner } from '../../src/extraction/stubRunner';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ default_scoring_adapter: 'stub', promotion_threshold: 80, actor_source: 'cli-only', time_source: 'system' }));
  return root;
}

describe('runExtract', () => {
  it('writes extract.json and summary.md from ingested source text', () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    runIngest(root, 'cuba', { actor: 'ACTOR-001', type: 'text', title: 'x', origin: 'x', url: 'x' });
    const rawDir = path.join(root, 'topics', 'cuba', 'sources', 'raw');
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(path.join(rawDir, 'SRC-001.txt'), 'Fact one.\nFact two.\n');

    const result = runExtract(root, 'cuba', { actor: 'ACTOR-001' }, stubRunner);
    expect(result?.facts).toHaveLength(2);
    const extractPath = path.join(root, 'topics', 'cuba', 'extracts', 'extract.json');
    expect(JSON.parse(fs.readFileSync(extractPath, 'utf-8')).facts).toHaveLength(2);
    expect(fs.existsSync(path.join(root, 'topics', 'cuba', 'extracts', 'summary.md'))).toBe(true);
  });

  it('renumbers fact ids globally across multiple sources (no collisions)', () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    runIngest(root, 'cuba', { actor: 'ACTOR-001', type: 'text', title: 'a', origin: 'x', url: 'x' });
    runIngest(root, 'cuba', { actor: 'ACTOR-001', type: 'text', title: 'b', origin: 'x', url: 'x' });
    const rawDir = path.join(root, 'topics', 'cuba', 'sources', 'raw');
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(path.join(rawDir, 'SRC-001.txt'), 'Fact one.\nFact two.\n');
    fs.writeFileSync(path.join(rawDir, 'SRC-002.txt'), 'Fact three.\nFact four.\n');

    const result = runExtract(root, 'cuba', { actor: 'ACTOR-001' }, stubRunner);
    expect(result?.facts).toHaveLength(4);
    const ids = result?.facts.map((f) => f.id);
    expect(ids).toEqual(['FCT-001', 'FCT-002', 'FCT-003', 'FCT-004']);
    expect(new Set(ids).size).toBe(4);
    expect(result?.facts[2].source_id).toBe('SRC-002');
  });

  it('dry-run writes nothing', () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    runIngest(root, 'cuba', { actor: 'ACTOR-001', type: 'text', title: 'x', origin: 'x', url: 'x' });
    const rawDir = path.join(root, 'topics', 'cuba', 'sources', 'raw');
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(path.join(rawDir, 'SRC-001.txt'), 'Fact one.\n');

    const result = runExtract(root, 'cuba', { actor: 'ACTOR-001', dryRun: true }, stubRunner);
    expect(result).toBeNull();
    expect(fs.existsSync(path.join(root, 'topics', 'cuba', 'extracts', 'extract.json'))).toBe(false);
  });
});
