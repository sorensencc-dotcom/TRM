import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractFrames, buildFfmpegArgs } from '../../../src/ingestion/videoExtract/extractFrames';

jest.mock('node:child_process');

const mockExecFile = execFile as jest.MockedFunction<typeof execFile>;

// Writes `count` fake frame files into `tempDir`, simulating what a real
// ffmpeg invocation with the `frame-%03d.jpg` output pattern would produce.
function writeFakeFrames(tempDir: string, count: number): void {
  for (let i = 1; i <= count; i++) {
    const name = `frame-${String(i).padStart(3, '0')}.jpg`;
    fs.writeFileSync(path.join(tempDir, name), '');
  }
}

describe('extractFrames', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-extract-frames-'));
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.TRM_FFMPEG_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('strategy selection (buildFfmpegArgs)', () => {
    it('uses a single midpoint frame for durations < 10000ms', () => {
      const args = buildFfmpegArgs('/in.mp4', 8000, '/tmp/frame-%03d.jpg');
      expect(args).toContain('-ss');
      expect(args[args.indexOf('-ss') + 1]).toBe('4.000');
      expect(args).toContain('-vframes');
      expect(args[args.indexOf('-vframes') + 1]).toBe('1');
      expect(args.join(' ')).not.toContain('fps=1/10');
      expect(args.join(' ')).not.toContain('select=');
    });

    it('uses fps=1/10 for durations < 300000ms (and >= 10000ms)', () => {
      const args = buildFfmpegArgs('/in.mp4', 299000, '/tmp/frame-%03d.jpg');
      const vf = args[args.indexOf('-vf') + 1];
      expect(vf).toContain('fps=1/10');
      expect(vf).not.toContain('select=');
      expect(args).not.toContain('-frames:v');
    });

    it('uses an evenly-spaced select filter capped at 30 for durations >= 300000ms (exact boundary)', () => {
      const args = buildFfmpegArgs('/in.mp4', 300000, '/tmp/frame-%03d.jpg');
      const vf = args[args.indexOf('-vf') + 1];
      expect(vf).toContain('select=');
      expect(vf).not.toContain('fps=1/10');
      expect(args).toContain('-frames:v');
      expect(args[args.indexOf('-frames:v') + 1]).toBe('30');
    });

    it('uses the select-filter strategy for durations just past the 300000ms boundary', () => {
      const args = buildFfmpegArgs('/in.mp4', 301000, '/tmp/frame-%03d.jpg');
      const vf = args[args.indexOf('-vf') + 1];
      expect(vf).toContain('select=');
    });

    it('includes the 1024px max-long-edge scale filter in every strategy', () => {
      for (const durationMs of [8000, 299000, 300000, 301000]) {
        const args = buildFfmpegArgs('/in.mp4', durationMs, '/tmp/frame-%03d.jpg');
        const vf = args[args.indexOf('-vf') + 1];
        expect(vf).toContain('scale=1024:1024:force_original_aspect_ratio=decrease');
      }
    });
  });

  describe('extractFrames (spawn count + fixtures)', () => {
    const fixtures: Array<{ label: string; durationMs: number; expectedFrameCount: number }> = [
      { label: '0:08', durationMs: 8000, expectedFrameCount: 1 },
      { label: '4:59', durationMs: 299000, expectedFrameCount: 30 },
      { label: '5:00', durationMs: 300000, expectedFrameCount: 30 },
      { label: '5:01', durationMs: 301000, expectedFrameCount: 30 },
    ];

    for (const fixture of fixtures) {
      it(`spawns ffmpeg exactly once and returns <=30 frames for duration ${fixture.label}`, async () => {
        mockExecFile.mockImplementation(
          ((cmd: string, args: any, options: any, cb: Function) => {
            writeFakeFrames(tempDir, fixture.expectedFrameCount);
            cb(null, { stdout: '', stderr: '' });
          }) as any
        );

        const frames = await extractFrames('/videos/in.mp4', fixture.durationMs, tempDir);

        expect(mockExecFile).toHaveBeenCalledTimes(1);
        expect(frames.length).toBeLessThanOrEqual(30);
        expect(frames.length).toBe(fixture.expectedFrameCount);
        for (const framePath of frames) {
          expect(framePath.startsWith(tempDir)).toBe(true);
        }
      });
    }
  });

  it('returns frame paths sorted in order', async () => {
    mockExecFile.mockImplementation(
      ((cmd: string, args: any, options: any, cb: Function) => {
        // Write out of order to prove extractFrames sorts, not just echoes readdir order.
        fs.writeFileSync(path.join(tempDir, 'frame-003.jpg'), '');
        fs.writeFileSync(path.join(tempDir, 'frame-001.jpg'), '');
        fs.writeFileSync(path.join(tempDir, 'frame-002.jpg'), '');
        cb(null, { stdout: '', stderr: '' });
      }) as any
    );

    const frames = await extractFrames('/videos/in.mp4', 60000, tempDir);

    expect(frames).toEqual([
      path.join(tempDir, 'frame-001.jpg'),
      path.join(tempDir, 'frame-002.jpg'),
      path.join(tempDir, 'frame-003.jpg'),
    ]);
  });

  it('ignores non-frame files already present in tempDir', async () => {
    fs.writeFileSync(path.join(tempDir, 'unrelated.txt'), 'noise');

    mockExecFile.mockImplementation(
      ((cmd: string, args: any, options: any, cb: Function) => {
        writeFakeFrames(tempDir, 1);
        cb(null, { stdout: '', stderr: '' });
      }) as any
    );

    const frames = await extractFrames('/videos/in.mp4', 8000, tempDir);

    expect(frames).toEqual([path.join(tempDir, 'frame-001.jpg')]);
  });

  it('uses TRM_FFMPEG_PATH env var when set', async () => {
    process.env.TRM_FFMPEG_PATH = '/custom/ffmpeg';

    mockExecFile.mockImplementation(
      ((cmd: string, args: any, options: any, cb: Function) => {
        if (cmd === '/custom/ffmpeg') {
          writeFakeFrames(tempDir, 1);
          cb(null, { stdout: '', stderr: '' });
        }
      }) as any
    );

    await extractFrames('/videos/in.mp4', 8000, tempDir);

    const callArgs = mockExecFile.mock.calls[0];
    expect(callArgs[0]).toBe('/custom/ffmpeg');
  });

  it('defaults to ffmpeg from PATH when env var not set', async () => {
    mockExecFile.mockImplementation(
      ((cmd: string, args: any, options: any, cb: Function) => {
        if (cmd === 'ffmpeg') {
          writeFakeFrames(tempDir, 1);
          cb(null, { stdout: '', stderr: '' });
        }
      }) as any
    );

    await extractFrames('/videos/in.mp4', 8000, tempDir);

    const callArgs = mockExecFile.mock.calls[0];
    expect(callArgs[0]).toBe('ffmpeg');
  });

  it('passes a 120s timeout to ffmpeg', async () => {
    mockExecFile.mockImplementation(
      ((cmd: string, args: any, options: any, cb: Function) => {
        writeFakeFrames(tempDir, 1);
        cb(null, { stdout: '', stderr: '' });
      }) as any
    );

    await extractFrames('/videos/in.mp4', 8000, tempDir);

    const callArgs = mockExecFile.mock.calls[0];
    expect(callArgs[2]).toEqual({ timeout: 120000 });
  });

  it('throws a contextualized error when ffmpeg fails', async () => {
    const execError = new Error('Command failed');
    (execError as any).stderr = 'Invalid data found when processing input';

    mockExecFile.mockImplementation(
      ((cmd: string, args: any, options: any, cb: Function) => {
        cb(execError);
      }) as any
    );

    await expect(extractFrames('/videos/corrupt.mp4', 8000, tempDir)).rejects.toThrow(
      /Failed to extract frames from video file.*Invalid data found when processing input/
    );
  });

  it('throws a contextualized error when ffmpeg times out', async () => {
    const timeoutError = new Error('Killed');
    (timeoutError as any).code = 'ETIMEDOUT';
    (timeoutError as any).killed = true;

    mockExecFile.mockImplementation(
      ((cmd: string, args: any, options: any, cb: Function) => {
        cb(timeoutError);
      }) as any
    );

    await expect(extractFrames('/videos/huge.mp4', 301000, tempDir)).rejects.toThrow(
      /Failed to extract frames from video file/
    );
  });
});
