import { execFile } from 'node:child_process';
import { probeVideo, ProbeResult } from '../../src/core/videoProbe';

jest.mock('node:child_process');

const mockExecFile = execFile as jest.MockedFunction<typeof execFile>;

describe('videoProbe', () => {
  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.TRM_FFPROBE_PATH;
  });

  describe('probeVideo', () => {
    it('returns duration in milliseconds and audio stream presence for valid video', async () => {
      const mockOutput = JSON.stringify({
        format: {
          duration: '123.456'
        },
        streams: [
          { codec_type: 'video', width: 1920, height: 1080 },
          { codec_type: 'audio', channels: 2 }
        ]
      });

      mockExecFile.mockImplementation(
        ((cmd: string, args: any, options: any, cb: Function) => {
          cb(null, { stdout: mockOutput });
        }) as any
      );

      const result = await probeVideo('/path/to/video.mp4');

      expect(result).toEqual({
        durationMs: 123456,
        hasAudioStream: true
      });
    });

    it('invokes ffprobe exactly once per call', async () => {
      const mockOutput = JSON.stringify({
        format: { duration: '10.5' },
        streams: [{ codec_type: 'video' }]
      });

      mockExecFile.mockImplementation(
        ((cmd: string, args: any, options: any, cb: Function) => {
          cb(null, { stdout: mockOutput });
        }) as any
      );

      await probeVideo('/path/to/video.mp4');

      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it('uses TRM_FFPROBE_PATH env var when set', async () => {
      process.env.TRM_FFPROBE_PATH = '/custom/ffprobe';

      const mockOutput = JSON.stringify({
        format: { duration: '10.0' },
        streams: []
      });

      mockExecFile.mockImplementation(
        ((cmd: string, args: any, options: any, cb: Function) => {
          if (cmd === '/custom/ffprobe') {
            cb(null, { stdout: mockOutput });
          }
        }) as any
      );

      await probeVideo('/path/to/video.mp4');

      const callArgs = mockExecFile.mock.calls[0];
      expect(callArgs[0]).toBe('/custom/ffprobe');
    });

    it('defaults to ffprobe from PATH when env var not set', async () => {
      const mockOutput = JSON.stringify({
        format: { duration: '10.0' },
        streams: []
      });

      mockExecFile.mockImplementation(
        ((cmd: string, args: any, options: any, cb: Function) => {
          if (cmd === 'ffprobe') {
            cb(null, { stdout: mockOutput });
          }
        }) as any
      );

      await probeVideo('/path/to/video.mp4');

      const callArgs = mockExecFile.mock.calls[0];
      expect(callArgs[0]).toBe('ffprobe');
    });

    it('passes 10s timeout to ffprobe', async () => {
      const mockOutput = JSON.stringify({
        format: { duration: '10.0' },
        streams: []
      });

      mockExecFile.mockImplementation(
        ((cmd: string, args: any, options: any, cb: Function) => {
          cb(null, { stdout: mockOutput });
        }) as any
      );

      await probeVideo('/path/to/video.mp4');

      const callArgs = mockExecFile.mock.calls[0];
      expect(callArgs[2]).toEqual({ timeout: 10000 });
    });

    it('passes correct ffprobe arguments', async () => {
      const mockOutput = JSON.stringify({
        format: { duration: '10.0' },
        streams: []
      });

      mockExecFile.mockImplementation(
        ((cmd: string, args: any, options: any, cb: Function) => {
          cb(null, { stdout: mockOutput });
        }) as any
      );

      const testFilePath = '/path/to/test.mp4';
      await probeVideo(testFilePath);

      const callArgs = mockExecFile.mock.calls[0];
      expect(callArgs[1]).toEqual([
        '-v', 'error',
        '-show_entries', 'format=duration:stream=codec_type',
        '-of', 'json',
        testFilePath
      ]);
    });

    it('returns hasAudioStream false when no audio stream exists', async () => {
      const mockOutput = JSON.stringify({
        format: { duration: '50.0' },
        streams: [
          { codec_type: 'video', width: 1920 }
        ]
      });

      mockExecFile.mockImplementation(
        ((cmd: string, args: any, options: any, cb: Function) => {
          cb(null, { stdout: mockOutput });
        }) as any
      );

      const result = await probeVideo('/path/to/silent_video.mp4');

      expect(result.hasAudioStream).toBe(false);
    });

    it('returns hasAudioStream true when multiple audio streams exist', async () => {
      const mockOutput = JSON.stringify({
        format: { duration: '100.0' },
        streams: [
          { codec_type: 'video' },
          { codec_type: 'audio', language: 'eng' },
          { codec_type: 'audio', language: 'spa' },
          { codec_type: 'subtitle' }
        ]
      });

      mockExecFile.mockImplementation(
        ((cmd: string, args: any, options: any, cb: Function) => {
          cb(null, { stdout: mockOutput });
        }) as any
      );

      const result = await probeVideo('/path/to/multi_audio.mp4');

      expect(result.hasAudioStream).toBe(true);
    });

    it('rounds duration to nearest millisecond', async () => {
      const mockOutput = JSON.stringify({
        format: { duration: '10.4995' },
        streams: []
      });

      mockExecFile.mockImplementation(
        ((cmd: string, args: any, options: any, cb: Function) => {
          cb(null, { stdout: mockOutput });
        }) as any
      );

      const result = await probeVideo('/path/to/video.mp4');

      expect(result.durationMs).toBe(10500);
    });

    it('throws error when ffprobe times out', async () => {
      const timeoutError = new Error('Timeout');
      (timeoutError as any).code = 'ETIMEDOUT';

      mockExecFile.mockImplementation(
        ((cmd: string, args: any, options: any, cb: Function) => {
          cb(timeoutError);
        }) as any
      );

      await expect(probeVideo('/path/to/video.mp4')).rejects.toThrow(
        /Failed to probe video file.*Timeout/
      );
    });

    it('throws error when ffprobe returns non-zero exit code', async () => {
      const exitError = new Error('Command failed');
      (exitError as any).code = 1;
      (exitError as any).stderr = 'file not found';

      mockExecFile.mockImplementation(
        ((cmd: string, args: any, options: any, cb: Function) => {
          cb(exitError);
        }) as any
      );

      await expect(probeVideo('/path/to/missing.mp4')).rejects.toThrow(
        /Failed to probe video file.*file not found/
      );
    });

    it('throws error when JSON output is invalid', async () => {
      mockExecFile.mockImplementation(
        ((cmd: string, args: any, options: any, cb: Function) => {
          cb(null, { stdout: 'not valid json {' });
        }) as any
      );

      await expect(probeVideo('/path/to/video.mp4')).rejects.toThrow(
        /Failed to parse ffprobe JSON output/
      );
    });

    it('throws error when ffprobe output is missing format.duration', async () => {
      const mockOutput = JSON.stringify({
        format: {},
        streams: []
      });

      mockExecFile.mockImplementation(
        ((cmd: string, args: any, options: any, cb: Function) => {
          cb(null, { stdout: mockOutput });
        }) as any
      );

      await expect(probeVideo('/path/to/video.mp4')).rejects.toThrow(
        /Invalid ffprobe output.*format.duration is missing/
      );
    });

    it('throws error when format.duration is not a valid number', async () => {
      const mockOutput = JSON.stringify({
        format: { duration: 'invalid' },
        streams: []
      });

      mockExecFile.mockImplementation(
        ((cmd: string, args: any, options: any, cb: Function) => {
          cb(null, { stdout: mockOutput });
        }) as any
      );

      await expect(probeVideo('/path/to/video.mp4')).rejects.toThrow(
        /Invalid ffprobe output.*format.duration is not a valid number/
      );
    });

    it('throws error when format.duration is wrong type (boolean)', async () => {
      const mockOutput = JSON.stringify({
        format: { duration: true },
        streams: []
      });

      mockExecFile.mockImplementation(
        ((cmd: string, args: any, options: any, cb: Function) => {
          cb(null, { stdout: mockOutput });
        }) as any
      );

      await expect(probeVideo('/path/to/video.mp4')).rejects.toThrow(
        /Invalid ffprobe output.*format.duration is not a number or string/
      );
    });

    it('throws error when ffprobe output is not an object', async () => {
      mockExecFile.mockImplementation(
        ((cmd: string, args: any, options: any, cb: Function) => {
          cb(null, { stdout: JSON.stringify('not an object') });
        }) as any
      );

      await expect(probeVideo('/path/to/video.mp4')).rejects.toThrow(
        /Invalid ffprobe output.*expected object/
      );
    });

    it('throws error when streams is not an array', async () => {
      const mockOutput = JSON.stringify({
        format: { duration: '10.0' },
        streams: 'not an array'
      });

      mockExecFile.mockImplementation(
        ((cmd: string, args: any, options: any, cb: Function) => {
          cb(null, { stdout: mockOutput });
        }) as any
      );

      await expect(probeVideo('/path/to/video.mp4')).rejects.toThrow(
        /Invalid ffprobe output.*streams is not an array/
      );
    });

    it('handles missing streams array gracefully', async () => {
      const mockOutput = JSON.stringify({
        format: { duration: '10.0' }
      });

      mockExecFile.mockImplementation(
        ((cmd: string, args: any, options: any, cb: Function) => {
          cb(null, { stdout: mockOutput });
        }) as any
      );

      const result = await probeVideo('/path/to/video.mp4');

      expect(result).toEqual({
        durationMs: 10000,
        hasAudioStream: false
      });
    });

    it('includes stderr in error message when available', async () => {
      const error = new Error('Command failed');
      (error as any).stderr = 'ffprobe: input file too large';

      mockExecFile.mockImplementation(
        ((cmd: string, args: any, options: any, cb: Function) => {
          cb(error);
        }) as any
      );

      await expect(probeVideo('/path/to/video.mp4')).rejects.toThrow(
        /Failed to probe video file.*ffprobe: input file too large/
      );
    });

    it('includes error message when stderr unavailable', async () => {
      const error = new Error('generic error message');

      mockExecFile.mockImplementation(
        ((cmd: string, args: any, options: any, cb: Function) => {
          cb(error);
        }) as any
      );

      await expect(probeVideo('/path/to/video.mp4')).rejects.toThrow(
        /Failed to probe video file.*generic error message/
      );
    });

    it('handles corrupt video file (simulated via ffprobe error)', async () => {
      const error = new Error('Demuxer not found');
      (error as any).stderr = 'Unknown format or corrupted file';

      mockExecFile.mockImplementation(
        ((cmd: string, args: any, options: any, cb: Function) => {
          cb(error);
        }) as any
      );

      await expect(probeVideo('/path/to/corrupt.mp4')).rejects.toThrow(
        /Failed to probe video file.*Unknown format or corrupted file/
      );
    });

    it('handles 10s timeout scenario', async () => {
      const timeoutError = new Error('Killed');
      (timeoutError as any).code = 'ETIMEDOUT';
      (timeoutError as any).killed = true;

      mockExecFile.mockImplementation(
        ((cmd: string, args: any, options: any, cb: Function) => {
          cb(timeoutError);
        }) as any
      );

      await expect(probeVideo('/path/to/huge_video.mp4')).rejects.toThrow();
    });
  });
});
