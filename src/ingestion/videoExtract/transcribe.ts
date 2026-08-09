import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { whisperPool } from '../../core/concurrency';
import { DEFAULT_WHISPER_BIN, getDefaultWhisperModelPath } from '../../core/videoDeps';

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
// subprocess timeout. Overridable so tests can force a fast, deterministic
// timeout against a real hung whisper-cli process without waiting out the
// real 30s floor. A function, not a module-level const -- read per call, so
// an override set after this module is first imported (e.g. by a test)
// still takes effect.
function getMinTimeoutMs(): number {
  return Number(process.env.TRM_WHISPER_MIN_TIMEOUT_MS) || 30000;
}

// Timeout scales with source duration (whisper transcription is roughly
// linear in audio length on CPU): max(30s, durationMs * 0.5).
function computeTimeoutMs(durationMs: number | undefined): number {
  const minTimeoutMs = getMinTimeoutMs();
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) {
    return minTimeoutMs;
  }
  return Math.max(minTimeoutMs, Math.round(durationMs * 0.5));
}

/**
 * Transcribe an audio file using the whisper.cpp CLI. Runs a single subprocess
 * call under `whisperPool` (TRM_WHISPER_CONCURRENCY, default 1 -- deliberately
 * serialized, whisper is the heaviest local workload per file).
 *
 * The binary name and model path defaults are imported from
 * `src/core/videoDeps.ts` so this call site can never drift from what
 * `checkWhisperDeps()` preflighted. Both assume whisper.cpp (ggml `.bin`
 * model, `-m/-f/-nt` argument syntax), not the openai-whisper Python CLI.
 *
 * The file passed in MUST be an audio file whisper.cpp can decode -- stock
 * whisper.cpp reads WAV only (via `dr_wav`); ffmpeg-based container decoding
 * is a non-default build flag. Callers pass the 16kHz mono WAV produced by
 * `extractAudio()` (which selects audio stream index 0, per CONTEXT.md #5),
 * NOT the original `.mp4`/`.mov` video file.
 *
 * @param filePath Path to the WAV audio file to transcribe.
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
  const whisperBin = process.env.TRM_WHISPER_BIN || DEFAULT_WHISPER_BIN;
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

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

const SEGMENT_LINE_PATTERN =
  /^\[(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})\]\s*(.*)$/;

function segmentTimestampToMs(h: string, m: string, s: string, ms: string): number {
  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(ms);
}

/**
 * Parses whisper.cpp's default timestamped stdout format into segments.
 * Defensive by design: skips any line that doesn't match the bracket
 * pattern (banner/log lines whisper.cpp also writes to stdout) rather than
 * throwing, and accumulates trailing non-bracket lines as continuation text
 * for the most recently opened segment (whisper wraps long segments across
 * multiple lines).
 *
 * Diagnostic line heuristic: lines that match the pattern `key: value = ...`
 * (detected by the regex `:\s+\w+\s*=`) are assumed to be whisper.cpp debug
 * output and are NOT accumulated as continuation text. This preserves real
 * transcribed speech even if it contains an isolated `=` symbol (e.g. "A equals B").
 * The pattern `: ` (colon-space) + `=` is sufficiently specific to diagnostic
 * output that false negatives (dropping real transcribed text) are minimal.
 */
export function parseWhisperSegments(stdout: string): TranscriptSegment[] {
  const diagnosticLinePattern = /:\s+\w+\s*=/;
  const segments: TranscriptSegment[] = [];
  let current: TranscriptSegment | null = null;

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const match = SEGMENT_LINE_PATTERN.exec(line);
    if (match) {
      const [, h1, m1, s1, ms1, h2, m2, s2, ms2, text] = match;
      current = {
        startMs: segmentTimestampToMs(h1, m1, s1, ms1),
        endMs: segmentTimestampToMs(h2, m2, s2, ms2),
        text: text.trim(),
      };
      segments.push(current);
    } else if (current && line.trim().length > 0 && !diagnosticLinePattern.test(line)) {
      current.text = `${current.text} ${line.trim()}`.trim();
    }
  }

  return segments;
}

/**
 * Segment-aware sibling of transcribeAudio(), additive not a replacement --
 * only invoked when keyword filtering needs match windows. Omits whisper's
 * -nt flag so it emits timestamped segments instead of a plain string.
 */
export async function transcribeAudioWithSegments(
  filePath: string,
  durationMs?: number
): Promise<{ text: string; segments: TranscriptSegment[] }> {
  const whisperBin = process.env.TRM_WHISPER_BIN || DEFAULT_WHISPER_BIN;
  const modelPath = process.env.TRM_WHISPER_MODEL || getDefaultWhisperModelPath();
  const timeoutMs = computeTimeoutMs(durationMs);

  const args = ['-m', modelPath, '-f', filePath];

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

  const segments = parseWhisperSegments(stdout);
  const text = segments.map((s) => s.text).join(' ').trim();
  return { text, segments };
}
