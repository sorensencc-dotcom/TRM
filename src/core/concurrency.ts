import pLimit from 'p-limit';

const DEFAULT_CONCURRENCY = 4;

function configuredLimit(name: string): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_CONCURRENCY;
}

export const visionPool = pLimit(configuredLimit('TRM_VISION_CONCURRENCY'));
export const claudePool = pLimit(configuredLimit('TRM_CLAUDE_CONCURRENCY'));
export const docPool = pLimit(configuredLimit('TRM_DOC_CONCURRENCY'));
export const pdfOcrPool = pLimit(configuredLimit('TRM_PDF_OCR_CONCURRENCY'));
export const pdfRenderPool = pLimit(configuredLimit('TRM_PDF_RENDER_CONCURRENCY'));

// ffmpeg extraction has its own default (2, not the shared DEFAULT_CONCURRENCY
// of 4) -- CPU-bound transcoding work is heavier per-slot than the I/O-bound
// pools above, so it gets its own inline default rather than sharing
// configuredLimit()'s constant. Mirrors the ioLimit idiom in
// src/cli/commands/ingestDir.ts (`pLimit(Number(process.env.X) || N)`).
export const ffmpegPool = pLimit(Number(process.env.TRM_FFMPEG_CONCURRENCY) || 2);

// Bounds how many frames of a SINGLE video are submitted/in-flight for
// analysis at once. Sits in front of visionPool: frameAnalysisPool bounds
// per-video fan-out (default 3), visionPool remains the shared, batch-wide
// network-call-rate limiter used by both the photo path and this pool's
// eventual analyzer.extract() calls. Deliberately separate knobs -- see
// analyzeFrames.ts for how they nest.
export const frameAnalysisPool = pLimit(Number(process.env.TRM_FRAME_ANALYSIS_CONCURRENCY) || 3);

// Whisper transcription is deliberately serialized by default (concurrency 1)
// -- it is the heaviest single local workload per video (CONTEXT.md #7).
// Unlike the pools above, TRM_WHISPER_CONCURRENCY intentionally does NOT fall
// back to DEFAULT_CONCURRENCY/configuredLimit(); its own default is 1.
export const whisperPool = pLimit(Number(process.env.TRM_WHISPER_CONCURRENCY) || 1);
