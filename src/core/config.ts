import * as fs from 'node:fs';
import * as path from 'node:path';
import { TrmConfig, DispatchLimits } from './types';

export const DEFAULT_DISPATCH_LIMITS: DispatchLimits = {
  max_jobs_per_notebook: 3,
  max_jobs_per_run_global: 5,
  default_mode: 'fast',
  cooldown_days_fast: 14,
  cooldown_days_deep: 30,
  max_attempts_before_stall: 3,
  max_consecutive_dispatch_failures: 5,
};

function resolveDispatchLimits(raw: unknown): DispatchLimits {
  const input = (raw ?? {}) as Partial<DispatchLimits>;
  const merged: DispatchLimits = { ...DEFAULT_DISPATCH_LIMITS, ...input };

  if (merged.default_mode !== 'fast' && merged.default_mode !== 'deep') {
    throw new Error(`config.json dispatch_limits.default_mode must be "fast" or "deep", got "${merged.default_mode}"`);
  }
  const numericFields: (keyof DispatchLimits)[] = [
    'max_jobs_per_notebook',
    'max_jobs_per_run_global',
    'cooldown_days_fast',
    'cooldown_days_deep',
    'max_attempts_before_stall',
    'max_consecutive_dispatch_failures',
  ];
  for (const field of numericFields) {
    const value = merged[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new Error(`config.json dispatch_limits.${field} must be a non-negative integer, got ${JSON.stringify(value)}`);
    }
  }
  return merged;
}

export function loadConfig(root: string): TrmConfig {
  const configPath = path.join(root, 'config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`config.json not found at ${configPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  if (raw.actor_source !== 'env' && raw.actor_source !== 'cli-only') {
    throw new Error(`config.json actor_source must be "env" or "cli-only", got "${raw.actor_source}"`);
  }
  if (raw.time_source !== 'system' && raw.time_source !== 'fixed') {
    throw new Error(`config.json time_source must be "system" or "fixed", got "${raw.time_source}"`);
  }
  if (typeof raw.promotion_threshold !== 'number') {
    throw new Error('config.json promotion_threshold must be a number');
  }
  if (typeof raw.default_scoring_adapter !== 'string') {
    throw new Error('config.json default_scoring_adapter must be a string');
  }
  return { ...raw, dispatch_limits: resolveDispatchLimits(raw.dispatch_limits) } as TrmConfig;
}
