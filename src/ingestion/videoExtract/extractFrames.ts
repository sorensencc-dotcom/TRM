import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { ffmpegPool } from '../../core/concurrency';

const execFileAsync = promisify(execFile);

// Helper to extract diagnostic text from subprocess error
function getErrorDetail(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const errorObj = err as any;
    if (errorObj.stderr && typeof errorObj.stderr === 'string') {
      return errorObj.stderr;
    }
    if (errorObj.message && typeof errorObj.message === 'string') {
      return errorObj.message;
    }
  }
  return String(err);
}

// Duration boundaries (ms) selecting which single-pass ffmpeg strategy to use.
// Exported as the single source of truth: ingestDir.ts derives each returned
// frame's timestamp from these same boundaries, and would silently mislabel
// envelope frame timestamps if it kept its own copy that drifted from these.
export const MIDPOINT_THRESHOLD_MS = 10000; // < 10s -> single midpoint frame
export const FPS_THRESHOLD_MS = 300000; // < 300s (and >= 10s) -> fps=1/10; >= 300s -> evenly-spaced select

// Hard cap on frames produced by the evenly-spaced select-filter strategy for
// long-form video (>= 300s). fps=1/10 never needs this cap: at just under the
// 300s boundary it already tops out at 30 frames (t=0,10,...,290).
export const MAX_SELECT_FRAMES = 30;

// Frames downscaled to fit within a 1024x1024 box, preserving aspect ratio,
// shrinking only (never upscaling smaller source frames).
const SCALE_FILTER = 'scale=1024:1024:force_original_aspect_ratio=decrease';

const FRAME_FILENAME_PATTERN = 'frame-%03d.jpg';
const FRAME_FILENAME_REGEX = /^frame-\d{3}\.jpg$/;

// ffmpeg extraction can take substantially longer than the ffprobe metadata
// read (probeVideo uses 10s) -- decoding + scaling + writing up to 30 frames
// from an arbitrarily long source file. 2 minutes gives real-world headroom
// without hanging indefinitely on a stuck subprocess.
const FFMPEG_TIMEOUT_MS = 120000;

/**
 * Extract a bounded, evenly-representative set of frames from a video file
 * in a single ffmpeg invocation. Strategy is selected by duration:
 *  - < 10s: single midpoint frame
 *  - < 300s (and >= 10s): fps=1/10 (1 frame per 10s of source)
 *  - >= 300s: evenly-spaced frames via a `select` filter, capped at 30
 *
 * Frames are downscaled to a 1024px max long edge in the same ffmpeg call.
 * Runs under `ffmpegPool` (TRM_FFMPEG_CONCURRENCY, default 2).
 *
 * @param filePath Path to the source video file
 * @param durationMs Video duration in milliseconds (from probeVideo)
 * @param tempDir Directory to write extracted frame image files into
 * @returns Promise resolving to the written frame file paths, in order
 * @throws Error if ffmpeg fails, times out, or writes no frames
 */
export async function extractFrames(
  filePath: string,
  durationMs: number,
  tempDir: string
): Promise<string[]> {
  const ffmpegPath = process.env.TRM_FFMPEG_PATH || 'ffmpeg';
  const outputPattern = path.join(tempDir, FRAME_FILENAME_PATTERN);
  const args = buildFfmpegArgs(filePath, durationMs, outputPattern);

  try {
    await ffmpegPool(() =>
      execFileAsync(ffmpegPath, args, { timeout: FFMPEG_TIMEOUT_MS })
    );
  } catch (err) {
    const detail = getErrorDetail(err);
    throw new Error(
      `Failed to extract frames from video file "${filePath}": ${detail}`
    );
  }

  const entries = await fs.promises.readdir(tempDir);
  const framePaths = entries
    .filter((name) => FRAME_FILENAME_REGEX.test(name))
    .sort()
    .map((name) => path.join(tempDir, name));

  // ffmpeg can exit 0 while writing nothing (unusual codec, a select
  // expression that matched no frames). Frame sampling is unconditional for
  // every video (CONTEXT.md #6), so an empty result is a real extraction
  // failure, not a valid low-signal outcome -- throw so it routes through the
  // caller's failedStore path and is revisitable via --retry-failed, rather
  // than being recorded as a successful video with zero frames.
  if (framePaths.length === 0) {
    throw new Error(`ffmpeg produced no frames for video file "${filePath}"`);
  }

  return framePaths;
}

/**
 * Build the single ffmpeg argument list for the given duration's strategy.
 * Exported for direct unit testing of strategy-selection logic.
 */
export function buildFfmpegArgs(
  filePath: string,
  durationMs: number,
  outputPattern: string
): string[] {
  if (durationMs < MIDPOINT_THRESHOLD_MS) {
    const midpointSeconds = (durationMs / 2 / 1000).toFixed(3);
    return [
      '-ss', midpointSeconds,
      '-i', filePath,
      '-vframes', '1',
      '-vf', SCALE_FILTER,
      '-y',
      outputPattern
    ];
  }

  if (durationMs < FPS_THRESHOLD_MS) {
    return [
      '-i', filePath,
      '-vf', `fps=1/10,${SCALE_FILTER}`,
      '-vsync', 'vfr',
      '-y',
      outputPattern
    ];
  }

  // >= 300s: evenly-spaced frames via `select`, spread across the full
  // duration and capped at MAX_SELECT_FRAMES via -frames:v as a hard backstop
  // (the select expression's step already targets ~MAX_SELECT_FRAMES frames,
  // but -frames:v guarantees the cap regardless of rounding).
  const durationSeconds = durationMs / 1000;
  const stepSeconds = (durationSeconds / MAX_SELECT_FRAMES).toFixed(3);
  return [
    '-i', filePath,
    '-vf', `select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,${stepSeconds})',${SCALE_FILTER}`,
    '-vsync', 'vfr',
    '-frames:v', String(MAX_SELECT_FRAMES),
    '-y',
    outputPattern
  ];
}
