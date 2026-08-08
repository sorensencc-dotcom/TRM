import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

export const AUDIO_FILENAME = 'audio.wav';

// whisper.cpp expects 16kHz mono PCM.
const SAMPLE_RATE = '16000';
const CHANNELS = '1';

// Audio-only transcode of an arbitrarily long source. Same order of magnitude
// as frame extraction's budget (extractFrames.ts uses 120s); audio decode is
// cheaper than decode+scale+write of 30 frames, but a long source still needs
// real headroom. Overridable so tests can force a fast, deterministic timeout
// against a real hung ffmpeg process without waiting out the real default. A
// function, not a module-level const -- read per call, so an override set
// after this module is first imported (e.g. by a test) still takes effect.
function getFfmpegAudioTimeoutMs(): number {
  return Number(process.env.TRM_FFMPEG_AUDIO_TIMEOUT_MS) || 120000;
}

/**
 * Extract a video file's first audio stream into a 16kHz mono WAV file that
 * whisper.cpp can actually read.
 *
 * Stock whisper.cpp decodes WAV only (`dr_wav`); it cannot open `.mp4`/`.mov`
 * containers, so this step is mandatory before `transcribeAudio()`. Stream
 * selection is explicit (`-map 0:a:0`) -- v1 transcribes audio stream index 0
 * only and ignores any additional streams (CONTEXT.md #5/#6).
 *
 * Runs under `ffmpegPool` (TRM_FFMPEG_CONCURRENCY, default 2) and honors
 * `TRM_FFMPEG_PATH`, matching extractFrames.ts.
 *
 * @param filePath Path to the source video file
 * @param tempDir Per-video temp directory to write the WAV into (the caller
 *   owns its creation and `finally`-block cleanup)
 * @returns Promise resolving to the written WAV file path
 * @throws Error if ffmpeg fails or times out
 */
export async function extractAudio(filePath: string, tempDir: string): Promise<string> {
  const ffmpegPath = process.env.TRM_FFMPEG_PATH || 'ffmpeg';
  const outputPath = path.join(tempDir, AUDIO_FILENAME);

  const args = [
    '-i', filePath,
    '-map', '0:a:0',
    '-vn',
    '-ar', SAMPLE_RATE,
    '-ac', CHANNELS,
    '-f', 'wav',
    '-y',
    outputPath
  ];

  try {
    await ffmpegPool(() =>
      execFileAsync(ffmpegPath, args, { timeout: getFfmpegAudioTimeoutMs() })
    );
  } catch (err) {
    const detail = getErrorDetail(err);
    throw new Error(
      `Failed to extract audio from video file "${filePath}": ${detail}`
    );
  }

  return outputPath;
}
