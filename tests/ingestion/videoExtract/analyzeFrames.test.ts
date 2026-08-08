import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { analyzeFrames as AnalyzeFramesFn, FrameAnalyzer } from '../../../src/ingestion/videoExtract/analyzeFrames';
import type { Label } from '../../../src/ingestion/imageExtract/imageAnalyzer';

// frameAnalysisPool / visionPool are module-level singletons sized from env
// vars read at import time (see src/core/concurrency.ts). To isolate
// frameAnalysisPool's bound from visionPool's own default, set a generously
// large visionPool concurrency before the module graph is loaded, so
// visionPool never becomes the binding constraint in this test.
process.env.TRM_FRAME_ANALYSIS_CONCURRENCY = '3';
process.env.TRM_VISION_CONCURRENCY = '100';

// Require after env vars are set (imports would otherwise hoist above the
// process.env assignments).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { analyzeFrames } = require('../../../src/ingestion/videoExtract/analyzeFrames') as {
  analyzeFrames: typeof AnalyzeFramesFn;
};

const FRAME_COUNT = 30;
const FRAME_ANALYSIS_CONCURRENCY = 3;

describe('analyzeFrames', () => {
  let tempDir: string;
  let framePaths: string[];
  let timestampsMs: number[];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-analyze-frames-'));
    framePaths = [];
    timestampsMs = [];
    for (let i = 0; i < FRAME_COUNT; i++) {
      const framePath = path.join(tempDir, `frame-${String(i + 1).padStart(3, '0')}.jpg`);
      fs.writeFileSync(framePath, `fake-frame-${i}`);
      framePaths.push(framePath);
      // Descending timestamps to prove the result is sorted, not just echoed
      // back in input order.
      timestampsMs.push((FRAME_COUNT - i) * 1000);
    }
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('bounds concurrent in-flight extract() calls to TRM_FRAME_ANALYSIS_CONCURRENCY', async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const analyzer: FrameAnalyzer = {
      extract: jest.fn(async (_buffer: Buffer) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight--;
        return { labels: [{ description: 'test', score: 0.9 }] as Label[] };
      }),
    };

    await analyzeFrames(framePaths, timestampsMs, analyzer);

    expect(analyzer.extract).toHaveBeenCalledTimes(FRAME_COUNT);
    expect(maxInFlight).toBeLessThanOrEqual(FRAME_ANALYSIS_CONCURRENCY);
    // Sanity: the pool is actually saturating, not accidentally serializing
    // to 1 (which would also satisfy "<= 3" trivially).
    expect(maxInFlight).toBe(FRAME_ANALYSIS_CONCURRENCY);
  });

  it('deletes each frame file immediately, none left on disk after resolving', async () => {
    const analyzer: FrameAnalyzer = {
      extract: jest.fn(async (_buffer: Buffer) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { labels: [] as Label[] };
      }),
    };

    await analyzeFrames(framePaths, timestampsMs, analyzer);

    for (const framePath of framePaths) {
      expect(fs.existsSync(framePath)).toBe(false);
    }
  });

  it('deletes a frame file as soon as its own extract() resolves, not batched at the end', async () => {
    const deletedAtCall: number[] = [];
    let callIndex = 0;

    const analyzer: FrameAnalyzer = {
      extract: jest.fn(async (_buffer: Buffer) => {
        const myCall = callIndex++;
        // Stagger delays so calls resolve at different times.
        await new Promise((resolve) => setTimeout(resolve, 5 + myCall));
        return { labels: [] as Label[] };
      }),
    };

    const resultPromise = analyzeFrames(framePaths, timestampsMs, analyzer);

    // Poll disk state while the batch is still running: at no point should
    // all 30 files still be present once at least one extract() has resolved.
    await new Promise((resolve) => setTimeout(resolve, 40));
    const stillPresentMidRun = framePaths.filter((p) => fs.existsSync(p)).length;

    await resultPromise;

    expect(stillPresentMidRun).toBeLessThan(FRAME_COUNT);
    void deletedAtCall;
  });

  it('returns results sorted ascending by timestampMs regardless of input order', async () => {
    const analyzer: FrameAnalyzer = {
      extract: jest.fn(async (_buffer: Buffer) => ({ labels: [] as Label[] })),
    };

    const results = await analyzeFrames(framePaths, timestampsMs, analyzer);

    expect(results).toHaveLength(FRAME_COUNT);
    for (let i = 1; i < results.length; i++) {
      expect(results[i].timestampMs).toBeGreaterThanOrEqual(results[i - 1].timestampMs);
    }
    // Confirm it's not coincidentally sorted -- input timestamps were
    // strictly descending, so ascending output proves a real sort happened.
    const expectedSorted = [...timestampsMs].sort((a, b) => a - b);
    expect(results.map((r) => r.timestampMs)).toEqual(expectedSorted);
  });

  it('propagates labels from each frame analysis into the result', async () => {
    const analyzer: FrameAnalyzer = {
      extract: jest.fn(async (buffer: Buffer) => ({
        labels: [{ description: buffer.toString(), score: 1 }] as Label[],
      })),
    };

    const results = await analyzeFrames(framePaths, timestampsMs, analyzer);

    for (const result of results) {
      expect(result.labels).toHaveLength(1);
      expect(result.labels[0].description).toMatch(/^fake-frame-\d+$/);
    }
  });
});
