import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCreate } from '../../src/cli/commands/create';
import { runIngest } from '../../src/cli/commands/ingest';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ default_scoring_adapter: 'stub', promotion_threshold: 80, actor_source: 'cli-only', time_source: 'system' }));
  return root;
}

describe('runIngest', () => {
  it('ingests a source and marks the node active', () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    const entry = runIngest(root, 'cuba', { actor: 'ACTOR-001', type: 'pdf', title: 'Overview', origin: 'LOC', url: 'x' });
    expect(entry?.id).toBe('SRC-001');
  });

  it('dry-run writes nothing', () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    const entry = runIngest(root, 'cuba', { actor: 'ACTOR-001', type: 'pdf', title: 'Overview', origin: 'LOC', url: 'x', dryRun: true });
    expect(entry).toBeNull();
    const metadataPath = path.join(root, 'topics', 'cuba', 'sources', 'metadata.json');
    expect(fs.existsSync(metadataPath)).toBe(false);
  });
});
