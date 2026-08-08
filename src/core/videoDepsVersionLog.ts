import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_WHISPER_BIN, getDefaultWhisperModelPath } from './videoDeps';

const execFileAsync = promisify(execFile);

export interface VideoDepsVersionsEntry {
  schema_version: 1;
  topic: string;
  ts: string;
  ffmpegVersion?: string;
  ffprobeVersion?: string;
  whisperVersion?: string;
  whisperModelPath?: string;
  whisperModelSizeBytes?: number;
  whisperModelMtime?: string;
}

function firstNonEmptyLine(text: string): string | undefined {
  return text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

// whisper.cpp's --version output mixes a "load_backend: ..." line (which
// stream it lands on has varied across builds) with the actual
// "whisper.cpp version: X.Y.Z" line -- search both streams for the labeled
// line specifically rather than assuming line order or stream.
function parseWhisperVersion(stdout: string, stderr: string): string | undefined {
  const combined = `${stdout}\n${stderr}`;
  const match = combined.match(/whisper\.cpp version:\s*(\S+)/i);
  if (match) return match[1];
  return firstNonEmptyLine(combined);
}

async function captureVersionOutput(
  cmd: string,
  args: string[]
): Promise<{ stdout: string; stderr: string } | undefined> {
  try {
    const result = await execFileAsync(cmd, args, { timeout: 5000 });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    // Some CLIs exit non-zero for a version flag on older builds -- still
    // surface whatever they printed rather than dropping the field.
    const errObj = err as { stdout?: string; stderr?: string };
    if (typeof errObj?.stdout === 'string' || typeof errObj?.stderr === 'string') {
      return { stdout: errObj.stdout ?? '', stderr: errObj.stderr ?? '' };
    }
    return undefined;
  }
}

/**
 * Best-effort snapshot of the installed video-pipeline dependency versions,
 * for reproducibility when something breaks in the field (e.g. a whisper.cpp
 * CLI arg change between versions -- see the real one this pipeline shipped
 * with, memory/project-trm-video-ingest-shipped-2026-08-08.md). Never
 * throws: a missing or misbehaving binary just leaves that field absent
 * rather than failing the batch, which runs its own real preflight checks
 * (checkFfmpegDeps/checkWhisperDeps) separately anyway.
 */
export async function captureVideoDepsVersions(): Promise<
  Omit<VideoDepsVersionsEntry, 'schema_version' | 'topic' | 'ts'>
> {
  const ffmpegPath = process.env.TRM_FFMPEG_PATH || 'ffmpeg';
  const ffprobePath = process.env.TRM_FFPROBE_PATH || 'ffprobe';
  const whisperBin = process.env.TRM_WHISPER_BIN || DEFAULT_WHISPER_BIN;
  const modelPath = process.env.TRM_WHISPER_MODEL || getDefaultWhisperModelPath();

  const [ffmpegResult, ffprobeResult, whisperResult] = await Promise.all([
    captureVersionOutput(ffmpegPath, ['-version']),
    captureVersionOutput(ffprobePath, ['-version']),
    captureVersionOutput(whisperBin, ['--version']),
  ]);

  const entry: Omit<VideoDepsVersionsEntry, 'schema_version' | 'topic' | 'ts'> = {};
  if (ffmpegResult) entry.ffmpegVersion = firstNonEmptyLine(ffmpegResult.stdout);
  if (ffprobeResult) entry.ffprobeVersion = firstNonEmptyLine(ffprobeResult.stdout);
  if (whisperResult) entry.whisperVersion = parseWhisperVersion(whisperResult.stdout, whisperResult.stderr);

  try {
    const stat = fs.statSync(modelPath);
    entry.whisperModelPath = modelPath;
    entry.whisperModelSizeBytes = stat.size;
    entry.whisperModelMtime = stat.mtime.toISOString();
  } catch {
    // Model file not present -- fine, whisperVersion above already reports
    // whether the binary itself is reachable.
  }

  return entry;
}

function videoDepsVersionsPath(root: string): string {
  return path.join(root, '.trm-ops', 'video-deps-versions.jsonl');
}

export function appendVideoDepsVersions(root: string, entry: VideoDepsVersionsEntry): void {
  const file = videoDepsVersionsPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

export function readVideoDepsVersions(root: string): VideoDepsVersionsEntry[] {
  const file = videoDepsVersionsPath(root);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}
