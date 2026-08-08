import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendVideoMetrics, readVideoMetrics } from '../../src/core/videoMetricsLog';

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trm-videometrics-'));
}

describe('videoMetricsLog', () => {
  it('returns an empty array when no log file exists yet', () => {
    const root = makeRoot();
    expect(readVideoMetrics(root)).toEqual([]);
  });

  it('appends and reads back entries in order', () => {
    const root = makeRoot();
    const success = {
      schema_version: 1 as const,
      topic: 'charlie/benson-ford',
      file: 'a.mp4',
      outcome: 'success' as const,
      ms: 4200,
      ts: '2026-08-08T00:00:00.000Z',
      durationMs: 60000,
      hasAudioStream: true,
      frameCount: 6,
      transcriptStatus: 'transcribed' as const,
      visionFailureCount: 0,
    };
    const failure = {
      schema_version: 1 as const,
      topic: 'charlie/benson-ford',
      file: 'b.mp4',
      outcome: 'failure' as const,
      ms: 1500,
      ts: '2026-08-08T00:01:00.000Z',
      error: 'ffmpeg produced no frames',
    };
    appendVideoMetrics(root, success);
    appendVideoMetrics(root, failure);

    expect(readVideoMetrics(root)).toEqual([success, failure]);
  });
});
