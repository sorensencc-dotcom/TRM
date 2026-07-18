import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveActor, registerActor } from '../../src/registry/actorRegistry';

function makeRoot(config: object) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  return root;
}

describe('actorRegistry', () => {
  afterEach(() => {
    delete process.env.TRM_ACTOR;
  });

  it('resolves actor from env when actor_source is env', () => {
    const root = makeRoot({ default_scoring_adapter: 'stub', promotion_threshold: 80, actor_source: 'env', time_source: 'system' });
    process.env.TRM_ACTOR = 'ACTOR-001';
    expect(resolveActor(root)).toBe('ACTOR-001');
  });

  it('throws when actor_source is env and TRM_ACTOR unset', () => {
    const root = makeRoot({ default_scoring_adapter: 'stub', promotion_threshold: 80, actor_source: 'env', time_source: 'system' });
    expect(() => resolveActor(root)).toThrow(/TRM_ACTOR/);
  });

  it('requires --actor when actor_source is cli-only, ignores env', () => {
    const root = makeRoot({ default_scoring_adapter: 'stub', promotion_threshold: 80, actor_source: 'cli-only', time_source: 'system' });
    process.env.TRM_ACTOR = 'ACTOR-001';
    expect(() => resolveActor(root)).toThrow(/--actor/);
    expect(resolveActor(root, 'ACTOR-002')).toBe('ACTOR-002');
  });

  it('rejects malformed actor ids', () => {
    const root = makeRoot({ default_scoring_adapter: 'stub', promotion_threshold: 80, actor_source: 'cli-only', time_source: 'system' });
    expect(() => resolveActor(root, 'bob')).toThrow(/ACTOR-/);
  });

  it('registers a new actor exactly once', () => {
    const root = makeRoot({ default_scoring_adapter: 'stub', promotion_threshold: 80, actor_source: 'cli-only', time_source: 'system' });
    registerActor(root, 'ACTOR-001');
    registerActor(root, 'ACTOR-001');
    const registryPath = path.join(root, 'registry', 'actors.json');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    expect(registry.actors).toEqual([{ actor_id: 'ACTOR-001' }]);
  });
});
