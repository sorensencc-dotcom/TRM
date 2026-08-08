import * as fs from 'node:fs';
import * as path from 'node:path';
import { FrameAnalysis } from '../ingestion/videoExtract/analyzeFrames';

// Content-hash-keyed sidecar recording whichever of the two concurrent video
// branches (transcript, frame analysis) already succeeded on a prior run of
// this exact file. --retry-failed (and any plain rerun -- a failed video was
// never marked done, so it's reprocessed either way) previously redid BOTH
// branches from scratch even when only one had actually failed, discarding
// real completed work (a paid-for Vision API pass, a real whisper
// transcription) every time. Keyed by content hash, not file path, so a
// changed source file (different hash) never reuses stale progress.
export interface VideoPartialProgress {
  transcript?: string;
  frameAnalyses?: FrameAnalysis[];
}

function partialProgressPath(root: string, hash: string): string {
  return path.join(root, '.trm-ops', 'video-partial', `${hash}.json`);
}

export function readVideoPartialProgress(root: string, hash: string): VideoPartialProgress | null {
  const file = partialProgressPath(root, hash);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    // Corrupt/partially-written sidecar -- treat as no cached progress
    // rather than failing the whole retry over stale bookkeeping.
    return null;
  }
}

export function writeVideoPartialProgress(root: string, hash: string, progress: VideoPartialProgress): void {
  const file = partialProgressPath(root, hash);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(progress));
}

export function clearVideoPartialProgress(root: string, hash: string): void {
  const file = partialProgressPath(root, hash);
  fs.rmSync(file, { force: true });
}
