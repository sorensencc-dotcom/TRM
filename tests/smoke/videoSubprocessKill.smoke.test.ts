/**
 * Real-binary subprocess-kill verification for the video ingest pipeline.
 *
 * extractFrames/extractAudio/transcribeAudio all rely on Node's execFile
 * `timeout` option to bound a subprocess that runs too long -- but nothing
 * in the codebase had ever verified that the kill actually terminates the
 * real ffmpeg/whisper-cli process on this OS (Windows execFile timeout
 * semantics are not guaranteed identical to POSIX), or that the temp
 * directory a killed process was writing into is still cleanly removable
 * afterward (an unreleased file handle would leave it locked). See
 * memory/project-trm-video-ingest-shipped-2026-08-08.md, follow-up #2.
 *
 * Forces a fast, deterministic timeout by setting the timeout override env
 * vars (TRM_FFMPEG_FRAME_TIMEOUT_MS / TRM_FFMPEG_AUDIO_TIMEOUT_MS /
 * TRM_WHISPER_MIN_TIMEOUT_MS) to ~1ms against the real 2s fixture -- process
 * spawn overhead alone guarantees the timeout fires before the subprocess
 * can finish any real work, so this reliably exercises the kill path
 * without needing an artificially slow/hung input.
 *
 * Opt-in, same as videoPipeline.smoke.test.ts: requires TRM_SMOKE_VIDEO=1
 * and real ffmpeg/ffprobe/whisper-cli installed. See that file's header for
 * setup instructions.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

// Windows-only process census -- this repo targets Windows exclusively
// (CLAUDE.md). Counts *currently running* processes with the given image
// name; used as a before/after delta rather than an absolute count so
// unrelated ffmpeg/whisper-cli processes already running on the dev
// machine don't produce false failures.
function countRunningProcesses(imageName: string): number {
  try {
    const out = execFileSync(
      'tasklist',
      ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH'],
      { encoding: 'utf-8' }
    );
    if (out.includes('INFO:')) return 0; // "INFO: No tasks are running..."
    return out.split('\n').filter((line) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}

// Grace period for the OS to finish tearing down a killed process (release
// its handles, exit its process table entry) before we census again.
async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describeSmoke('video subprocess kill on timeout (real binaries)', () => {
  let tempDir: string;
  let fixturePath: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-video-kill-'));
    fixturePath = path.join(tempDir, 'fixture.mp4');
    const ffmpegPath = process.env.TRM_FFMPEG_PATH || 'ffmpeg';
    execFileSync(
      ffmpegPath,
      [
        '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
        '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=2',
        '-c:v', 'libx264', '-c:a', 'aac', '-shortest', '-y', fixturePath
      ],
      { timeout: 30000 }
    );
  }, 60000);

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  afterEach(() => {
    delete process.env.TRM_FFMPEG_FRAME_TIMEOUT_MS;
    delete process.env.TRM_FFMPEG_AUDIO_TIMEOUT_MS;
    delete process.env.TRM_WHISPER_MIN_TIMEOUT_MS;
  });

  it('extractFrames: a 1ms timeout kills the real ffmpeg process, no orphan survives, temp dir stays removable', async () => {
    process.env.TRM_FFMPEG_FRAME_TIMEOUT_MS = '1';
    const before = countRunningProcesses('ffmpeg.exe');
    const frameDir = fs.mkdtempSync(path.join(tempDir, 'kill-frames-'));

    await expect(extractFrames(fixturePath, 2000, frameDir)).rejects.toThrow(
      /Failed to extract frames/
    );

    await sleep(500);
    const after = countRunningProcesses('ffmpeg.exe');
    expect(after).toBeLessThanOrEqual(before);

    // A held file handle from an incompletely-torn-down process would make
    // this throw EBUSY/EPERM on Windows.
    await expect(
      fs.promises.rm(frameDir, { recursive: true, force: true })
    ).resolves.toBeUndefined();
  }, 15000);

  it('extractAudio: a 1ms timeout kills the real ffmpeg process, no orphan survives, temp dir stays removable', async () => {
    process.env.TRM_FFMPEG_AUDIO_TIMEOUT_MS = '1';
    const before = countRunningProcesses('ffmpeg.exe');
    const audioDir = fs.mkdtempSync(path.join(tempDir, 'kill-audio-'));

    await expect(extractAudio(fixturePath, audioDir)).rejects.toThrow(
      /Failed to extract audio/
    );

    await sleep(500);
    const after = countRunningProcesses('ffmpeg.exe');
    expect(after).toBeLessThanOrEqual(before);

    await expect(
      fs.promises.rm(audioDir, { recursive: true, force: true })
    ).resolves.toBeUndefined();
  }, 15000);

  it('transcribeAudio: a 1ms timeout kills the real whisper-cli process, no orphan survives, temp dir stays removable', async () => {
    // Real WAV, extracted with the default (non-tiny) ffmpeg timeout --
    // only whisper's timeout is forced tiny here.
    const audioDir = fs.mkdtempSync(path.join(tempDir, 'kill-whisper-'));
    const wavPath = await extractAudio(fixturePath, audioDir);

    process.env.TRM_WHISPER_MIN_TIMEOUT_MS = '1';
    const before = countRunningProcesses('whisper-cli.exe');

    await expect(transcribeAudio(wavPath)).rejects.toThrow(
      /Whisper transcription timed out/
    );

    await sleep(500);
    const after = countRunningProcesses('whisper-cli.exe');
    expect(after).toBeLessThanOrEqual(before);

    await expect(
      fs.promises.rm(audioDir, { recursive: true, force: true })
    ).resolves.toBeUndefined();
  }, 15000);
});

if (!runSuite) {
  // eslint-disable-next-line jest/expect-expect, jest/no-standalone-expect
  it.skip('video subprocess-kill smoke suite skipped: set TRM_SMOKE_VIDEO=1 and install real ffmpeg/ffprobe/whisper-cli to run', () => {});
}
