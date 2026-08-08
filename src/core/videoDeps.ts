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

// Helper to get default whisper model path
function getDefaultWhisperModelPath(): string {
  const homeDir = os.homedir();
  return path.join(homeDir, '.cache', 'whisper', 'base.en.pt');
}

// Helper to check whisper binary and model file
async function checkWhisperBinary(): Promise<void> {
  const pathFromEnv = process.env.TRM_WHISPER_BIN;
  const cmdToRun = pathFromEnv || 'whisper';

  try {
    await execFileAsync(cmdToRun, ['-h'], { timeout: 5000 });
  } catch (err) {
    const detail = getErrorDetail(err);
    if (pathFromEnv) {
      throw new Error(
        `Failed to find whisper at configured path "${pathFromEnv}" (env var TRM_WHISPER_BIN). Ensure TRM_WHISPER_BIN points to a valid whisper binary or unset it to use PATH lookup. Details: ${detail}`
      );
    } else {
      throw new Error(
        `whisper not found in PATH. Set env var TRM_WHISPER_BIN to specify a custom path to whisper. Details: ${detail}`
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
