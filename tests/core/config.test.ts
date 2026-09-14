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

  it('fills dispatch_limits with defaults when config.json omits it', () => {
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
    expect(config.dispatch_limits).toEqual({
      max_jobs_per_notebook: 3,
      max_jobs_per_run_global: 5,
      default_mode: 'fast',
      cooldown_days_fast: 14,
      cooldown_days_deep: 30,
      max_attempts_before_stall: 3,
      max_consecutive_dispatch_failures: 5,
    });
  });

  it('merges a partial dispatch_limits with defaults for the missing fields', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-'));
    fs.writeFileSync(
      path.join(root, 'config.json'),
      JSON.stringify({
        default_scoring_adapter: 'stub',
        promotion_threshold: 80,
        actor_source: 'env',
        time_source: 'system',
        dispatch_limits: { max_jobs_per_run_global: 10 },
      })
    );
    const config = loadConfig(root);
    expect(config.dispatch_limits.max_jobs_per_run_global).toBe(10);
    expect(config.dispatch_limits.max_jobs_per_notebook).toBe(3);
  });

  it('throws on an invalid dispatch_limits.default_mode', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-'));
    fs.writeFileSync(
      path.join(root, 'config.json'),
      JSON.stringify({
        default_scoring_adapter: 'stub',
        promotion_threshold: 80,
        actor_source: 'env',
        time_source: 'system',
        dispatch_limits: { default_mode: 'bogus' },
      })
    );
    expect(() => loadConfig(root)).toThrow(/default_mode/);
  });
});
