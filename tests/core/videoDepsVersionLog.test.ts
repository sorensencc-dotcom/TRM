import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  captureVideoDepsVersions,
  appendVideoDepsVersions,
  readVideoDepsVersions,
} from '../../src/core/videoDepsVersionLog';

jest.mock('node:child_process');

const mockExecFile = execFile as jest.MockedFunction<typeof execFile>;

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trm-videodepsversions-'));
}

describe('appendVideoDepsVersions / readVideoDepsVersions', () => {
  it('returns an empty array when no log file exists yet', () => {
    const root = makeRoot();
    expect(readVideoDepsVersions(root)).toEqual([]);
  });

  it('appends and reads back entries in order', () => {
    const root = makeRoot();
    const entry1 = {
      schema_version: 1 as const,
      topic: 'charlie/benson-ford',
      ts: '2026-08-08T00:00:00.000Z',
      ffmpegVersion: 'ffmpeg version 9.0',
      ffprobeVersion: 'ffprobe version 9.0',
      whisperVersion: '1.9.2',
      whisperModelPath: '/home/user/.cache/whisper/ggml-base.en.bin',
      whisperModelSizeBytes: 147964211,
      whisperModelMtime: '2026-08-01T00:00:00.000Z',
    };
    const entry2 = { ...entry1, ts: '2026-08-08T01:00:00.000Z', ffmpegVersion: 'ffmpeg version 9.1' };
    appendVideoDepsVersions(root, entry1);
    appendVideoDepsVersions(root, entry2);

    expect(readVideoDepsVersions(root)).toEqual([entry1, entry2]);
  });
});

describe('captureVideoDepsVersions', () => {
  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.TRM_FFMPEG_PATH;
    delete process.env.TRM_FFPROBE_PATH;
    delete process.env.TRM_WHISPER_BIN;
    delete process.env.TRM_WHISPER_MODEL;
  });

  it('captures the first line of ffmpeg/ffprobe -version output', async () => {
    mockExecFile.mockImplementation(((cmd: string, args: any, options: any, cb: Function) => {
      if (cmd === 'ffmpeg') {
        cb(null, { stdout: 'ffmpeg version 9.0-essentials_build\nCopyright...', stderr: '' });
      } else if (cmd === 'ffprobe') {
        cb(null, { stdout: 'ffprobe version 9.0-essentials_build\nCopyright...', stderr: '' });
      } else {
        cb(new Error('ENOENT'));
      }
    }) as any);

    const result = await captureVideoDepsVersions();

    expect(result.ffmpegVersion).toBe('ffmpeg version 9.0-essentials_build');
    expect(result.ffprobeVersion).toBe('ffprobe version 9.0-essentials_build');
  });

  it('parses "whisper.cpp version: X.Y.Z" out of combined stdout/stderr', async () => {
    mockExecFile.mockImplementation(((cmd: string, args: any, options: any, cb: Function) => {
      if (cmd === 'whisper-cli') {
        cb(null, {
          stdout: 'whisper.cpp version: 1.9.2\n',
          stderr: 'load_backend: loaded CPU backend from ...\n',
        });
      } else {
        cb(new Error('ENOENT'));
      }
    }) as any);

    const result = await captureVideoDepsVersions();

    expect(result.whisperVersion).toBe('1.9.2');
  });

  it('leaves a field absent (not throwing) when a binary is not found', async () => {
    mockExecFile.mockImplementation(((cmd: string, args: any, options: any, cb: Function) => {
      cb(new Error('spawn ENOENT'));
    }) as any);

    const result = await captureVideoDepsVersions();

    expect(result.ffmpegVersion).toBeUndefined();
    expect(result.ffprobeVersion).toBeUndefined();
    expect(result.whisperVersion).toBeUndefined();
  });

  it('honors TRM_FFMPEG_PATH / TRM_FFPROBE_PATH / TRM_WHISPER_BIN overrides', async () => {
    process.env.TRM_FFMPEG_PATH = '/custom/ffmpeg';
    process.env.TRM_FFPROBE_PATH = '/custom/ffprobe';
    process.env.TRM_WHISPER_BIN = '/custom/whisper-cli';

    const calledCmds: string[] = [];
    mockExecFile.mockImplementation(((cmd: string, args: any, options: any, cb: Function) => {
      calledCmds.push(cmd);
      cb(new Error('ENOENT'));
    }) as any);

    await captureVideoDepsVersions();

    expect(calledCmds).toContain('/custom/ffmpeg');
    expect(calledCmds).toContain('/custom/ffprobe');
    expect(calledCmds).toContain('/custom/whisper-cli');
  });
});
