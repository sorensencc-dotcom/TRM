import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from '../../src/core/config';

describe('loadConfig', () => {
  it('loads and validates config.json', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-'));
    fs.writeFileSync(
      path.join(root, 'config.json'),
      JSON.stringify({
        default_scoring_adapter: 'stub',
        promotion_threshold: 80,
        actor_source: 'env',
        time_source: 'system',
      })
    );
    const config = loadConfig(root);
    expect(config.promotion_threshold).toBe(80);
    expect(config.actor_source).toBe('env');
  });

  it('throws if config.json is missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-'));
    expect(() => loadConfig(root)).toThrow(/config\.json/);
  });

  it('throws on invalid actor_source', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-'));
    fs.writeFileSync(
      path.join(root, 'config.json'),
      JSON.stringify({
        default_scoring_adapter: 'stub',
        promotion_threshold: 80,
        actor_source: 'bogus',
        time_source: 'system',
      })
    );
    expect(() => loadConfig(root)).toThrow(/actor_source/);
  });
});
