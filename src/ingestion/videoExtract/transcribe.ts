import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { whisperPool } from '../../core/concurrency';

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

// Node's execFile sets `killed: true` (and typically `signal: 'SIGTERM'`) on
// the thrown error when the child is killed for exceeding `options.timeout`.
// A normal non-zero-exit failure does not set `killed`. Use that to
// differentiate the two failure shapes in the thrown error message.
function isTimeoutError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null) {
    return (err as any).killed === true;
  }
  return false;
}

// Minimum timeout floor, regardless of duration -- guards very short clips
// (and the no-duration-provided case) against an unrealistically tight
// subprocess timeout.
const MIN_TIMEOUT_MS = 30000;

// Timeout scales with source duration (whisper transcription is roughly
// linear in audio length on CPU): max(30s, durationMs * 0.5).
function computeTimeoutMs(durationMs: number | undefined): number {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) {
    return MIN_TIMEOUT_MS;
  }
  return Math.max(MIN_TIMEOUT_MS, Math.round(durationMs * 0.5));
}

// Helper to get default whisper model path -- mirrors
// getDefaultWhisperModelPath() in src/core/videoDeps.ts (checkWhisperDeps),
// which this module's preflight-gated caller has already validated exists
// before the first real transcription call of a batch.
function getDefaultWhisperModelPath(): string {
  const homeDir = os.homedir();
  return path.join(homeDir, '.cache', 'whisper', 'base.en.pt');
}

/**
 * Transcribe the audio track of a video/audio file using whisper. Runs a
 * single subprocess call under `whisperPool` (TRM_WHISPER_CONCURRENCY,
 * default 1 -- deliberately serialized, whisper is the heaviest local
 * workload per file).
 *
 * The file passed in is expected to already carry (or resolve to) a single
 * audio stream at index 0 -- this module does not itself select among
 * multiple audio streams; any multi-stream selection is the caller's
 * responsibility (e.g. an upstream ffmpeg extraction step), consistent with
 * the "one ffprobe/extraction call feeds everything downstream" pattern used
 * elsewhere in this codebase.
 *
 * @param filePath Path to the audio (or video) file to transcribe.
 * @param durationMs Optional source duration in milliseconds, used to size
 *   the subprocess timeout (`max(30s, durationMs * 0.5)`). When omitted, the
 *   30s floor is used. Callers that already have duration from their own
 *   probeVideo() call (e.g. Task 5.3) should pass it through rather than
 *   having this module re-probe the file.
 * @returns Promise resolving to the transcript text. Resolves to '' (not an
 *   error) for silent/no-speech audio.
 * @throws Error if whisper fails or times out. Timeout and non-zero-exit
 *   failures produce distinctly worded messages.
 */
export async function transcribeAudio(
  filePath: string,
  durationMs?: number
): Promise<string> {
  const whisperBin = process.env.TRM_WHISPER_BIN || 'whisper';
  const modelPath = process.env.TRM_WHISPER_MODEL || getDefaultWhisperModelPath();
  const timeoutMs = computeTimeoutMs(durationMs);

  const args = ['-m', modelPath, '-f', filePath, '-nt'];

  let stdout: string;
  try {
    const result = await whisperPool(() =>
      execFileAsync(whisperBin, args, { timeout: timeoutMs })
    );
    stdout = result.stdout;
  } catch (err) {
    const detail = getErrorDetail(err);
    if (isTimeoutError(err)) {
      throw new Error(
        `Whisper transcription timed out after ${timeoutMs}ms for file "${filePath}": ${detail}`
      );
    }
    throw new Error(
      `Whisper transcription process failed for file "${filePath}": ${detail}`
    );
  }

  const text = stdout.trim();
  // Silent/no-speech audio: whisper may exit 0 with empty (or effectively
  // empty) stdout. Return '' rather than throwing.
  return text;
}
