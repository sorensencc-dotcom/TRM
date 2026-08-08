import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
