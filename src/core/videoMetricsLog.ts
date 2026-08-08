import * as fs from 'node:fs';
import * as path from 'node:path';

export interface VideoMetricsEntry {
  schema_version: 1;
  topic: string;
  file: string;
  outcome: 'success' | 'failure';
  ms: number;
  ts: string;
  // Present once probeVideo() has succeeded -- absent on a failure that
  // occurred before or during probing (cap rejection, corrupt media).
  durationMs?: number;
  hasAudioStream?: boolean;
  // Present only on outcome: 'success' -- analyzeFrames()/transcribeAudio()
  // never partially report on a failed video (a Vision or whisper failure
  // rejects the whole pipeline for that video, per the fail-fast design in
  // analyzeFrames.ts), so these are only meaningful once the video actually
  // succeeded.
  frameCount?: number;
  transcriptStatus?: 'transcribed' | 'empty' | 'no-audio';
  // Always 0 today: analyzeFrames() throws on the first Vision failure
  // rather than collecting partial results, so a video with any Vision
  // failure never reaches the success path this field is recorded on.
  // Reserved for when/if that fail-fast behavior changes to a
  // collect-partial-results one.
  visionFailureCount?: number;
  error?: string;
}

function videoMetricsPath(root: string): string {
  return path.join(root, '.trm-ops', 'video-metrics.jsonl');
}

export function appendVideoMetrics(root: string, entry: VideoMetricsEntry): void {
  const file = videoMetricsPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

export function readVideoMetrics(root: string): VideoMetricsEntry[] {
  const file = videoMetricsPath(root);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}
