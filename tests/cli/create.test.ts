import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCreate } from '../../src/cli/commands/create';

describe('runCreate', () => {
  it('creates a node and returns its meta', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-'));
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ default_scoring_adapter: 'stub', promotion_threshold: 80, actor_source: 'cli-only', time_source: 'system' }));
    const meta = runCreate(root, 'cuba/industry', { actor: 'ACTOR-001', description: 'Cuban industry' });
    expect(meta.path).toBe('cuba/industry');
    expect(meta.description).toBe('Cuban industry');
  });
});
