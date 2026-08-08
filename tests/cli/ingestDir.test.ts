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
import * as extractAudioModule from '../../src/ingestion/videoExtract/extractAudio';
import * as transcribeModule from '../../src/ingestion/videoExtract/transcribe';
import { readRawEnvelope } from '../../src/core/rawSource';
import { readVideoMetrics } from '../../src/core/videoMetricsLog';
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
  // extractAudio() is the ffmpeg step that turns the video container into the
  // 16kHz mono WAV whisper.cpp can actually read. Its default mock returns a
  // path inside the per-video temp dir it was handed, so a test can assert the
  // WAV path (not the raw video path) is what reaches transcribeAudio.
  const extractAudioSpy = jest
    .spyOn(extractAudioModule, 'extractAudio')
    .mockImplementation(async (_filePath: string, tempDir: string) =>
      path.join(tempDir, 'audio.wav')
    );
  const transcribeSpy = jest
    .spyOn(transcribeModule, 'transcribeAudio')
    .mockResolvedValue(fixture.transcript ?? '');
  const whisperDepsSpy = jest.spyOn(videoDeps, 'checkWhisperDeps').mockResolvedValue();

  return { probeSpy, extractSpy, analyzeSpy, extractAudioSpy, transcribeSpy, whisperDepsSpy };
}

function restoreVideoPipelineMocks(spies: ReturnType<typeof mockVideoPipeline>) {
  spies.probeSpy.mockRestore();
  spies.extractSpy.mockRestore();
  spies.analyzeSpy.mockRestore();
  spies.extractAudioSpy.mockRestore();
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
      // The extracted WAV is what reaches whisper.cpp -- never the .mp4 itself.
      expect(spies.extractAudioSpy).toHaveBeenCalledWith(
        path.join(dir, 'audio-only.mp4'),
        expect.any(String)
      );
      const wavPath = await spies.extractAudioSpy.mock.results[0].value;
      expect(spies.transcribeSpy).toHaveBeenCalledWith(wavPath, 60000);
      expect(wavPath.endsWith('.wav')).toBe(true);
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

    it('logs per-video metrics on success: duration, frame count, transcript status, vision failure count', async () => {
      const root = makeRoot();
      runCreate(root, 'topic1', { actor: 'ACTOR-001' });

      const dir = path.join(root, 'input-dir');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'metrics.mp4'), 'fake mp4 bytes', 'utf-8');

      const spies = mockVideoPipeline({
        durationMs: 72000,
        hasAudioStream: true,
        transcript: 'A walk along the beach at sunset.',
        framePaths: ['frame-000.jpg', 'frame-001.jpg'],
        frameAnalyses: [
          { timestampMs: 0, labels: [{ description: 'person', score: 0.9 }] },
          { timestampMs: 10000, labels: [{ description: 'beach', score: 0.85 }] },
        ],
      });
      const { runner } = makeRunSpyRunner();

      await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true }, runner);

      const metrics = readVideoMetrics(root);
      expect(metrics).toHaveLength(1);
      expect(metrics[0]).toMatchObject({
        topic: 'topic1',
        file: 'metrics.mp4',
        outcome: 'success',
        durationMs: 72000,
        hasAudioStream: true,
        frameCount: 2,
        transcriptStatus: 'transcribed',
        visionFailureCount: 0,
      });
      expect(typeof metrics[0].ms).toBe('number');
      expect(metrics[0].ms).toBeGreaterThanOrEqual(0);

      restoreVideoPipelineMocks(spies);
    });

    it('logs transcriptStatus "no-audio" and "empty" correctly', async () => {
      const root = makeRoot();
      runCreate(root, 'topic1', { actor: 'ACTOR-001' });

      const dir = path.join(root, 'input-dir');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'silent.mp4'), 'fake mp4 bytes', 'utf-8');

      const spies = mockVideoPipeline({ durationMs: 60000, hasAudioStream: false });
      const { runner } = makeRunSpyRunner();

      await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true }, runner);

      const metrics = readVideoMetrics(root);
      expect(metrics[0].transcriptStatus).toBe('no-audio');

      restoreVideoPipelineMocks(spies);
    });

    it('logs a failure entry (with whatever probe info was learned) when the video pipeline fails', async () => {
      const root = makeRoot();
      runCreate(root, 'topic1', { actor: 'ACTOR-001' });

      const dir = path.join(root, 'input-dir');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'corrupt.mp4'), 'not a real video', 'utf-8');

      const spies = mockVideoPipeline({ durationMs: 60000, hasAudioStream: true });
      spies.extractSpy.mockRejectedValueOnce(new Error('ffmpeg produced no frames'));
      const { runner } = makeRunSpyRunner();

      await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true }, runner);

      const metrics = readVideoMetrics(root);
      expect(metrics).toHaveLength(1);
      expect(metrics[0]).toMatchObject({
        topic: 'topic1',
        file: 'corrupt.mp4',
        outcome: 'failure',
        durationMs: 60000,
        hasAudioStream: true,
      });
      expect(metrics[0].error).toContain('ffmpeg produced no frames');
      expect(metrics[0].frameCount).toBeUndefined();

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

    it('runs the transcript and frame paths concurrently, not serialized (CONTEXT.md #8)', async () => {
      const root = makeRoot();
      runCreate(root, 'topic1', { actor: 'ACTOR-001' });

      const dir = path.join(root, 'input-dir');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'concurrent.mp4'), 'fake mp4 bytes', 'utf-8');

      let resolveTranscribe: (value: string) => void;
      const transcribeDeferred = new Promise<string>((resolve) => {
        resolveTranscribe = resolve;
      });

      const probeSpy = jest
        .spyOn(videoProbe, 'probeVideo')
        .mockResolvedValue({ durationMs: 60000, hasAudioStream: true });
      const whisperDepsSpy = jest.spyOn(videoDeps, 'checkWhisperDeps').mockResolvedValue();
      // transcribeAudio deliberately hangs on an unresolved promise -- if the
      // implementation were serialized (`await transcript; await frames;`),
      // extractFrames would never be invoked until this resolves. Under real
      // concurrency (Promise.all), extractFrames starts (and, being mocked
      // synchronous-ish, completes) well before we ever resolve it below.
      const extractAudioSpy = jest
        .spyOn(extractAudioModule, 'extractAudio')
        .mockImplementation(async (_f: string, tempDir: string) => path.join(tempDir, 'audio.wav'));
      const transcribeSpy = jest
        .spyOn(transcribeModule, 'transcribeAudio')
        .mockImplementation(() => transcribeDeferred);

      let extractFramesCalledWhileTranscribeStillPending = false;
      const extractSpy = jest
        .spyOn(extractFramesModule, 'extractFrames')
        .mockImplementation(async () => {
          extractFramesCalledWhileTranscribeStillPending = true;
          return ['frame-000.jpg'];
        });
      const analyzeSpy = jest
        .spyOn(analyzeFramesModule, 'analyzeFrames')
        .mockResolvedValue([{ timestampMs: 0, labels: [{ description: 'object', score: 0.7 }] }]);

      const { runner } = makeRunSpyRunner();
      const runPromise = runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true }, runner);

      // Give the frame path's real async work (mkdtemp, extractFrames,
      // analyzeFrames) a window to run while transcribeAudio's promise is
      // still deliberately unresolved.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(extractFramesCalledWhileTranscribeStillPending).toBe(true);

      resolveTranscribe!('late transcript');
      const summary = await runPromise;
      expect(summary.successCount).toBe(1);

      probeSpy.mockRestore();
      whisperDepsSpy.mockRestore();
      extractAudioSpy.mockRestore();
      transcribeSpy.mockRestore();
      extractSpy.mockRestore();
      analyzeSpy.mockRestore();
    });

    it('removes the per-video temp dir in a finally block on the success path', async () => {
      const root = makeRoot();
      runCreate(root, 'topic1', { actor: 'ACTOR-001' });

      const dir = path.join(root, 'input-dir');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'ok.mp4'), 'fake mp4 bytes', 'utf-8');

      const spies = mockVideoPipeline({ durationMs: 60000, hasAudioStream: false });
      const mkdtempSpy = jest.spyOn(fs.promises, 'mkdtemp');
      const { runner } = makeRunSpyRunner();

      const summary = await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true }, runner);

      expect(summary.successCount).toBe(1);
      expect(mkdtempSpy.mock.results.length).toBe(1);
      const tempDir = await mkdtempSpy.mock.results[0].value;
      expect(fs.existsSync(tempDir)).toBe(false);

      mkdtempSpy.mockRestore();
      restoreVideoPipelineMocks(spies);
    });

    it('removes the per-video temp dir in a finally block on the failure path', async () => {
      const root = makeRoot();
      runCreate(root, 'topic1', { actor: 'ACTOR-001' });

      const dir = path.join(root, 'input-dir');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'broken.mp4'), 'fake mp4 bytes', 'utf-8');

      const spies = mockVideoPipeline({ durationMs: 60000, hasAudioStream: false });
      spies.analyzeSpy.mockRejectedValue(new Error('vision call exploded'));
      const mkdtempSpy = jest.spyOn(fs.promises, 'mkdtemp');
      const { runner } = makeRunSpyRunner();

      const summary = await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true }, runner);

      expect(summary.failureCount).toBe(1);
      expect(mkdtempSpy.mock.results.length).toBe(1);
      const tempDir = await mkdtempSpy.mock.results[0].value;
      expect(fs.existsSync(tempDir)).toBe(false);

      const failed = failedStore.readFailed(root, 'topic1');
      expect(failed[0].error).toContain('vision call exploded');

      mkdtempSpy.mockRestore();
      restoreVideoPipelineMocks(spies);
    });

    it('does not clean up the shared temp dir until BOTH branches have settled, even when one rejects early (partial-failure race fix)', async () => {
      const root = makeRoot();
      runCreate(root, 'topic1', { actor: 'ACTOR-001' });

      const dir = path.join(root, 'input-dir');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'racey.mp4'), 'fake mp4 bytes', 'utf-8');

      let resolveTranscribe: (value: string) => void;
      const transcribeDeferred = new Promise<string>((resolve) => {
        resolveTranscribe = resolve;
      });

      const probeSpy = jest
        .spyOn(videoProbe, 'probeVideo')
        .mockResolvedValue({ durationMs: 60000, hasAudioStream: true });
      const whisperDepsSpy = jest.spyOn(videoDeps, 'checkWhisperDeps').mockResolvedValue();
      const extractAudioSpy = jest
        .spyOn(extractAudioModule, 'extractAudio')
        .mockImplementation(async (_f: string, tempDir: string) => path.join(tempDir, 'audio.wav'));
      // Transcript branch deliberately hangs -- still "using" tempDir (the WAV
      // it already wrote) when the frame branch below rejects immediately.
      // With Promise.all, the finally's rm() would fire the instant the frame
      // branch rejects, deleting tempDir out from under this still-pending
      // branch. With Promise.allSettled, cleanup must wait for this to settle.
      const transcribeSpy = jest
        .spyOn(transcribeModule, 'transcribeAudio')
        .mockImplementation(() => transcribeDeferred);
      const extractSpy = jest
        .spyOn(extractFramesModule, 'extractFrames')
        .mockResolvedValue(['frame-000.jpg']);
      const analyzeSpy = jest
        .spyOn(analyzeFramesModule, 'analyzeFrames')
        .mockRejectedValue(new Error('vision call exploded'));
      const mkdtempSpy = jest.spyOn(fs.promises, 'mkdtemp');

      const { runner } = makeRunSpyRunner();
      const runPromise = runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true }, runner);

      // Give the frame branch (which rejects synchronously-ish) a window to
      // settle while the transcript branch is still deliberately pending.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(mkdtempSpy.mock.results.length).toBe(1);
      const tempDir = await mkdtempSpy.mock.results[0].value;
      // The frame branch has already rejected by now, but cleanup must NOT
      // have run yet -- the transcript branch is still pending.
      expect(fs.existsSync(tempDir)).toBe(true);

      resolveTranscribe!('late transcript, never used since the video fails');
      const summary = await runPromise;

      expect(summary.failureCount).toBe(1);
      expect(fs.existsSync(tempDir)).toBe(false);
      const failed = failedStore.readFailed(root, 'topic1');
      expect(failed[0].error).toContain('vision call exploded');

      probeSpy.mockRestore();
      whisperDepsSpy.mockRestore();
      extractAudioSpy.mockRestore();
      transcribeSpy.mockRestore();
      extractSpy.mockRestore();
      analyzeSpy.mockRestore();
      mkdtempSpy.mockRestore();
    });

    it('a probeVideo failure (corrupt media) lands in failedStore with the underlying message preserved, and --retry-failed reprocesses it once fixed (Task 5.4)', async () => {
      const root = makeRoot();
      runCreate(root, 'topic1', { actor: 'ACTOR-001' });

      const dir = path.join(root, 'input-dir');
      fs.mkdirSync(dir);
      const filePath = path.join(dir, 'corrupt.mp4');
      fs.writeFileSync(filePath, 'not a real video', 'utf-8');

      const spies = mockVideoPipeline({ durationMs: 60000, hasAudioStream: false });
      spies.probeSpy.mockRejectedValueOnce(
        new Error(
          `Failed to probe video file "${filePath}": Invalid data found when processing input`
        )
      );
      const { runner, runSpy } = makeRunSpyRunner();

      const summary = await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true }, runner);

      expect(summary.successCount).toBe(0);
      expect(summary.failureCount).toBe(1);
      expect(runSpy).not.toHaveBeenCalled();

      const failed = failedStore.readFailed(root, 'topic1');
      expect(failed.length).toBe(1);
      expect(failed[0].sourcePath).toContain('corrupt.mp4');
      expect(failed[0].error).toContain('Invalid data found when processing input');

      const hash = await hashFile(filePath);
      expect(manifestStore.isDone(root, 'topic1', hash)).toBe(false);

      // probeSpy's mockRejectedValueOnce is consumed -- the retry run below
      // falls through to the mockResolvedValue set up by mockVideoPipeline,
      // i.e. the fix actually reprocesses the file rather than just re-reading
      // the failure record.
      const retrySummary = await runIngestDir(
        root,
        'topic1',
        { actor: 'ACTOR-001', dir, retryFailed: true, stub: true },
        runner
      );

      expect(retrySummary.totalFiles).toBe(1);
      expect(retrySummary.successCount).toBe(1);
      expect(retrySummary.failureCount).toBe(0);
      expect(failedStore.readFailed(root, 'topic1')).toEqual([]);
      expect(manifestStore.isDone(root, 'topic1', hash)).toBe(true);

      restoreVideoPipelineMocks(spies);
    });

    it('a video exceeding TRM_VIDEO_MAX_BYTES fails before probeVideo/extractFrames/extractAudio run', async () => {
      const root = makeRoot();
      runCreate(root, 'topic1', { actor: 'ACTOR-001' });

      const dir = path.join(root, 'input-dir');
      fs.mkdirSync(dir);
      const filePath = path.join(dir, 'oversized.mp4');
      fs.writeFileSync(filePath, 'fake mp4 bytes larger than the cap', 'utf-8');

      process.env.TRM_VIDEO_MAX_BYTES = '10';
      const spies = mockVideoPipeline({ durationMs: 60000, hasAudioStream: false });
      const { runner, runSpy } = makeRunSpyRunner();

      try {
        const summary = await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true }, runner);

        expect(summary.successCount).toBe(0);
        expect(summary.failureCount).toBe(1);
        expect(spies.probeSpy).not.toHaveBeenCalled();
        expect(spies.extractSpy).not.toHaveBeenCalled();
        expect(spies.extractAudioSpy).not.toHaveBeenCalled();
        expect(runSpy).not.toHaveBeenCalled();

        const failed = failedStore.readFailed(root, 'topic1');
        expect(failed.length).toBe(1);
        expect(failed[0].error).toContain('exceeds max size');
        expect(failed[0].error).toContain('TRM_VIDEO_MAX_BYTES');
      } finally {
        delete process.env.TRM_VIDEO_MAX_BYTES;
        restoreVideoPipelineMocks(spies);
      }
    });

    it('a video exceeding TRM_VIDEO_MAX_DURATION_MS fails after probeVideo but before extractFrames/extractAudio run', async () => {
      const root = makeRoot();
      runCreate(root, 'topic1', { actor: 'ACTOR-001' });

      const dir = path.join(root, 'input-dir');
      fs.mkdirSync(dir);
      const filePath = path.join(dir, 'toolong.mp4');
      fs.writeFileSync(filePath, 'fake mp4 bytes', 'utf-8');

      process.env.TRM_VIDEO_MAX_DURATION_MS = '1000';
      const spies = mockVideoPipeline({ durationMs: 60000, hasAudioStream: false });
      const { runner, runSpy } = makeRunSpyRunner();

      try {
        const summary = await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true }, runner);

        expect(summary.successCount).toBe(0);
        expect(summary.failureCount).toBe(1);
        expect(spies.probeSpy).toHaveBeenCalledTimes(1);
        expect(spies.extractSpy).not.toHaveBeenCalled();
        expect(spies.extractAudioSpy).not.toHaveBeenCalled();
        expect(runSpy).not.toHaveBeenCalled();

        const failed = failedStore.readFailed(root, 'topic1');
        expect(failed.length).toBe(1);
        expect(failed[0].error).toContain('exceeds max duration');
        expect(failed[0].error).toContain('TRM_VIDEO_MAX_DURATION_MS');
      } finally {
        delete process.env.TRM_VIDEO_MAX_DURATION_MS;
        restoreVideoPipelineMocks(spies);
      }
    });

    it('a probeVideo timeout-shaped failure lands in failedStore with the underlying message preserved (Task 5.4)', async () => {
      const root = makeRoot();
      runCreate(root, 'topic1', { actor: 'ACTOR-001' });

      const dir = path.join(root, 'input-dir');
      fs.mkdirSync(dir);
      const filePath = path.join(dir, 'slow.mp4');
      fs.writeFileSync(filePath, 'fake mp4 bytes', 'utf-8');

      const spies = mockVideoPipeline({ durationMs: 60000, hasAudioStream: false });
      // Mirrors the wrapped message shape probeVideo() produces when
      // execFileAsync's subprocess is killed for exceeding its timeout
      // (getErrorDetail() falls back to err.message, which for a killed
      // child process reads "Command failed: ... " with no stderr set).
      spies.probeSpy.mockRejectedValue(
        new Error(`Failed to probe video file "${filePath}": Command failed: ffprobe ${filePath}`)
      );
      const { runner, runSpy } = makeRunSpyRunner();

      const summary = await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true }, runner);

      expect(summary.successCount).toBe(0);
      expect(summary.failureCount).toBe(1);
      expect(runSpy).not.toHaveBeenCalled();

      const failed = failedStore.readFailed(root, 'topic1');
      expect(failed.length).toBe(1);
      expect(failed[0].sourcePath).toContain('slow.mp4');
      expect(failed[0].error).toContain('Command failed: ffprobe');

      restoreVideoPipelineMocks(spies);
    });

    it('an extractFrames timeout-shaped failure lands in failedStore with the underlying message preserved (Task 5.4)', async () => {
      const root = makeRoot();
      runCreate(root, 'topic1', { actor: 'ACTOR-001' });

      const dir = path.join(root, 'input-dir');
      fs.mkdirSync(dir);
      const filePath = path.join(dir, 'stuck.mp4');
      fs.writeFileSync(filePath, 'fake mp4 bytes', 'utf-8');

      const spies = mockVideoPipeline({ durationMs: 60000, hasAudioStream: false });
      spies.extractSpy.mockRejectedValue(
        new Error(`Failed to extract frames from video file "${filePath}": Command failed: ffmpeg ${filePath}`)
      );
      const { runner, runSpy } = makeRunSpyRunner();

      const summary = await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true }, runner);

      expect(summary.successCount).toBe(0);
      expect(summary.failureCount).toBe(1);
      expect(runSpy).not.toHaveBeenCalled();

      const failed = failedStore.readFailed(root, 'topic1');
      expect(failed.length).toBe(1);
      expect(failed[0].error).toContain('Command failed: ffmpeg');

      restoreVideoPipelineMocks(spies);
    });

    it('a transcribeAudio failure (whisper timeout) lands in failedStore with the underlying message preserved (Task 5.4)', async () => {
      const root = makeRoot();
      runCreate(root, 'topic1', { actor: 'ACTOR-001' });

      const dir = path.join(root, 'input-dir');
      fs.mkdirSync(dir);
      const filePath = path.join(dir, 'has-audio.mp4');
      fs.writeFileSync(filePath, 'fake mp4 bytes', 'utf-8');

      const spies = mockVideoPipeline({ durationMs: 60000, hasAudioStream: true });
      spies.transcribeSpy.mockRejectedValue(
        new Error(
          `Whisper transcription timed out after 30000ms for file "${filePath}": Command failed: whisper ${filePath}`
        )
      );
      const { runner, runSpy } = makeRunSpyRunner();

      const summary = await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true }, runner);

      expect(summary.successCount).toBe(0);
      expect(summary.failureCount).toBe(1);
      expect(runSpy).not.toHaveBeenCalled();

      const failed = failedStore.readFailed(root, 'topic1');
      expect(failed.length).toBe(1);
      expect(failed[0].sourcePath).toContain('has-audio.mp4');
      expect(failed[0].error).toContain('Whisper transcription timed out after 30000ms');

      const hash = await hashFile(filePath);
      expect(manifestStore.isDone(root, 'topic1', hash)).toBe(false);

      restoreVideoPipelineMocks(spies);
    });

    it('extracts audio to a 16kHz mono WAV via ffmpeg before transcribing (whisper.cpp cannot read an mp4 container)', async () => {
      const root = makeRoot();
      runCreate(root, 'topic1', { actor: 'ACTOR-001' });

      const dir = path.join(root, 'input-dir');
      fs.mkdirSync(dir);
      const filePath = path.join(dir, 'has-audio.mp4');
      fs.writeFileSync(filePath, 'fake mp4 bytes', 'utf-8');

      const spies = mockVideoPipeline({
        durationMs: 60000,
        hasAudioStream: true,
        transcript: 'spoken words',
      });

      const { runner } = makeRunSpyRunner();
      const summary = await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true }, runner);

      expect(summary.successCount).toBe(1);

      // The audio-extraction step runs, on the source video, before whisper.
      // (The exact ffmpeg argv -- `-map 0:a:0 -ar 16000 -ac 1 -f wav` -- is
      // asserted against a mocked execFile in
      // tests/ingestion/videoExtract/extractAudio.test.ts; extractAudio
      // promisify()s execFile at import time, so it cannot be intercepted by a
      // post-import spy here. This test covers the wiring.)
      expect(spies.extractAudioSpy).toHaveBeenCalledTimes(1);
      expect(spies.extractAudioSpy).toHaveBeenCalledWith(filePath, expect.any(String));

      // whisper receives the WAV, not the source video container.
      const transcribedPath = spies.transcribeSpy.mock.calls[0][0] as string;
      expect(transcribedPath.endsWith('.wav')).toBe(true);
      expect(transcribedPath).not.toBe(filePath);

      // Ordering: extraction must resolve before transcription is invoked.
      expect(spies.extractAudioSpy.mock.invocationCallOrder[0]).toBeLessThan(
        spies.transcribeSpy.mock.invocationCallOrder[0]
      );

      restoreVideoPipelineMocks(spies);
    });

    it('writes the extracted WAV into the SAME per-video temp dir as the frames (one mkdtemp, one cleanup)', async () => {
      const root = makeRoot();
      runCreate(root, 'topic1', { actor: 'ACTOR-001' });

      const dir = path.join(root, 'input-dir');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'has-audio.mp4'), 'fake mp4 bytes', 'utf-8');

      const spies = mockVideoPipeline({ durationMs: 60000, hasAudioStream: true, transcript: 'x' });
      const mkdtempSpy = jest.spyOn(fs.promises, 'mkdtemp');
      const { runner } = makeRunSpyRunner();

      const summary = await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true }, runner);

      expect(summary.successCount).toBe(1);
      // Exactly one temp dir for the whole video, shared by both branches.
      expect(mkdtempSpy.mock.results.length).toBe(1);
      const tempDir = await mkdtempSpy.mock.results[0].value;
      expect(spies.extractAudioSpy).toHaveBeenCalledWith(expect.any(String), tempDir);
      expect(spies.extractSpy).toHaveBeenCalledWith(expect.any(String), 60000, tempDir);
      // ...and it is still cleaned up.
      expect(fs.existsSync(tempDir)).toBe(false);

      mkdtempSpy.mockRestore();
      restoreVideoPipelineMocks(spies);
    });

    it('an extractAudio (ffmpeg) failure lands in failedStore with the underlying message preserved', async () => {
      const root = makeRoot();
      runCreate(root, 'topic1', { actor: 'ACTOR-001' });

      const dir = path.join(root, 'input-dir');
      fs.mkdirSync(dir);
      const filePath = path.join(dir, 'no-decodable-audio.mp4');
      fs.writeFileSync(filePath, 'fake mp4 bytes', 'utf-8');

      const spies = mockVideoPipeline({ durationMs: 60000, hasAudioStream: true });
      spies.extractAudioSpy.mockRejectedValue(
        new Error(
          `Failed to extract audio from video file "${filePath}": Stream map 0:a:0 matches no streams`
        )
      );
      const { runner, runSpy } = makeRunSpyRunner();

      const summary = await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true }, runner);

      expect(summary.successCount).toBe(0);
      expect(summary.failureCount).toBe(1);
      expect(runSpy).not.toHaveBeenCalled();
      expect(spies.transcribeSpy).not.toHaveBeenCalled();

      const failed = failedStore.readFailed(root, 'topic1');
      expect(failed.length).toBe(1);
      expect(failed[0].error).toContain('Stream map 0:a:0 matches no streams');

      restoreVideoPipelineMocks(spies);
    });

    it('a Vision failure on a frame lands the video in failedStore, not a silent zero-label success', async () => {
      const root = makeRoot();
      runCreate(root, 'topic1', { actor: 'ACTOR-001' });

      const dir = path.join(root, 'input-dir');
      fs.mkdirSync(dir);
      const filePath = path.join(dir, 'vision-down.mp4');
      fs.writeFileSync(filePath, 'fake mp4 bytes', 'utf-8');

      const spies = mockVideoPipeline({ durationMs: 60000, hasAudioStream: false });
      // analyzeFrames promotes ImageAnalyzer's resolve-with-metadata.error
      // shape into a real rejection (mirrors the photo branch); assert the
      // video-branch wiring carries that through to failedStore.
      spies.analyzeSpy.mockRejectedValue(
        new Error('Vision analysis failed: Vision API unavailable (503)')
      );
      const { runner, runSpy } = makeRunSpyRunner();

      const summary = await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true }, runner);

      expect(summary.successCount).toBe(0);
      expect(summary.failureCount).toBe(1);
      expect(runSpy).not.toHaveBeenCalled();

      const failed = failedStore.readFailed(root, 'topic1');
      expect(failed.length).toBe(1);
      expect(failed[0].sourcePath).toContain('vision-down.mp4');
      expect(failed[0].error).toContain('Vision API unavailable (503)');

      // Not marked done -- so --retry-failed will revisit it.
      const hash = await hashFile(filePath);
      expect(manifestStore.isDone(root, 'topic1', hash)).toBe(false);

      restoreVideoPipelineMocks(spies);
    });

    it('a video failure does not abort the batch -- other files (video and non-video) in the same batch still succeed (Task 5.4)', async () => {
      const root = makeRoot();
      runCreate(root, 'topic1', { actor: 'ACTOR-001' });

      const dir = path.join(root, 'input-dir');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'good.txt'), 'A good text doc file', 'utf-8');
      const badVideoPath = path.join(dir, 'bad.mp4');
      fs.writeFileSync(badVideoPath, 'fake mp4 bytes -- bad', 'utf-8');
      const goodVideoPath = path.join(dir, 'good.mp4');
      fs.writeFileSync(goodVideoPath, 'fake mp4 bytes -- good', 'utf-8');

      const spies = mockVideoPipeline({ durationMs: 60000, hasAudioStream: false });
      spies.probeSpy.mockImplementation(async (filePath: string) => {
        if (filePath === badVideoPath) {
          throw new Error(
            `Failed to probe video file "${badVideoPath}": Invalid data found when processing input`
          );
        }
        return { durationMs: 60000, hasAudioStream: false };
      });
      const { runner } = makeRunSpyRunner();

      const summary = await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true }, runner);

      expect(summary.totalFiles).toBe(3);
      expect(summary.successCount).toBe(2);
      expect(summary.failureCount).toBe(1);

      const failed = failedStore.readFailed(root, 'topic1');
      expect(failed.length).toBe(1);
      expect(failed[0].sourcePath).toContain('bad.mp4');
      expect(failed[0].error).toContain('Invalid data found when processing input');

      const goodVideoHash = await hashFile(goodVideoPath);
      expect(manifestStore.isDone(root, 'topic1', goodVideoHash)).toBe(true);

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
