import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { extractAudio, AUDIO_FILENAME } from '../../../src/ingestion/videoExtract/extractAudio';

jest.mock('node:child_process');

const mockExecFile = execFile as jest.MockedFunction<typeof execFile>;

const TEMP_DIR = path.join('/tmp', 'trm-video-abc');
const VIDEO_PATH = '/videos/reel.mp4';

function mockSuccess() {
  mockExecFile.mockImplementation(
    ((cmd: string, args: any, options: any, cb: Function) => {
      cb(null, { stdout: '', stderr: '' });
    }) as any
  );
}

describe('extractAudio', () => {
  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.TRM_FFMPEG_PATH;
  });

  it('invokes ffmpeg exactly once per call', async () => {
    mockSuccess();

    await extractAudio(VIDEO_PATH, TEMP_DIR);

    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('maps audio stream index 0 explicitly (CONTEXT.md #5: v1 transcribes stream 0 only)', async () => {
    mockSuccess();

    await extractAudio(VIDEO_PATH, TEMP_DIR);

    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain('-map');
    expect(args[args.indexOf('-map') + 1]).toBe('0:a:0');
  });

  it('writes 16kHz mono WAV (the only format stock whisper.cpp can decode)', async () => {
    mockSuccess();

    await extractAudio(VIDEO_PATH, TEMP_DIR);

    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args[args.indexOf('-ar') + 1]).toBe('16000');
    expect(args[args.indexOf('-ac') + 1]).toBe('1');
    expect(args[args.indexOf('-f') + 1]).toBe('wav');
  });

  it('reads the source video and returns the WAV path inside the given temp dir', async () => {
    mockSuccess();

    const result = await extractAudio(VIDEO_PATH, TEMP_DIR);

    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args[args.indexOf('-i') + 1]).toBe(VIDEO_PATH);
    expect(result).toBe(path.join(TEMP_DIR, AUDIO_FILENAME));
    expect(args).toContain(result);
  });

  it('does not collide with extractFrames output in the shared per-video temp dir', async () => {
    mockSuccess();

    const result = await extractAudio(VIDEO_PATH, TEMP_DIR);

    // extractFrames() reads the same dir back and filters on /^frame-\d{3}\.jpg$/;
    // the audio file must not match that pattern.
    expect(/^frame-\d{3}\.jpg$/.test(path.basename(result))).toBe(false);
  });

  it('honors TRM_FFMPEG_PATH', async () => {
    process.env.TRM_FFMPEG_PATH = '/custom/ffmpeg';
    mockSuccess();

    await extractAudio(VIDEO_PATH, TEMP_DIR);

    expect(mockExecFile.mock.calls[0][0]).toBe('/custom/ffmpeg');
  });

  it('defaults to ffmpeg from PATH when TRM_FFMPEG_PATH is unset', async () => {
    mockSuccess();

    await extractAudio(VIDEO_PATH, TEMP_DIR);

    expect(mockExecFile.mock.calls[0][0]).toBe('ffmpeg');
  });

  it('passes an explicit subprocess timeout', async () => {
    mockSuccess();

    await extractAudio(VIDEO_PATH, TEMP_DIR);

    expect(mockExecFile.mock.calls[0][2]).toEqual({ timeout: 120000 });
  });

  it('throws with stderr captured on ffmpeg failure', async () => {
    const error = new Error('Command failed');
    (error as any).code = 1;
    (error as any).stderr = 'Stream map 0:a:0 matches no streams';

    mockExecFile.mockImplementation(
      ((cmd: string, args: any, options: any, cb: Function) => {
        cb(error);
      }) as any
    );

    await expect(extractAudio(VIDEO_PATH, TEMP_DIR)).rejects.toThrow(
      /Failed to extract audio from video file .*reel\.mp4.*Stream map 0:a:0 matches no streams/
    );
  });

  it('throws on timeout with the source file named', async () => {
    const timeoutError = new Error('Command timed out');
    (timeoutError as any).killed = true;
    (timeoutError as any).signal = 'SIGTERM';

    mockExecFile.mockImplementation(
      ((cmd: string, args: any, options: any, cb: Function) => {
        cb(timeoutError);
      }) as any
    );

    await expect(extractAudio(VIDEO_PATH, TEMP_DIR)).rejects.toThrow(
      /Failed to extract audio from video file "\/videos\/reel\.mp4"/
    );
  });
});
