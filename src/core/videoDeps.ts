import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

// Memoized promise for lazy single-flight whisper preflight
let whisperCheckPromise: Promise<void> | null = null;

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

async function checkCommand(
  command: string,
  envVarName: string
): Promise<void> {
  const pathFromEnv = process.env[envVarName];
  const cmdToRun = pathFromEnv || command;

  try {
    await execFileAsync(cmdToRun, ['-version'], { timeout: 5000 });
  } catch (err) {
    const detail = getErrorDetail(err);
    if (pathFromEnv) {
      throw new Error(
        `Failed to find ${command} at configured path "${pathFromEnv}" (env var ${envVarName}). Ensure ${envVarName} points to a valid ${command} binary or unset it to use PATH lookup. Details: ${detail}`
      );
    } else {
      throw new Error(
        `${command} not found in PATH. Set env var ${envVarName} to specify a custom path to ${command}. Details: ${detail}`
      );
    }
  }
}

export async function checkFfmpegDeps(): Promise<void> {
  await checkCommand('ffmpeg', 'TRM_FFMPEG_PATH');
  await checkCommand('ffprobe', 'TRM_FFPROBE_PATH');
}

// Single source of truth for the whisper defaults, shared with
// src/ingestion/videoExtract/transcribe.ts (which imports both of these) so the
// preflight check and the actual transcription call can never drift apart.
//
// The transcription call site uses whisper.cpp CLI argument syntax
// (`-m <model> -f <file> -nt`), so the default binary must be whisper.cpp's
// CLI -- currently named `whisper-cli` (older builds shipped it as `main`).
// A bare `whisper` on PATH is conventionally the openai-whisper *Python* CLI,
// which rejects those flags outright.
export const DEFAULT_WHISPER_BIN = 'whisper-cli';

// whisper.cpp loads ggml-format `.bin` models, not openai-whisper's PyTorch
// `.pt` checkpoints.
export const DEFAULT_WHISPER_MODEL_FILENAME = 'ggml-base.en.bin';

// Helper to get default whisper model path
export function getDefaultWhisperModelPath(): string {
  const homeDir = os.homedir();
  return path.join(homeDir, '.cache', 'whisper', DEFAULT_WHISPER_MODEL_FILENAME);
}

// Helper to check whisper binary and model file
async function checkWhisperBinary(): Promise<void> {
  const pathFromEnv = process.env.TRM_WHISPER_BIN;
  const cmdToRun = pathFromEnv || DEFAULT_WHISPER_BIN;

  try {
    await execFileAsync(cmdToRun, ['-h'], { timeout: 5000 });
  } catch (err) {
    const detail = getErrorDetail(err);
    if (pathFromEnv) {
      throw new Error(
        `Failed to find whisper at configured path "${pathFromEnv}" (env var TRM_WHISPER_BIN). Ensure TRM_WHISPER_BIN points to a valid whisper.cpp binary or unset it to use PATH lookup. Details: ${detail}`
      );
    } else {
      throw new Error(
        `${DEFAULT_WHISPER_BIN} not found in PATH. Set env var TRM_WHISPER_BIN to specify a custom path to the whisper.cpp CLI binary. Details: ${detail}`
      );
    }
  }
}

function checkWhisperModel(): void {
  const modelPathFromEnv = process.env.TRM_WHISPER_MODEL;
  const modelPath = modelPathFromEnv || getDefaultWhisperModelPath();

  if (!existsSync(modelPath)) {
    if (modelPathFromEnv) {
      throw new Error(
        `Failed to find whisper model at configured path "${modelPathFromEnv}" (env var TRM_WHISPER_MODEL). Ensure TRM_WHISPER_MODEL points to a valid model file or unset it to use the default path. Details: ENOENT: no such file or directory, stat '${modelPath}'`
      );
    } else {
      throw new Error(
        `Whisper model not found at default path "${modelPath}". Set env var TRM_WHISPER_MODEL to specify a custom path to a whisper model file. Details: ENOENT: no such file or directory, stat '${modelPath}'`
      );
    }
  }
}

export async function checkWhisperDeps(): Promise<void> {
  // If a check is already in flight, reuse that promise (single-flight memoization)
  if (whisperCheckPromise) {
    return whisperCheckPromise;
  }

  // Create the check promise and memoize it
  whisperCheckPromise = (async () => {
    await checkWhisperBinary();
    checkWhisperModel();
  })();

  // Return the memoized promise (do not reset to null after it resolves)
  return whisperCheckPromise;
}

// Testing utility: reset the memoized promise (not for production use)
export function __resetWhisperCheckForTesting(): void {
  whisperCheckPromise = null;
}

// Without a cap, a pathological source (a mis-tagged multi-hour recording, a
// corrupt file ffprobe still reads *a* duration from) hands extractFrames /
// extractAudio / transcribeAudio an effectively unbounded amount of real
// work -- their own per-call timeouts bound each subprocess individually,
// but transcribeAudio's timeout SCALES WITH durationMs (see transcribe.ts),
// so a bad duration inflates the timeout right along with the workload
// instead of bounding it. These two caps reject before any subprocess work
// starts, mirroring the pdfMaxBytes/pdfMaxPages pattern in fileConvert.ts.
export function getVideoMaxBytes(): number {
  const value = Number.parseInt(process.env.TRM_VIDEO_MAX_BYTES ?? '', 10);
  return Number.isInteger(value) && value > 0 ? value : 5 * 1024 * 1024 * 1024; // 5 GB
}

export function getVideoMaxDurationMs(): number {
  const value = Number.parseInt(process.env.TRM_VIDEO_MAX_DURATION_MS ?? '', 10);
  return Number.isInteger(value) && value > 0 ? value : 2 * 60 * 60 * 1000; // 2 hours
}
