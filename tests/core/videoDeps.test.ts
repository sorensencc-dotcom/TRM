import { execFile } from 'node:child_process';
import {
  checkFfmpegDeps,
  checkWhisperDeps,
  __resetWhisperCheckForTesting,
  getVideoMaxBytes,
  getVideoMaxDurationMs,
} from '../../src/core/videoDeps';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

jest.mock('node:child_process');
jest.mock('node:fs');
jest.mock('node:os');

const mockExecFile = execFile as jest.MockedFunction<typeof execFile>;
const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockOs = os as jest.Mocked<typeof os>;

describe('checkFfmpegDeps', () => {
  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.TRM_FFMPEG_PATH;
    delete process.env.TRM_FFPROBE_PATH;
  });

  it('succeeds when both ffmpeg and ffprobe are available in PATH', async () => {
    mockExecFile.mockImplementation(((cmd: string, args: any, options: any, cb: Function) => {
      // Simulate successful version check
      cb(null, { stdout: 'ffmpeg version N-123' });
    }) as any);

    await expect(checkFfmpegDeps()).resolves.toBeUndefined();
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it('passes timeout option to execFile for ffmpeg', async () => {
    mockExecFile.mockImplementation(((cmd: string, args: any, options: any, cb: Function) => {
      cb(null, { stdout: 'version info' });
    }) as any);

    await checkFfmpegDeps();

    // Verify first call (ffmpeg) includes timeout option
    const firstCall = mockExecFile.mock.calls[0];
    expect(firstCall[0]).toBe('ffmpeg');
    expect(firstCall[1]).toEqual(['-version']);
    expect(firstCall[2]).toEqual({ timeout: 5000 });
  });

  it('passes timeout option to execFile for ffprobe', async () => {
    mockExecFile.mockImplementation(((cmd: string, args: any, options: any, cb: Function) => {
      cb(null, { stdout: 'version info' });
    }) as any);

    await checkFfmpegDeps();

    // Verify second call (ffprobe) includes timeout option
    const secondCall = mockExecFile.mock.calls[1];
    expect(secondCall[0]).toBe('ffprobe');
    expect(secondCall[1]).toEqual(['-version']);
    expect(secondCall[2]).toEqual({ timeout: 5000 });
  });

  it('succeeds when using env vars for custom paths', async () => {
    process.env.TRM_FFMPEG_PATH = '/custom/ffmpeg';
    process.env.TRM_FFPROBE_PATH = '/custom/ffprobe';

    mockExecFile.mockImplementation(((cmd: string, args: any, options: any, cb: Function) => {
      cb(null, { stdout: 'version info' });
    }) as any);

    await expect(checkFfmpegDeps()).resolves.toBeUndefined();

    const firstCall = mockExecFile.mock.calls[0];
    expect(firstCall[0]).toBe('/custom/ffmpeg');

    const secondCall = mockExecFile.mock.calls[1];
    expect(secondCall[0]).toBe('/custom/ffprobe');
  });

  it('includes stderr in error message when available', async () => {
    mockExecFile.mockImplementation(((cmd: string, args: any, options: any, cb: Function) => {
      if (cmd === 'ffmpeg') {
        const error = new Error('Command failed');
        (error as any).stderr = 'ffmpeg: error loading libfoo.so';
        cb(error);
      } else {
        cb(null, { stdout: 'version info' });
      }
    }) as any);

    await expect(checkFfmpegDeps()).rejects.toThrow(
      /ffmpeg not found in PATH.*Details: ffmpeg: error loading libfoo.so/
    );
  });

  it('includes error message in error output when stderr unavailable', async () => {
    mockExecFile.mockImplementation(((cmd: string, args: any, options: any, cb: Function) => {
      if (cmd === 'ffmpeg') {
        cb(new Error('no such file or directory'));
      } else {
        cb(null, { stdout: 'version info' });
      }
    }) as any);

    await expect(checkFfmpegDeps()).rejects.toThrow(
      /ffmpeg not found in PATH.*Details: no such file or directory/
    );
  });

  it('throws error if ffmpeg is not found in PATH', async () => {
    mockExecFile.mockImplementation(((cmd: string, args: any, options: any, cb: Function) => {
      if (cmd === 'ffmpeg') {
        cb(new Error('not found'));
      } else {
        cb(null, { stdout: 'version info' });
      }
    }) as any);

    await expect(checkFfmpegDeps()).rejects.toThrow(
      /ffmpeg not found in PATH.*TRM_FFMPEG_PATH/
    );
  });

  it('throws error if ffprobe is not found in PATH', async () => {
    mockExecFile.mockImplementation(((cmd: string, args: any, options: any, cb: Function) => {
      if (cmd === 'ffprobe') {
        cb(new Error('not found'));
      } else {
        cb(null, { stdout: 'version info' });
      }
    }) as any);

    await expect(checkFfmpegDeps()).rejects.toThrow(
      /ffprobe not found in PATH.*TRM_FFPROBE_PATH/
    );
  });

  it('throws detailed error if configured ffmpeg path does not exist', async () => {
    process.env.TRM_FFMPEG_PATH = '/nonexistent/ffmpeg';

    mockExecFile.mockImplementation(((cmd: string, args: any, options: any, cb: Function) => {
      if (cmd === '/nonexistent/ffmpeg') {
        cb(new Error('no such file or directory'));
      } else {
        cb(null, { stdout: 'version info' });
      }
    }) as any);

    await expect(checkFfmpegDeps()).rejects.toThrow(
      /Failed to find ffmpeg at configured path.*\/nonexistent\/ffmpeg.*TRM_FFMPEG_PATH/
    );
  });

  it('throws detailed error if configured ffprobe path does not exist', async () => {
    process.env.TRM_FFPROBE_PATH = '/nonexistent/ffprobe';

    mockExecFile.mockImplementation(((cmd: string, args: any, options: any, cb: Function) => {
      if (cmd === 'ffmpeg') {
        cb(null, { stdout: 'version info' });
      } else if (cmd === '/nonexistent/ffprobe') {
        cb(new Error('no such file or directory'));
      }
    }) as any);

    await expect(checkFfmpegDeps()).rejects.toThrow(
      /Failed to find ffprobe at configured path.*\/nonexistent\/ffprobe.*TRM_FFPROBE_PATH/
    );
  });

  it('calls ffmpeg first, then ffprobe, in order', async () => {
    const callOrder: string[] = [];

    mockExecFile.mockImplementation(((cmd: string, args: any, options: any, cb: Function) => {
      callOrder.push(cmd);
      cb(null, { stdout: 'version info' });
    }) as any);

    await checkFfmpegDeps();
    expect(callOrder).toEqual(['ffmpeg', 'ffprobe']);
  });
});

describe('checkWhisperDeps', () => {
  beforeEach(() => {
    __resetWhisperCheckForTesting();
    jest.clearAllMocks();
    delete process.env.TRM_WHISPER_BIN;
    delete process.env.TRM_WHISPER_MODEL;
    mockOs.homedir.mockReturnValue('/home/testuser');
  });

  afterEach(() => {
    __resetWhisperCheckForTesting();
    jest.clearAllMocks();
    delete process.env.TRM_WHISPER_BIN;
    delete process.env.TRM_WHISPER_MODEL;
  });

  it('succeeds when whisper binary and model are available', async () => {
    mockExecFile.mockImplementation(((cmd: string, args: any, options: any, cb: Function) => {
      if (cmd === 'whisper-cli') {
        cb(null, { stdout: 'whisper help' });
      }
    }) as any);

    mockExistsSync.mockReturnValue(true);

    await expect(checkWhisperDeps()).resolves.toBeUndefined();
    expect(mockExecFile).toHaveBeenCalledWith('whisper-cli', ['-h'], { timeout: 5000 }, expect.any(Function));
    const expectedModelPath = path.join('/home/testuser', '.cache', 'whisper', 'ggml-base.en.bin');
    expect(mockExistsSync).toHaveBeenCalledWith(expectedModelPath);
  });

  it('simulates N concurrent calls and ensures underlying binary check fires exactly once', async () => {
    const execFileCallCount = { count: 0 };
    mockExecFile.mockImplementation(((cmd: string, args: any, options: any, cb: Function) => {
      if (cmd === 'whisper-cli') {
        execFileCallCount.count += 1;
        // Simulate small delay to allow concurrent calls to queue up
        setTimeout(() => cb(null, { stdout: 'whisper help' }), 10);
      }
    }) as any);

    mockExistsSync.mockReturnValue(true);

    // Simulate ioLimit fan-out with concurrent calls
    const promises = Array.from({ length: 8 }, () => checkWhisperDeps());
    await Promise.all(promises);

    // Binary check should have fired exactly once despite 8 concurrent calls
    expect(execFileCallCount.count).toBe(1);
    expect(mockExistsSync).toHaveBeenCalledTimes(1);
  });

  it('uses configured TRM_WHISPER_BIN path', async () => {
    process.env.TRM_WHISPER_BIN = '/custom/whisper';

    mockExecFile.mockImplementation(((cmd: string, args: any, options: any, cb: Function) => {
      if (cmd === '/custom/whisper') {
        cb(null, { stdout: 'whisper help' });
      }
    }) as any);

    mockExistsSync.mockReturnValue(true);

    await expect(checkWhisperDeps()).resolves.toBeUndefined();

    const callArgs = mockExecFile.mock.calls[0];
    expect(callArgs[0]).toBe('/custom/whisper');
  });

  it('throws error when whisper binary is not found in PATH', async () => {
    mockExecFile.mockImplementation(((cmd: string, args: any, options: any, cb: Function) => {
      if (cmd === 'whisper-cli') {
        cb(new Error('not found'));
      }
    }) as any);

    mockExistsSync.mockReturnValue(true);

    await expect(checkWhisperDeps()).rejects.toThrow(
      /whisper-cli not found in PATH.*TRM_WHISPER_BIN/
    );
  });

  it('throws detailed error when configured whisper binary path does not exist', async () => {
    process.env.TRM_WHISPER_BIN = '/nonexistent/whisper';

    mockExecFile.mockImplementation(((cmd: string, args: any, options: any, cb: Function) => {
      if (cmd === '/nonexistent/whisper') {
        cb(new Error('no such file or directory'));
      }
    }) as any);

    mockExistsSync.mockReturnValue(true);

    await expect(checkWhisperDeps()).rejects.toThrow(
      /Failed to find whisper at configured path.*\/nonexistent\/whisper.*TRM_WHISPER_BIN/
    );
  });

  it('throws error when model file is not found at default path', async () => {
    mockExecFile.mockImplementation(((cmd: string, args: any, options: any, cb: Function) => {
      if (cmd === 'whisper-cli') {
        cb(null, { stdout: 'whisper help' });
      }
    }) as any);

    mockExistsSync.mockReturnValue(false);

    await expect(checkWhisperDeps()).rejects.toThrow(
      /Whisper model not found at default path/
    );

    // Also verify the error mentions the env var
    try {
      __resetWhisperCheckForTesting();
      await checkWhisperDeps();
    } catch (err: any) {
      expect(err.message).toContain('TRM_WHISPER_MODEL');
    }
  });

  it('uses configured TRM_WHISPER_MODEL path', async () => {
    process.env.TRM_WHISPER_MODEL = '/custom/model.bin';

    mockExecFile.mockImplementation(((cmd: string, args: any, options: any, cb: Function) => {
      if (cmd === 'whisper-cli') {
        cb(null, { stdout: 'whisper help' });
      }
    }) as any);

    mockExistsSync.mockReturnValue(true);

    await expect(checkWhisperDeps()).resolves.toBeUndefined();

    expect(mockExistsSync).toHaveBeenCalledWith('/custom/model.bin');
  });

  it('throws detailed error when configured model path does not exist', async () => {
    process.env.TRM_WHISPER_MODEL = '/nonexistent/model.bin';

    mockExecFile.mockImplementation(((cmd: string, args: any, options: any, cb: Function) => {
      if (cmd === 'whisper-cli') {
        cb(null, { stdout: 'whisper help' });
      }
    }) as any);

    mockExistsSync.mockReturnValue(false);

    await expect(checkWhisperDeps()).rejects.toThrow(
      /Failed to find whisper model at configured path.*\/nonexistent\/model.bin.*TRM_WHISPER_MODEL/
    );
  });

  it('includes stderr in error message when binary check fails', async () => {
    mockExecFile.mockImplementation(((cmd: string, args: any, options: any, cb: Function) => {
      if (cmd === 'whisper-cli') {
        const error = new Error('Command failed');
        (error as any).stderr = 'whisper: error loading CUDA';
        cb(error);
      }
    }) as any);

    mockExistsSync.mockReturnValue(true);

    await expect(checkWhisperDeps()).rejects.toThrow(
      /whisper-cli not found in PATH.*Details: whisper: error loading CUDA/
    );
  });

  it('passes timeout option to execFile for whisper binary check', async () => {
    mockExecFile.mockImplementation(((cmd: string, args: any, options: any, cb: Function) => {
      if (cmd === 'whisper-cli') {
        cb(null, { stdout: 'whisper help' });
      }
    }) as any);

    mockExistsSync.mockReturnValue(true);

    await checkWhisperDeps();

    const callArgs = mockExecFile.mock.calls[0];
    expect(callArgs[0]).toBe('whisper-cli');
    expect(callArgs[1]).toEqual(['-h']);
    expect(callArgs[2]).toEqual({ timeout: 5000 });
  });

  it('memoizes the result and does not reset after resolution', async () => {
    mockExecFile.mockImplementation(((cmd: string, args: any, options: any, cb: Function) => {
      if (cmd === 'whisper-cli') {
        cb(null, { stdout: 'whisper help' });
      }
    }) as any);

    mockExistsSync.mockReturnValue(true);

    // First call
    await checkWhisperDeps();
    const firstCallCount = mockExecFile.mock.calls.length;

    // Second call should reuse memoized promise
    await checkWhisperDeps();
    const secondCallCount = mockExecFile.mock.calls.length;

    // Binary check should not have been called again
    expect(secondCallCount).toBe(firstCallCount);
  });
});

describe('getVideoMaxBytes', () => {
  afterEach(() => {
    delete process.env.TRM_VIDEO_MAX_BYTES;
  });

  it('defaults to 5 GB when unset', () => {
    expect(getVideoMaxBytes()).toBe(5 * 1024 * 1024 * 1024);
  });

  it('honors a positive-integer TRM_VIDEO_MAX_BYTES', () => {
    process.env.TRM_VIDEO_MAX_BYTES = '1024';
    expect(getVideoMaxBytes()).toBe(1024);
  });

  it('falls back to the default for a non-numeric value', () => {
    process.env.TRM_VIDEO_MAX_BYTES = 'not-a-number';
    expect(getVideoMaxBytes()).toBe(5 * 1024 * 1024 * 1024);
  });

  it('falls back to the default for a zero or negative value', () => {
    process.env.TRM_VIDEO_MAX_BYTES = '0';
    expect(getVideoMaxBytes()).toBe(5 * 1024 * 1024 * 1024);
    process.env.TRM_VIDEO_MAX_BYTES = '-5';
    expect(getVideoMaxBytes()).toBe(5 * 1024 * 1024 * 1024);
  });
});

describe('getVideoMaxDurationMs', () => {
  afterEach(() => {
    delete process.env.TRM_VIDEO_MAX_DURATION_MS;
  });

  it('defaults to 2 hours when unset', () => {
    expect(getVideoMaxDurationMs()).toBe(2 * 60 * 60 * 1000);
  });

  it('honors a positive-integer TRM_VIDEO_MAX_DURATION_MS', () => {
    process.env.TRM_VIDEO_MAX_DURATION_MS = '5000';
    expect(getVideoMaxDurationMs()).toBe(5000);
  });

  it('falls back to the default for a non-numeric value', () => {
    process.env.TRM_VIDEO_MAX_DURATION_MS = 'nope';
    expect(getVideoMaxDurationMs()).toBe(2 * 60 * 60 * 1000);
  });
});
