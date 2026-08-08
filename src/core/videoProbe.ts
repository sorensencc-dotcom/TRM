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

export interface ProbeResult {
  durationMs: number;
  hasAudioStream: boolean;
}

/**
 * Probe a video file using ffprobe to extract duration and audio stream presence.
 *
 * @param filePath Path to the video file to probe
 * @returns Promise resolving to duration (milliseconds) and audio stream presence
 * @throws Error if ffprobe fails, times out, or produces unparseable output
 */
export async function probeVideo(filePath: string): Promise<ProbeResult> {
  const ffprobePath = process.env.TRM_FFPROBE_PATH || 'ffprobe';

  try {
    const { stdout } = await execFileAsync(
      ffprobePath,
      [
        '-v', 'error',
        '-show_entries', 'format=duration:stream=codec_type',
        '-of', 'json',
        filePath
      ],
      { timeout: 10000 }
    );

    let probeData: any;
    try {
      probeData = JSON.parse(stdout);
    } catch (parseErr) {
      throw new Error(`Failed to parse ffprobe JSON output: ${String(parseErr)}`);
    }

    if (!probeData || typeof probeData !== 'object') {
      throw new Error('Invalid ffprobe output: expected object');
    }

    // Extract duration from format section (in seconds, convert to milliseconds)
    const durationValue = probeData.format?.duration;
    if (durationValue === undefined) {
      throw new Error('Invalid ffprobe output: format.duration is missing');
    }

    // Parse duration (can be string or number from ffprobe JSON)
    let durationSeconds: number;
    if (typeof durationValue === 'string') {
      durationSeconds = parseFloat(durationValue);
      if (isNaN(durationSeconds)) {
        throw new Error('Invalid ffprobe output: format.duration is not a valid number');
      }
    } else if (typeof durationValue === 'number') {
      durationSeconds = durationValue;
    } else {
      throw new Error('Invalid ffprobe output: format.duration is not a number or string');
    }

    const durationMs = Math.round(durationSeconds * 1000);

    // Check if any stream has codec_type 'audio'
    const streams = probeData.streams || [];
    if (!Array.isArray(streams)) {
      throw new Error('Invalid ffprobe output: streams is not an array');
    }

    const hasAudioStream = streams.some((stream: any) => stream.codec_type === 'audio');

    return {
      durationMs,
      hasAudioStream
    };
  } catch (err) {
    const detail = getErrorDetail(err);
    // Re-throw parse errors and timeouts as-is if they already have our context
    if (err instanceof Error && err.message.includes('Invalid ffprobe output')) {
      throw err;
    }
    if (err instanceof Error && err.message.includes('Failed to parse')) {
      throw err;
    }
    // For subprocess errors, wrap with context
    throw new Error(
      `Failed to probe video file "${filePath}": ${detail}`
    );
  }
}
