import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCreate } from '../../src/cli/commands/create';
import { runVersionBump } from '../../src/cli/commands/versionBump';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ default_scoring_adapter: 'stub', promotion_threshold: 80, actor_source: 'cli-only', time_source: 'system' }));
  return root;
}

describe('runVersionBump', () => {
  it('bumps patch/minor/major correctly', () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    expect(runVersionBump(root, 'cuba', 'patch', { actor: 'ACTOR-001' })).toBe('1.0.1');
    expect(runVersionBump(root, 'cuba', 'minor', { actor: 'ACTOR-001' })).toBe('1.1.0');
    expect(runVersionBump(root, 'cuba', 'major', { actor: 'ACTOR-001' })).toBe('2.0.0');
  });
});
