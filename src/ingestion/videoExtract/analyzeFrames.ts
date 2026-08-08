import fs from 'node:fs';
import { frameAnalysisPool, visionPool } from '../../core/concurrency';
import { Label } from '../imageExtract/imageAnalyzer';

// Minimal shape this module depends on -- deliberately not importing the
// concrete ImageAnalyzer class as the parameter type so any object exposing
// a compatible extract() (real service client, test double, future wrapper)
// can be injected. Task 5.3 (batch pipeline wiring) constructs the real
// instance and passes it in; this module never constructs its own.
export interface FrameAnalyzer {
  extract(imageBuffer: Buffer): Promise<{ labels: Label[] }>;
}

export interface FrameAnalysis {
  timestampMs: number;
  labels: Label[];
}

/**
 * Analyze extracted video frames with bounded per-video concurrency, reading,
 * analyzing, and deleting each frame file immediately after its own Vision
 * call resolves (never holding all frames on disk/in memory at once).
 *
 * `framePaths` and `timestampsMs` are parallel arrays (same index = same
 * frame) -- Task 3.1's extractFrames() returns only file paths, so the
 * caller derives timestamps separately and passes both in here. Input order
 * is not assumed to be timestamp-sorted; the returned array is always sorted
 * ascending by timestampMs regardless of input or completion order.
 *
 * Concurrency nesting: frameAnalysisPool (TRM_FRAME_ANALYSIS_CONCURRENCY,
 * default 3) bounds how many of THIS video's frames are in flight at once,
 * independent of visionPool's own batch-wide bound (shared with the photo
 * ingest path in ingestDir.ts). Each frame's actual analyzer.extract() call
 * still goes through visionPool, so the network-call-rate limit that pool
 * enforces across the whole batch is respected.
 *
 * @param framePaths File paths of extracted frames (e.g. from extractFrames())
 * @param timestampsMs Parallel array of each frame's timestamp in the source video
 * @param analyzer Injected analyzer instance (constructed by the caller)
 * @returns Promise resolving to per-frame analysis results, ascending by timestampMs
 */
export async function analyzeFrames(
  framePaths: string[],
  timestampsMs: number[],
  analyzer: FrameAnalyzer
): Promise<FrameAnalysis[]> {
  const results = await Promise.all(
    framePaths.map((framePath, index) =>
      frameAnalysisPool(async () => {
        const timestampMs = timestampsMs[index];
        const buffer = await fs.promises.readFile(framePath);
        try {
          const result = await visionPool(() => analyzer.extract(buffer));
          return { timestampMs, labels: result.labels };
        } finally {
          await fs.promises.unlink(framePath).catch(() => undefined);
        }
      })
    )
  );

  return results.sort((a, b) => a.timestampMs - b.timestampMs);
}
