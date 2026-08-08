describe('concurrency', () => {
  const ENV_KEYS = ['TRM_VISION_CONCURRENCY', 'TRM_CLAUDE_CONCURRENCY', 'TRM_DOC_CONCURRENCY', 'TRM_FFMPEG_CONCURRENCY'];
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
    jest.resetModules();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  async function trackConcurrency(pool: (fn: () => Promise<void>) => Promise<void>, taskCount: number) {
    let active = 0;
    let maxActive = 0;
    const tasks = Array.from({ length: taskCount }, () =>
      pool(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
      })
    );
    await Promise.all(tasks);
    return maxActive;
  }

  it('defaults to a concurrency of 4 when no env var is set', async () => {
    delete process.env.TRM_VISION_CONCURRENCY;
    delete process.env.TRM_CLAUDE_CONCURRENCY;
    const { visionPool } = require('../../src/core/concurrency');

    const maxActive = await trackConcurrency(visionPool, 10);
    expect(maxActive).toBe(4);
  });

  it('bounds concurrent execution to the configured TRM_VISION_CONCURRENCY limit', async () => {
    process.env.TRM_VISION_CONCURRENCY = '2';
    const { visionPool } = require('../../src/core/concurrency');

    const maxActive = await trackConcurrency(visionPool, 10);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBeGreaterThan(0);
  });

  it('visionPool and claudePool have independently configurable limits', async () => {
    process.env.TRM_VISION_CONCURRENCY = '1';
    process.env.TRM_CLAUDE_CONCURRENCY = '5';
    const { visionPool, claudePool } = require('../../src/core/concurrency');

    const [visionMax, claudeMax] = await Promise.all([
      trackConcurrency(visionPool, 8),
      trackConcurrency(claudePool, 8),
    ]);

    expect(visionMax).toBe(1);
    expect(claudeMax).toBe(5);
  });

  it('falls back to the default for a non-positive-integer env value', async () => {
    process.env.TRM_VISION_CONCURRENCY = 'not-a-number';
    const { visionPool } = require('../../src/core/concurrency');

    const maxActive = await trackConcurrency(visionPool, 10);
    expect(maxActive).toBe(4);
  });

  it('docPool defaults to a concurrency of 4 when no env var is set', async () => {
    delete process.env.TRM_DOC_CONCURRENCY;
    const { docPool } = require('../../src/core/concurrency');

    const maxActive = await trackConcurrency(docPool, 10);
    expect(maxActive).toBe(4);
  });

  it('bounds concurrent execution to the configured TRM_DOC_CONCURRENCY limit', async () => {
    process.env.TRM_DOC_CONCURRENCY = '2';
    const { docPool } = require('../../src/core/concurrency');

    const maxActive = await trackConcurrency(docPool, 10);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBeGreaterThan(0);
  });

  it('ffmpegPool defaults to a concurrency of 2 when no env var is set (own default, not the shared 4)', async () => {
    delete process.env.TRM_FFMPEG_CONCURRENCY;
    const { ffmpegPool } = require('../../src/core/concurrency');

    const maxActive = await trackConcurrency(ffmpegPool, 10);
    expect(maxActive).toBe(2);
  });

  it('bounds concurrent execution to the configured TRM_FFMPEG_CONCURRENCY limit', async () => {
    process.env.TRM_FFMPEG_CONCURRENCY = '3';
    const { ffmpegPool } = require('../../src/core/concurrency');

    const maxActive = await trackConcurrency(ffmpegPool, 10);
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(maxActive).toBeGreaterThan(0);
  });
});
