import { execFile } from 'node:child_process';
import { transcribeAudio } from '../../../src/ingestion/videoExtract/transcribe';

jest.mock('node:child_process');

const mockExecFile = execFile as jest.MockedFunction<typeof execFile>;

describe('transcribeAudio', () => {
  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.TRM_WHISPER_BIN;
    delete process.env.TRM_WHISPER_MODEL;
    delete process.env.TRM_WHISPER_CONCURRENCY;
  });

  it('returns trimmed transcript text on success', async () => {
    mockExecFile.mockImplementation(
      ((cmd: string, args: any, options: any, cb: Function) => {
        cb(null, { stdout: '  hello world  \n', stderr: '' });
      }) as any
    );

    const result = await transcribeAudio('/path/to/audio.wav');

    expect(result).toBe('hello world');
  });

  it('invokes whisper exactly once per call', async () => {
    mockExecFile.mockImplementation(
      ((cmd: string, args: any, options: any, cb: Function) => {
        cb(null, { stdout: 'text', stderr: '' });
      }) as any
    );

    await transcribeAudio('/path/to/audio.wav');

    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('uses TRM_WHISPER_BIN env var when set', async () => {
    process.env.TRM_WHISPER_BIN = '/custom/whisper';

    mockExecFile.mockImplementation(
      ((cmd: string, args: any, options: any, cb: Function) => {
        cb(null, { stdout: 'text', stderr: '' });
      }) as any
    );

    await transcribeAudio('/path/to/audio.wav');

    const callArgs = mockExecFile.mock.calls[0];
    expect(callArgs[0]).toBe('/custom/whisper');
  });

  it('defaults to whisper from PATH when env var not set', async () => {
    mockExecFile.mockImplementation(
      ((cmd: string, args: any, options: any, cb: Function) => {
        cb(null, { stdout: 'text', stderr: '' });
      }) as any
    );

    await transcribeAudio('/path/to/audio.wav');

    const callArgs = mockExecFile.mock.calls[0];
    expect(callArgs[0]).toBe('whisper');
  });

  it('passes filePath to whisper args', async () => {
    mockExecFile.mockImplementation(
      ((cmd: string, args: any, options: any, cb: Function) => {
        cb(null, { stdout: 'text', stderr: '' });
      }) as any
    );

    await transcribeAudio('/path/to/audio.wav');

    const callArgs = mockExecFile.mock.calls[0];
    expect(callArgs[1]).toContain('/path/to/audio.wav');
  });

  it('uses TRM_WHISPER_MODEL env var when set', async () => {
    process.env.TRM_WHISPER_MODEL = '/custom/model.pt';

    mockExecFile.mockImplementation(
      ((cmd: string, args: any, options: any, cb: Function) => {
        cb(null, { stdout: 'text', stderr: '' });
      }) as any
    );

    await transcribeAudio('/path/to/audio.wav');

    const callArgs = mockExecFile.mock.calls[0];
    expect(callArgs[1]).toContain('/custom/model.pt');
  });

  it('sizes timeout as max(30s, durationMs * 0.5) when durationMs provided', async () => {
    mockExecFile.mockImplementation(
      ((cmd: string, args: any, options: any, cb: Function) => {
        cb(null, { stdout: 'text', stderr: '' });
      }) as any
    );

    await transcribeAudio('/path/to/audio.wav', 200000);

    const callArgs = mockExecFile.mock.calls[0];
    expect(callArgs[2]).toEqual({ timeout: 100000 });
  });

  it('floors timeout at 30s for short durations', async () => {
    mockExecFile.mockImplementation(
      ((cmd: string, args: any, options: any, cb: Function) => {
        cb(null, { stdout: 'text', stderr: '' });
      }) as any
    );

    await transcribeAudio('/path/to/audio.wav', 1000);

    const callArgs = mockExecFile.mock.calls[0];
    expect(callArgs[2]).toEqual({ timeout: 30000 });
  });

  it('defaults timeout to 30s when durationMs is omitted', async () => {
    mockExecFile.mockImplementation(
      ((cmd: string, args: any, options: any, cb: Function) => {
        cb(null, { stdout: 'text', stderr: '' });
      }) as any
    );

    await transcribeAudio('/path/to/audio.wav');

    const callArgs = mockExecFile.mock.calls[0];
    expect(callArgs[2]).toEqual({ timeout: 30000 });
  });

  it('returns empty string for silent/no-speech audio (exit 0, empty stdout)', async () => {
    mockExecFile.mockImplementation(
      ((cmd: string, args: any, options: any, cb: Function) => {
        cb(null, { stdout: '   \n', stderr: '' });
      }) as any
    );

    const result = await transcribeAudio('/path/to/silent.wav');

    expect(result).toBe('');
  });

  it('includes stderr in thrown error message on non-zero exit', async () => {
    const error = new Error('Command failed');
    (error as any).code = 1;
    (error as any).stderr = 'whisper: unsupported audio format';

    mockExecFile.mockImplementation(
      ((cmd: string, args: any, options: any, cb: Function) => {
        cb(error);
      }) as any
    );

    await expect(transcribeAudio('/path/to/bad.wav')).rejects.toThrow(
      /whisper: unsupported audio format/
    );
  });

  it('differentiates a normal process failure from a timeout in the error message', async () => {
    const error = new Error('Command failed');
    (error as any).code = 1;
    (error as any).stderr = 'model load failed';

    mockExecFile.mockImplementation(
      ((cmd: string, args: any, options: any, cb: Function) => {
        cb(error);
      }) as any
    );

    await expect(transcribeAudio('/path/to/bad.wav')).rejects.toThrow(
      /process failed/i
    );
  });

  it('differentiates a timeout failure from a normal process failure in the error message', async () => {
    const timeoutError = new Error('Command timed out');
    (timeoutError as any).killed = true;
    (timeoutError as any).signal = 'SIGTERM';

    mockExecFile.mockImplementation(
      ((cmd: string, args: any, options: any, cb: Function) => {
        cb(timeoutError);
      }) as any
    );

    await expect(transcribeAudio('/path/to/long.wav', 60000)).rejects.toThrow(
      /timed out/i
    );
    await expect(transcribeAudio('/path/to/long.wav', 60000)).rejects.not.toThrow(
      /process failed/i
    );
  });

  it('runs under whisperPool honoring TRM_WHISPER_CONCURRENCY serialization (default 1)', async () => {
    const callOrder: number[] = [];
    let callIndex = 0;

    mockExecFile.mockImplementation(
      ((cmd: string, args: any, options: any, cb: Function) => {
        const idx = callIndex++;
        callOrder.push(idx);
        // Resolve asynchronously to expose any concurrent overlap.
        setImmediate(() => cb(null, { stdout: `text-${idx}`, stderr: '' }));
      }) as any
    );

    const results = await Promise.all([
      transcribeAudio('/a.wav'),
      transcribeAudio('/b.wav')
    ]);

    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(results).toEqual(['text-0', 'text-1']);
  });
});
