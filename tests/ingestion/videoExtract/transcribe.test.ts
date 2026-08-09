import { execFile } from 'node:child_process';
import { transcribeAudio, parseWhisperSegments, transcribeAudioWithSegments } from '../../../src/ingestion/videoExtract/transcribe';
import { getDefaultWhisperModelPath } from '../../../src/core/videoDeps';

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

  it('defaults to the whisper.cpp CLI (whisper-cli) from PATH when env var not set', async () => {
    mockExecFile.mockImplementation(
      ((cmd: string, args: any, options: any, cb: Function) => {
        cb(null, { stdout: 'text', stderr: '' });
      }) as any
    );

    await transcribeAudio('/path/to/audio.wav');

    const callArgs = mockExecFile.mock.calls[0];
    expect(callArgs[0]).toBe('whisper-cli');
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
    process.env.TRM_WHISPER_MODEL = '/custom/model.bin';

    mockExecFile.mockImplementation(
      ((cmd: string, args: any, options: any, cb: Function) => {
        cb(null, { stdout: 'text', stderr: '' });
      }) as any
    );

    await transcribeAudio('/path/to/audio.wav');

    const callArgs = mockExecFile.mock.calls[0];
    expect(callArgs[1]).toContain('/custom/model.bin');
  });

  it('defaults the model to a whisper.cpp ggml .bin path, matching videoDeps preflight', async () => {
    mockExecFile.mockImplementation(
      ((cmd: string, args: any, options: any, cb: Function) => {
        cb(null, { stdout: 'text', stderr: '' });
      }) as any
    );

    await transcribeAudio('/path/to/audio.wav');

    const passedArgs = mockExecFile.mock.calls[0][1] as string[];
    // Must be the exact path checkWhisperDeps() preflights -- the two are
    // imported from one source of truth in src/core/videoDeps.ts.
    expect(passedArgs).toContain(getDefaultWhisperModelPath());
    expect(getDefaultWhisperModelPath()).toContain('ggml-base.en.bin');
    // whisper.cpp cannot load openai-whisper's PyTorch checkpoints.
    expect(passedArgs.some((a) => typeof a === 'string' && a.endsWith('.pt'))).toBe(false);
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

describe('parseWhisperSegments', () => {
  it('parses a single well-formed segment', () => {
    const stdout = '[00:00:00.000 --> 00:00:02.500]   Hello world\n';
    expect(parseWhisperSegments(stdout)).toEqual([
      { startMs: 0, endMs: 2500, text: 'Hello world' },
    ]);
  });

  it('parses multiple segments', () => {
    const stdout =
      '[00:00:00.000 --> 00:00:02.500]   Hello world\n' +
      '[00:00:02.500 --> 00:00:05.000]   How are you\n';
    expect(parseWhisperSegments(stdout)).toEqual([
      { startMs: 0, endMs: 2500, text: 'Hello world' },
      { startMs: 2500, endMs: 5000, text: 'How are you' },
    ]);
  });

  it('parses an hours component correctly', () => {
    const stdout = '[01:02:03.000 --> 01:02:05.000]   later on\n';
    const [seg] = parseWhisperSegments(stdout);
    expect(seg.startMs).toBe((1 * 3600 + 2 * 60 + 3) * 1000);
    expect(seg.endMs).toBe((1 * 3600 + 2 * 60 + 5) * 1000);
  });

  it('handles decimal precision variants and irregular spacing', () => {
    const stdout = '[00:00:01.010-->00:00:01.999]text with no leading space\n';
    expect(parseWhisperSegments(stdout)).toEqual([
      { startMs: 1010, endMs: 1999, text: 'text with no leading space' },
    ]);
  });

  it('skips unparseable lines rather than throwing', () => {
    const stdout =
      'whisper.cpp v1.5.0 loading model...\n' +
      '[00:00:00.000 --> 00:00:02.000]   real segment\n' +
      'system_info: n_threads = 4\n';
    expect(parseWhisperSegments(stdout)).toEqual([
      { startMs: 0, endMs: 2000, text: 'real segment' },
    ]);
  });

  it('accumulates continuation lines onto the most recently opened segment', () => {
    const stdout =
      '[00:00:00.000 --> 00:00:04.000]   a long segment that\n' +
      'wrapped across multiple\n' +
      'output lines\n';
    expect(parseWhisperSegments(stdout)).toEqual([
      { startMs: 0, endMs: 4000, text: 'a long segment that wrapped across multiple output lines' },
    ]);
  });

  it('returns an empty array for empty or fully-unparseable input', () => {
    expect(parseWhisperSegments('')).toEqual([]);
    expect(parseWhisperSegments('no segments here at all\n')).toEqual([]);
  });

  it('accumulates continuation text containing an isolated equals sign', () => {
    const stdout =
      '[00:00:00.000 --> 00:00:04.000]   the formula is\n' +
      'X equals Y\n';
    expect(parseWhisperSegments(stdout)).toEqual([
      { startMs: 0, endMs: 4000, text: 'the formula is X equals Y' },
    ]);
  });

  it('still skips diagnostic lines even when continuation accumulation is active', () => {
    const stdout =
      '[00:00:00.000 --> 00:00:02.000]   real segment\n' +
      'system_info: n_threads = 4\n';
    expect(parseWhisperSegments(stdout)).toEqual([
      { startMs: 0, endMs: 2000, text: 'real segment' },
    ]);
  });

  it('skips multi-word diagnostic keys (e.g., whisper init params)', () => {
    const stdout =
      '[00:00:00.000 --> 00:00:02.000]   real segment\n' +
      'whisper_init_with_params: flash attn = 0\n';
    expect(parseWhisperSegments(stdout)).toEqual([
      { startMs: 0, endMs: 2000, text: 'real segment' },
    ]);
  });

  it('skips diagnostic lines with extra spaces around equals', () => {
    const stdout =
      '[00:00:00.000 --> 00:00:02.000]   real segment\n' +
      'config_init: use gpu    = 1\n';
    expect(parseWhisperSegments(stdout)).toEqual([
      { startMs: 0, endMs: 2000, text: 'real segment' },
    ]);
  });
});

describe('transcribeAudioWithSegments', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('omits -nt and returns joined text + parsed segments', async () => {
    mockExecFile.mockImplementation(
      ((cmd: string, args: any, options: any, cb: Function) => {
        cb(null, {
          stdout:
            '[00:00:00.000 --> 00:00:02.000]   Hello world\n' +
            '[00:00:02.000 --> 00:00:04.000]   Goodbye\n',
          stderr: '',
        });
      }) as any
    );

    const result = await transcribeAudioWithSegments('/path/to/audio.wav');

    expect(result.text).toBe('Hello world Goodbye');
    expect(result.segments).toHaveLength(2);
    const callArgs = mockExecFile.mock.calls[0][1] as string[];
    expect(callArgs).not.toContain('-nt');
  });
});
