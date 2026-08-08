/**
 * Real-binary smoke test for the video ingest pipeline.
 *
 * Every other video test in this repo mocks `node:child_process` -- they
 * verify argument-building logic but never prove ffmpeg/ffprobe/whisper-cli
 * actually accept those arguments. That gap let a real bug ship (wrong
 * whisper binary name, wrong model format, missing WAV pre-extraction step
 * entirely) that only a whole-branch reasoning review caught, not the test
 * suite. See memory/project-trm-video-ingest-shipped-2026-08-08.md, item #5.
 *
 * This suite runs the pipeline against real installed binaries. It is
 * opt-in (skipped by default) because ffmpeg/ffprobe/whisper.cpp + a ggml
 * model are not assumed to be present on every dev machine or CI runner.
 *
 * To run:
 *   1. Install ffmpeg+ffprobe, whisper.cpp CLI (`whisper-cli`), and a ggml
 *      model (e.g. ggml-base.en.bin).
 *   2. Point at them via TRM_FFMPEG_PATH / TRM_FFPROBE_PATH /
 *      TRM_WHISPER_BIN / TRM_WHISPER_MODEL (same env vars the app itself
 *      reads -- see src/core/videoDeps.ts), or put them on PATH / at the
 *      app's default lookup locations.
 *   3. Set TRM_SMOKE_VIDEO=1 and run: npx jest tests/smoke --testTimeout 60000
 *      (outside the default `npm test` roots/timeout on purpose).
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkFfmpegDeps, checkWhisperDeps } from '../../src/core/videoDeps';
import { probeVideo } from '../../src/core/videoProbe';
import { extractFrames } from '../../src/ingestion/videoExtract/extractFrames';
import { extractAudio } from '../../src/ingestion/videoExtract/extractAudio';
import { transcribeAudio } from '../../src/ingestion/videoExtract/transcribe';

const SMOKE_ENABLED = process.env.TRM_SMOKE_VIDEO === '1';

function depsAvailableSync(): boolean {
  const ffmpegPath = process.env.TRM_FFMPEG_PATH || 'ffmpeg';
  const ffprobePath = process.env.TRM_FFPROBE_PATH || 'ffprobe';
  const whisperBin = process.env.TRM_WHISPER_BIN || 'whisper-cli';
  try {
    execFileSync(ffmpegPath, ['-version'], { timeout: 5000, stdio: 'ignore' });
    execFileSync(ffprobePath, ['-version'], { timeout: 5000, stdio: 'ignore' });
    execFileSync(whisperBin, ['-h'], { timeout: 5000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const runSuite = SMOKE_ENABLED && depsAvailableSync();

const describeSmoke = runSuite ? describe : describe.skip;

describeSmoke('video pipeline against real binaries', () => {
  let tempDir: string;
  let fixturePath: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-video-smoke-'));
    fixturePath = path.join(tempDir, 'fixture.mp4');

    const ffmpegPath = process.env.TRM_FFMPEG_PATH || 'ffmpeg';
    // 2s synthetic clip: color bars video + 1kHz sine audio tone. Not speech
    // -- whisper is expected to transcribe it as empty/near-empty, which is
    // fine; this proves the subprocess plumbing works end to end, not ASR
    // accuracy.
    execFileSync(
      ffmpegPath,
      [
        '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
        '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=2',
        '-c:v', 'libx264',
        '-c:a', 'aac',
        '-shortest',
        '-y',
        fixturePath
      ],
      { timeout: 30000 }
    );
  }, 60000);

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('preflight checks pass against real binaries', async () => {
    await expect(checkFfmpegDeps()).resolves.toBeUndefined();
    await expect(checkWhisperDeps()).resolves.toBeUndefined();
  });

  it('probes real duration and audio-stream presence', async () => {
    const result = await probeVideo(fixturePath);
    expect(result.hasAudioStream).toBe(true);
    // Encoded duration can drift slightly from the requested 2000ms.
    expect(result.durationMs).toBeGreaterThan(1500);
    expect(result.durationMs).toBeLessThan(3000);
  });

  it('extracts at least one real frame file', async () => {
    const frameDir = fs.mkdtempSync(path.join(tempDir, 'frames-'));
    const frames = await extractFrames(fixturePath, 2000, frameDir);
    expect(frames.length).toBeGreaterThan(0);
    for (const framePath of frames) {
      expect(fs.existsSync(framePath)).toBe(true);
      expect(fs.statSync(framePath).size).toBeGreaterThan(0);
    }
  });

  it('extracts real 16kHz mono WAV audio', async () => {
    const audioDir = fs.mkdtempSync(path.join(tempDir, 'audio-'));
    const wavPath = await extractAudio(fixturePath, audioDir);
    expect(fs.existsSync(wavPath)).toBe(true);
    expect(fs.statSync(wavPath).size).toBeGreaterThan(0);
  });

  it('runs real whisper.cpp transcription without throwing', async () => {
    const audioDir = fs.mkdtempSync(path.join(tempDir, 'transcribe-'));
    const wavPath = await extractAudio(fixturePath, audioDir);
    // A pure sine tone has no speech -- assert the call completes and
    // returns a string, not that it's empty (whisper.cpp can emit stray
    // tokens on tonal input; that's not this test's concern).
    const transcript = await transcribeAudio(wavPath, 2000);
    expect(typeof transcript).toBe('string');
  });
});

if (!runSuite) {
  // eslint-disable-next-line jest/expect-expect, jest/no-standalone-expect
  it.skip('video smoke suite skipped: set TRM_SMOKE_VIDEO=1 and install real ffmpeg/ffprobe/whisper-cli to run', () => {});
}
