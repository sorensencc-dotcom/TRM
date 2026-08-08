import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCreate } from '../../src/cli/commands/create';
import { runIngestDir } from '../../src/cli/commands/ingestDir';
import * as manifestStore from '../../src/core/manifestStore';
import * as failedStore from '../../src/core/failedStore';
import { hashFile } from '../../src/core/contentHash';
import * as videoDeps from '../../src/core/videoDeps';
import * as videoProbe from '../../src/core/videoProbe';
import * as extractFramesModule from '../../src/ingestion/videoExtract/extractFrames';
import * as analyzeFramesModule from '../../src/ingestion/videoExtract/analyzeFrames';
import * as transcribeModule from '../../src/ingestion/videoExtract/transcribe';
import { readRawEnvelope } from '../../src/core/rawSource';
import { ExtractionRunner } from '../../src/extraction/types';
import { FrameAnalysis } from '../../src/ingestion/videoExtract/analyzeFrames';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-ingestdir-'));
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({
      default_scoring_adapter: 'stub',
      promotion_threshold: 80,
      actor_source: 'cli-only',
      time_source: 'system',
    })
  );
  return root;
}

const FIXTURES_DIR = path.join(__dirname, '../../src/ingestion/imageExtract/fixtures');
const TEXT_DOC_FIXTURE = path.join(FIXTURES_DIR, 'text-doc-valid-scanned-page.png');
const PHOTO_FIXTURE = path.join(FIXTURES_DIR, 'photo-valid-landscape.png');

interface VideoPipelineFixture {
  durationMs: number;
  hasAudioStream: boolean;
  transcript?: string;
  framePaths?: string[];
  frameAnalyses?: FrameAnalysis[];
}

// Mocks the video subprocess-backed modules (ffprobe/ffmpeg/whisper are never
// actually invoked in these tests -- probeVideo/extractFrames/analyzeFrames/
// transcribeAudio/checkWhisperDeps are all stubbed at the module boundary,
// matching the existing checkFfmpegDeps spy convention used elsewhere in this
// file). Returns the spies so a test can assert call counts/args or override
// one to reject for the failure-path test.
function mockVideoPipeline(fixture: VideoPipelineFixture) {
  const probeSpy = jest.spyOn(videoProbe, 'probeVideo').mockResolvedValue({
    durationMs: fixture.durationMs,
    hasAudioStream: fixture.hasAudioStream,
  });
  const extractSpy = jest
    .spyOn(extractFramesModule, 'extractFrames')
    .mockResolvedValue(fixture.framePaths ?? ['frame-000.jpg']);
  const analyzeSpy = jest
    .spyOn(analyzeFramesModule, 'analyzeFrames')
    .mockResolvedValue(
      fixture.frameAnalyses ?? [{ timestampMs: 0, labels: [{ description: 'object', score: 0.7 }] }]
    );
  const transcribeSpy = jest
    .spyOn(transcribeModule, 'transcribeAudio')
    .mockResolvedValue(fixture.transcript ?? '');
  const whisperDepsSpy = jest.spyOn(videoDeps, 'checkWhisperDeps').mockResolvedValue();

  return { probeSpy, extractSpy, analyzeSpy, transcribeSpy, whisperDepsSpy };
}

function restoreVideoPipelineMocks(spies: ReturnType<typeof mockVideoPipeline>) {
  spies.probeSpy.mockRestore();
  spies.extractSpy.mockRestore();
  spies.analyzeSpy.mockRestore();
  spies.transcribeSpy.mockRestore();
  spies.whisperDepsSpy.mockRestore();
}

function makeRunSpyRunner(): { runner: ExtractionRunner; runSpy: jest.Mock } {
  const runSpy = jest.fn().mockReturnValue({ facts: [], summary: 'video summary' });
  return { runner: { run: runSpy }, runSpy };
}

describe('runIngestDir', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/analyze/ocr')) {
        return {
          ok: true,
          json: async () => ({
            text: 'Scanned doc page with historical records.',
            metadata: {
              format: 'png',
              size: 59,
              processedAt: new Date().toISOString(),
              latencyMs: 15,
            },
          }),
        };
      }
      if (url.includes('/api/analyze/image')) {
        return {
          ok: true,
          json: async () => ({
            matches: [
              { url: 'https://example.com/landscape.jpg', similarity: 90, source: 'vision_search' },
            ],
            metadata: {
              format: 'png',
              size: 59,
              processedAt: new Date().toISOString(),
              visionApiUsed: true,
              latencyMs: 25,
              apiProvider: 'google_vision',
            },
          }),
        };
      }
      return { ok: false, status: 404, text: async () => 'Not found' };
    }) as any;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('fresh directory ingest processes all files', async () => {
    const root = makeRoot();
    runCreate(root, 'topic1', { actor: 'ACTOR-001' });

    const dir = path.join(root, 'input-dir');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'doc1.txt'), 'Content for doc 1', 'utf-8');
    fs.writeFileSync(path.join(dir, 'doc2.txt'), 'Content for doc 2', 'utf-8');

    const summary = await runIngestDir(
      root,
      'topic1',
      { actor: 'ACTOR-001', dir, stub: true }
    );

    expect(summary.totalFiles).toBe(2);
    expect(summary.successCount).toBe(2);
    expect(summary.duplicateCount).toBe(0);
    expect(summary.failureCount).toBe(0);
  });

  it('re-running skips duplicates and logs/counts them', async () => {
    const root = makeRoot();
    runCreate(root, 'topic1', { actor: 'ACTOR-001' });

    const dir = path.join(root, 'input-dir');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'doc1.txt'), 'Same content for dedup test', 'utf-8');

    const firstRun = await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true });
    expect(firstRun.successCount).toBe(1);
    expect(firstRun.duplicateCount).toBe(0);

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    const secondRun = await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true });
    consoleSpy.mockRestore();

    expect(secondRun.successCount).toBe(0);
    expect(secondRun.duplicateCount).toBe(1);
  });

  it('--force reprocesses already ingested files', async () => {
    const root = makeRoot();
    runCreate(root, 'topic1', { actor: 'ACTOR-001' });

    const dir = path.join(root, 'input-dir');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'doc1.txt'), 'Content for force test', 'utf-8');

    await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true });

    const forcedRun = await runIngestDir(
      root,
      'topic1',
      { actor: 'ACTOR-001', dir, force: true, stub: true }
    );

    expect(forcedRun.successCount).toBe(1);
    expect(forcedRun.duplicateCount).toBe(0);
  });

  it('a text-doc-shaped fixture produces non-empty facts', async () => {
    const root = makeRoot();
    runCreate(root, 'topic1', { actor: 'ACTOR-001' });

    const dir = path.join(root, 'input-dir');
    fs.mkdirSync(dir);

    const docPhotoPath = path.join(dir, 'scanned.png');
    fs.copyFileSync(TEXT_DOC_FIXTURE, docPhotoPath);

    const summary = await runIngestDir(
      root,
      'topic1',
      { actor: 'ACTOR-001', dir, kind: 'text-doc', stub: true }
    );

    expect(summary.successCount).toBe(1);

    const hash = await hashFile(docPhotoPath);
    const extractPayload = manifestStore.readExtract<{ facts: any[]; summary: string }>(
      root,
      'topic1',
      hash
    );

    expect(extractPayload).not.toBeNull();
    expect(extractPayload?.facts.length).toBeGreaterThan(0);
    expect(extractPayload?.summary).toBeTruthy();
  });

  it('records OCR latency and retry count to ocr-timing.jsonl', async () => {
    const root = makeRoot();
    runCreate(root, 'topic1', { actor: 'ACTOR-001' });

    const dir = path.join(root, 'input-dir');
    fs.mkdirSync(dir);
    fs.copyFileSync(TEXT_DOC_FIXTURE, path.join(dir, 'scanned.png'));

    let callCount = 0;
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/analyze/ocr')) {
        callCount++;
        if (callCount === 1) {
          return { ok: false, status: 500, text: async () => 'transient failure' };
        }
        return {
          ok: true,
          json: async () => ({
            text: 'Scanned doc page with historical records.',
            metadata: { format: 'png', size: 59, processedAt: new Date().toISOString(), latencyMs: 15 },
          }),
        };
      }
      return { ok: false, status: 404, text: async () => 'Not found' };
    }) as any;

    await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, kind: 'text-doc', stub: true });

    const timingFile = path.join(root, '.trm-ops', 'ocr-timing.jsonl');
    const lines = fs.readFileSync(timingFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatchObject({ schema_version: 1, topic: 'topic1', file: 'scanned.png', source_type: 'png', ms: 15, retries: 1, outcome: 'success' });
  });

  it('a photo-shaped fixture produces zero facts but a stored vision-analysis result', async () => {
    const root = makeRoot();
    runCreate(root, 'topic1', { actor: 'ACTOR-001' });

    const dir = path.join(root, 'input-dir');
    fs.mkdirSync(dir);

    const photoPath = path.join(dir, 'landscape.png');
    fs.copyFileSync(PHOTO_FIXTURE, photoPath);

    const summary = await runIngestDir(
      root,
      'topic1',
      { actor: 'ACTOR-001', dir, kind: 'photo', stub: true }
    );

    expect(summary.successCount).toBe(1);

    const hash = await hashFile(photoPath);
    const extractPayload = manifestStore.readExtract<{ facts: any[]; summary: string }>(
      root,
      'topic1',
      hash
    );

    expect(extractPayload).not.toBeNull();
    expect(extractPayload?.facts).toEqual([]);
  });

  it('a failing file does not abort the batch and appears in failed.json', async () => {
    const root = makeRoot();
    runCreate(root, 'topic1', { actor: 'ACTOR-001' });

    const dir = path.join(root, 'input-dir');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'good.txt'), 'Good text file', 'utf-8');
    fs.writeFileSync(path.join(dir, 'bad.png'), 'corrupt png data', 'utf-8');

    // Force OCR endpoint to fail for bad.png
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/analyze/ocr')) {
        return {
          ok: false,
          status: 500,
          text: async () => 'OCR engine failure',
        };
      }
      return { ok: true, json: async () => ({ text: 'ok', metadata: {} }) };
    }) as any;

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    const summary = await runIngestDir(
      root,
      'topic1',
      { actor: 'ACTOR-001', dir, kind: 'text-doc', stub: true }
    );
    consoleSpy.mockRestore();

    expect(summary.totalFiles).toBe(2);
    expect(summary.successCount).toBe(1);
    expect(summary.failureCount).toBe(1);

    const failed = failedStore.readFailed(root, 'topic1');
    expect(failed.length).toBe(1);
    expect(failed[0].sourcePath).toContain('bad.png');
  });

  describe('video pipeline (Task 5.3)', () => {
    let ffmpegSpy: jest.SpyInstance;
    let consoleErrorSpy: jest.SpyInstance;
    let consoleLogSpy: jest.SpyInstance;

    beforeEach(() => {
      // Batch-start ffmpeg preflight (Task 1.1) runs whenever a video file is
      // present; stub it out rather than require a real ffmpeg install on the
      // test box.
      ffmpegSpy = jest.spyOn(videoDeps, 'checkFfmpegDeps').mockResolvedValue();
      consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
      consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    });

    afterEach(() => {
      ffmpegSpy.mockRestore();
      consoleErrorSpy.mockRestore();
      consoleLogSpy.mockRestore();
    });

    it('silent video (no audio stream): transcribeAudio/checkWhisperDeps never called, envelope written from frames only', async () => {
      const root = makeRoot();
      runCreate(root, 'topic1', { actor: 'ACTOR-001' });

      const dir = path.join(root, 'input-dir');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'silent.mp4'), 'fake mp4 bytes', 'utf-8');

      const spies = mockVideoPipeline({
        durationMs: 60000,
        hasAudioStream: false,
        framePaths: ['frame-000.jpg'],
        frameAnalyses: [{ timestampMs: 0, labels: [{ description: 'outdoor', score: 0.8 }] }],
      });
      const { runner, runSpy } = makeRunSpyRunner();

      const summary = await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true }, runner);

      expect(summary.successCount).toBe(1);
      expect(summary.failureCount).toBe(0);
      expect(spies.transcribeSpy).not.toHaveBeenCalled();
      expect(spies.whisperDepsSpy).not.toHaveBeenCalled();
      expect(runSpy).toHaveBeenCalledTimes(1);

      const envelope = readRawEnvelope(root, 'topic1', 'SRC-001');
      expect(envelope?.kind).toBe('video');
      expect(envelope?.text).toBe('\n[frame @ 00:00] labels: outdoor');
      expect(envelope?.frames).toEqual([{ timestampMs: 0, labels: [{ description: 'outdoor', score: 0.8 }] }]);

      restoreVideoPipelineMocks(spies);
    });

    it('audio-only-content video: transcript present, low-signal frame labels are not an error', async () => {
      const root = makeRoot();
      runCreate(root, 'topic1', { actor: 'ACTOR-001' });

      const dir = path.join(root, 'input-dir');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'audio-only.mp4'), 'fake mp4 bytes', 'utf-8');

      const spies = mockVideoPipeline({
        durationMs: 60000,
        hasAudioStream: true,
        transcript: 'Hello from the archive recording.',
        framePaths: ['frame-000.jpg'],
        frameAnalyses: [{ timestampMs: 0, labels: [] }],
      });
      const { runner, runSpy } = makeRunSpyRunner();

      const summary = await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true }, runner);

      expect(summary.successCount).toBe(1);
      expect(spies.whisperDepsSpy).toHaveBeenCalledTimes(1);
      expect(spies.transcribeSpy).toHaveBeenCalledWith(path.join(dir, 'audio-only.mp4'), 60000);
      expect(runSpy).toHaveBeenCalledTimes(1);

      const envelope = readRawEnvelope(root, 'topic1', 'SRC-001');
      expect(envelope?.kind).toBe('video');
      expect(envelope?.text).toBe('Hello from the archive recording.\n[frame @ 00:00] labels: ');

      restoreVideoPipelineMocks(spies);
    });

    it('mixed video: meaningful transcript and frame labels both flow into composed text', async () => {
      const root = makeRoot();
      runCreate(root, 'topic1', { actor: 'ACTOR-001' });

      const dir = path.join(root, 'input-dir');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'mixed.mp4'), 'fake mp4 bytes', 'utf-8');

      const spies = mockVideoPipeline({
        durationMs: 72000,
        hasAudioStream: true,
        transcript: 'A walk along the beach at sunset.',
        framePaths: ['frame-000.jpg', 'frame-001.jpg'],
        frameAnalyses: [
          { timestampMs: 0, labels: [{ description: 'person', score: 0.9 }] },
          { timestampMs: 10000, labels: [{ description: 'beach', score: 0.85 }, { description: 'outdoor', score: 0.8 }] },
        ],
      });
      const { runner, runSpy } = makeRunSpyRunner();

      const summary = await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true }, runner);

      expect(summary.successCount).toBe(1);
      expect(runSpy).toHaveBeenCalledTimes(1);

      const envelope = readRawEnvelope(root, 'topic1', 'SRC-001');
      expect(envelope?.text).toBe(
        'A walk along the beach at sunset.\n[frame @ 00:00] labels: person\n[frame @ 00:10] labels: beach, outdoor'
      );
      expect(envelope?.frames).toHaveLength(2);

      restoreVideoPipelineMocks(spies);
    });

    it('<10s clip: probeVideo/extractFrames wired via midpoint strategy, single runner.run() call', async () => {
      const root = makeRoot();
      runCreate(root, 'topic1', { actor: 'ACTOR-001' });

      const dir = path.join(root, 'input-dir');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'short.mp4'), 'fake mp4 bytes', 'utf-8');

      const spies = mockVideoPipeline({
        durationMs: 4000,
        hasAudioStream: false,
        framePaths: ['frame-000.jpg'],
        frameAnalyses: [{ timestampMs: 2000, labels: [{ description: 'closeup', score: 0.6 }] }],
      });
      const { runner, runSpy } = makeRunSpyRunner();

      const summary = await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true }, runner);

      expect(summary.successCount).toBe(1);
      expect(runSpy).toHaveBeenCalledTimes(1);
      expect(spies.extractSpy).toHaveBeenCalledWith(path.join(dir, 'short.mp4'), 4000, expect.any(String));
      // Midpoint strategy: analyzeFrames receives a single timestamp at durationMs / 2.
      expect(spies.analyzeSpy).toHaveBeenCalledWith(['frame-000.jpg'], [2000], expect.anything());

      restoreVideoPipelineMocks(spies);
    });

    it('>=300s video: select-filter strategy, still <=30 frames feeding analyzeFrames', async () => {
      const root = makeRoot();
      runCreate(root, 'topic1', { actor: 'ACTOR-001' });

      const dir = path.join(root, 'input-dir');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'long.mp4'), 'fake mp4 bytes', 'utf-8');

      const durationMs = 600000; // 10 minutes
      const framePaths = Array.from({ length: 30 }, (_, i) => `frame-${String(i).padStart(3, '0')}.jpg`);
      const frameAnalyses: FrameAnalysis[] = framePaths.map((_, i) => ({
        timestampMs: i * (durationMs / 30),
        labels: [{ description: 'scene', score: 0.5 }],
      }));

      const spies = mockVideoPipeline({
        durationMs,
        hasAudioStream: false,
        framePaths,
        frameAnalyses,
      });
      const { runner, runSpy } = makeRunSpyRunner();

      const summary = await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true }, runner);

      expect(summary.successCount).toBe(1);
      expect(runSpy).toHaveBeenCalledTimes(1);

      const analyzeCallArgs = spies.analyzeSpy.mock.calls[0];
      const timestampsArg = analyzeCallArgs[1] as number[];
      expect(timestampsArg).toHaveLength(30);
      expect(timestampsArg[1] - timestampsArg[0]).toBeCloseTo(durationMs / 30);

      const envelope = readRawEnvelope(root, 'topic1', 'SRC-001');
      expect(envelope?.frames).toHaveLength(30);

      restoreVideoPipelineMocks(spies);
    });

    it('an injected failure (extractFrames rejects) lands in failedStore/manifestStore.markFailed via the existing outer catch', async () => {
      const root = makeRoot();
      runCreate(root, 'topic1', { actor: 'ACTOR-001' });

      const dir = path.join(root, 'input-dir');
      fs.mkdirSync(dir);
      const filePath = path.join(dir, 'broken.mp4');
      fs.writeFileSync(filePath, 'fake mp4 bytes', 'utf-8');

      const spies = mockVideoPipeline({ durationMs: 60000, hasAudioStream: false });
      spies.extractSpy.mockRejectedValue(new Error('ffmpeg exploded'));
      const { runner, runSpy } = makeRunSpyRunner();

      const summary = await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true }, runner);

      expect(summary.successCount).toBe(0);
      expect(summary.failureCount).toBe(1);
      expect(runSpy).not.toHaveBeenCalled();

      const failed = failedStore.readFailed(root, 'topic1');
      expect(failed.length).toBe(1);
      expect(failed[0].sourcePath).toContain('broken.mp4');
      expect(failed[0].error).toContain('ffmpeg exploded');

      const hash = await hashFile(filePath);
      expect(manifestStore.isDone(root, 'topic1', hash)).toBe(false);

      restoreVideoPipelineMocks(spies);
    });
  });

  it('--retry-failed reprocesses only failed items', async () => {
    const root = makeRoot();
    runCreate(root, 'topic1', { actor: 'ACTOR-001' });

    const dir = path.join(root, 'input-dir');
    fs.mkdirSync(dir);
    const badPath = path.join(dir, 'bad.png');
    fs.writeFileSync(badPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    // First run fails OCR
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/analyze/ocr')) {
        return {
          ok: false,
          status: 500,
          text: async () => 'OCR internal error',
        };
      }
      return { ok: true, json: async () => ({ text: 'ok', metadata: {} }) };
    }) as any;

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, kind: 'text-doc', stub: true });
    consoleSpy.mockRestore();

    expect(failedStore.readFailed(root, 'topic1').length).toBe(1);

    // Fix OCR service behavior
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/analyze/ocr')) {
        return {
          ok: true,
          json: async () => ({
            text: 'Recovered OCR text after fix',
            metadata: { format: 'png', size: 16, processedAt: new Date().toISOString(), latencyMs: 10 },
          }),
        };
      }
      return { ok: true, json: async () => ({ text: 'ok', metadata: {} }) };
    }) as any;

    // Retry failed items
    const retrySummary = await runIngestDir(
      root,
      'topic1',
      { actor: 'ACTOR-001', dir, kind: 'text-doc', retryFailed: true, stub: true }
    );

    expect(retrySummary.totalFiles).toBe(1);
    expect(retrySummary.successCount).toBe(1);
    expect(retrySummary.failureCount).toBe(0);

    // failedStore should now be empty
    expect(failedStore.readFailed(root, 'topic1')).toEqual([]);
  });
});
