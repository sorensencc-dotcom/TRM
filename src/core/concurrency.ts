import pLimit from 'p-limit';

const DEFAULT_CONCURRENCY = 4;

function configuredLimit(name: string): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_CONCURRENCY;
}

export const visionPool = pLimit(configuredLimit('TRM_VISION_CONCURRENCY'));
export const claudePool = pLimit(configuredLimit('TRM_CLAUDE_CONCURRENCY'));
