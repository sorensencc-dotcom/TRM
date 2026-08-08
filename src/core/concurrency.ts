import pLimit from 'p-limit';

const DEFAULT_CONCURRENCY = 4;

function configuredLimit(name: string): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_CONCURRENCY;
}

export const visionPool = pLimit(configuredLimit('TRM_VISION_CONCURRENCY'));
export const claudePool = pLimit(configuredLimit('TRM_CLAUDE_CONCURRENCY'));
export const docPool = pLimit(configuredLimit('TRM_DOC_CONCURRENCY'));

// ffmpeg extraction has its own default (2, not the shared DEFAULT_CONCURRENCY
// of 4) -- CPU-bound transcoding work is heavier per-slot than the I/O-bound
// pools above, so it gets its own inline default rather than sharing
// configuredLimit()'s constant. Mirrors the ioLimit idiom in
// src/cli/commands/ingestDir.ts (`pLimit(Number(process.env.X) || N)`).
export const ffmpegPool = pLimit(Number(process.env.TRM_FFMPEG_CONCURRENCY) || 2);
