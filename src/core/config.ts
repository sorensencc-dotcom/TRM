import * as fs from 'node:fs';
import * as path from 'node:path';
import { TrmConfig } from './types';

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
  return raw as TrmConfig;
}
