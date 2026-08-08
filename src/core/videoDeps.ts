import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

async function checkCommand(
  command: string,
  envVarName: string
): Promise<void> {
  const pathFromEnv = process.env[envVarName];
  const cmdToRun = pathFromEnv || command;

  try {
    await execFileAsync(cmdToRun, ['-version']);
  } catch (err) {
    if (pathFromEnv) {
      throw new Error(
        `Failed to find ${command} at configured path "${pathFromEnv}" (env var ${envVarName}). Ensure ${envVarName} points to a valid ${command} binary or unset it to use PATH lookup.`
      );
    } else {
      throw new Error(
        `${command} not found in PATH. Set env var ${envVarName} to specify a custom path to ${command}.`
      );
    }
  }
}

export async function checkFfmpegDeps(): Promise<void> {
  await checkCommand('ffmpeg', 'TRM_FFMPEG_PATH');
  await checkCommand('ffprobe', 'TRM_FFPROBE_PATH');
}
