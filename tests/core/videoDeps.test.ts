import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkFfmpegDeps } from '../../src/core/videoDeps';

jest.mock('node:child_process');

const mockExecFile = execFile as jest.MockedFunction<typeof execFile>;
const execFileAsync = promisify(mockExecFile);

describe('checkFfmpegDeps', () => {
  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.TRM_FFMPEG_PATH;
    delete process.env.TRM_FFPROBE_PATH;
  });

  it('succeeds when both ffmpeg and ffprobe are available in PATH', async () => {
    mockExecFile.mockImplementation(((cmd: string, args: any, cb: Function) => {
      // Simulate successful version check
      cb(null, { stdout: 'ffmpeg version N-123' });
    }) as any);

    await expect(checkFfmpegDeps()).resolves.toBeUndefined();
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(mockExecFile).toHaveBeenCalledWith('ffmpeg', ['-version'], expect.any(Function));
    expect(mockExecFile).toHaveBeenCalledWith('ffprobe', ['-version'], expect.any(Function));
  });

  it('succeeds when using env vars for custom paths', async () => {
    process.env.TRM_FFMPEG_PATH = '/custom/ffmpeg';
    process.env.TRM_FFPROBE_PATH = '/custom/ffprobe';

    mockExecFile.mockImplementation(((cmd: string, args: any, cb: Function) => {
      cb(null, { stdout: 'version info' });
    }) as any);

    await expect(checkFfmpegDeps()).resolves.toBeUndefined();
    expect(mockExecFile).toHaveBeenCalledWith('/custom/ffmpeg', ['-version'], expect.any(Function));
    expect(mockExecFile).toHaveBeenCalledWith('/custom/ffprobe', ['-version'], expect.any(Function));
  });

  it('throws error if ffmpeg is not found in PATH', async () => {
    mockExecFile.mockImplementation(((cmd: string, args: any, cb: Function) => {
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
    mockExecFile.mockImplementation(((cmd: string, args: any, cb: Function) => {
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

    mockExecFile.mockImplementation(((cmd: string, args: any, cb: Function) => {
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

    mockExecFile.mockImplementation(((cmd: string, args: any, cb: Function) => {
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

    mockExecFile.mockImplementation(((cmd: string, args: any, cb: Function) => {
      callOrder.push(cmd);
      cb(null, { stdout: 'version info' });
    }) as any);

    await checkFfmpegDeps();
    expect(callOrder).toEqual(['ffmpeg', 'ffprobe']);
  });
});
