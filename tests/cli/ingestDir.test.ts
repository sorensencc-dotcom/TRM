import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCreate } from '../../src/cli/commands/create';
import { runIngestDir } from '../../src/cli/commands/ingestDir';
import * as manifestStore from '../../src/core/manifestStore';
import * as failedStore from '../../src/core/failedStore';
import { hashFile } from '../../src/core/contentHash';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-ingestdir-'));
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({
      default_scoring_adapter: 'stub',
      promotion_threshold: 80,
      actor_source: 'cli-only',
      time_source: 'system',
    })
  );
  return root;
}

const FIXTURES_DIR = path.join(__dirname, '../../src/ingestion/imageExtract/fixtures');
const TEXT_DOC_FIXTURE = path.join(FIXTURES_DIR, 'text-doc-valid-scanned-page.png');
const PHOTO_FIXTURE = path.join(FIXTURES_DIR, 'photo-valid-landscape.png');

describe('runIngestDir', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/analyze/ocr')) {
        return {
          ok: true,
          json: async () => ({
            text: 'Scanned doc page with historical records.',
            metadata: {
              format: 'png',
              size: 59,
              processedAt: new Date().toISOString(),
              latencyMs: 15,
            },
          }),
        };
      }
      if (url.includes('/api/analyze/image')) {
        return {
          ok: true,
          json: async () => ({
            matches: [
              { url: 'https://example.com/landscape.jpg', similarity: 90, source: 'vision_search' },
            ],
            metadata: {
              format: 'png',
              size: 59,
              processedAt: new Date().toISOString(),
              visionApiUsed: true,
              latencyMs: 25,
              apiProvider: 'google_vision',
            },
          }),
        };
      }
      return { ok: false, status: 404, text: async () => 'Not found' };
    }) as any;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('fresh directory ingest processes all files', async () => {
    const root = makeRoot();
    runCreate(root, 'topic1', { actor: 'ACTOR-001' });

    const dir = path.join(root, 'input-dir');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'doc1.txt'), 'Content for doc 1', 'utf-8');
    fs.writeFileSync(path.join(dir, 'doc2.txt'), 'Content for doc 2', 'utf-8');

    const summary = await runIngestDir(
      root,
      'topic1',
      { actor: 'ACTOR-001', dir, stub: true }
    );

    expect(summary.totalFiles).toBe(2);
    expect(summary.successCount).toBe(2);
    expect(summary.duplicateCount).toBe(0);
    expect(summary.failureCount).toBe(0);
  });

  it('re-running skips duplicates and logs/counts them', async () => {
    const root = makeRoot();
    runCreate(root, 'topic1', { actor: 'ACTOR-001' });

    const dir = path.join(root, 'input-dir');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'doc1.txt'), 'Same content for dedup test', 'utf-8');

    const firstRun = await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true });
    expect(firstRun.successCount).toBe(1);
    expect(firstRun.duplicateCount).toBe(0);

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    const secondRun = await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true });
    consoleSpy.mockRestore();

    expect(secondRun.successCount).toBe(0);
    expect(secondRun.duplicateCount).toBe(1);
  });

  it('--force reprocesses already ingested files', async () => {
    const root = makeRoot();
    runCreate(root, 'topic1', { actor: 'ACTOR-001' });

    const dir = path.join(root, 'input-dir');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'doc1.txt'), 'Content for force test', 'utf-8');

    await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true });

    const forcedRun = await runIngestDir(
      root,
      'topic1',
      { actor: 'ACTOR-001', dir, force: true, stub: true }
    );

    expect(forcedRun.successCount).toBe(1);
    expect(forcedRun.duplicateCount).toBe(0);
  });

  it('a text-doc-shaped fixture produces non-empty facts', async () => {
    const root = makeRoot();
    runCreate(root, 'topic1', { actor: 'ACTOR-001' });

    const dir = path.join(root, 'input-dir');
    fs.mkdirSync(dir);

    const docPhotoPath = path.join(dir, 'scanned.png');
    fs.copyFileSync(TEXT_DOC_FIXTURE, docPhotoPath);

    const summary = await runIngestDir(
      root,
      'topic1',
      { actor: 'ACTOR-001', dir, kind: 'text-doc', stub: true }
    );

    expect(summary.successCount).toBe(1);

    const hash = await hashFile(docPhotoPath);
    const extractPayload = manifestStore.readExtract<{ facts: any[]; summary: string }>(
      root,
      'topic1',
      hash
    );

    expect(extractPayload).not.toBeNull();
    expect(extractPayload?.facts.length).toBeGreaterThan(0);
    expect(extractPayload?.summary).toBeTruthy();
  });

  it('a photo-shaped fixture produces zero facts but a stored vision-analysis result', async () => {
    const root = makeRoot();
    runCreate(root, 'topic1', { actor: 'ACTOR-001' });

    const dir = path.join(root, 'input-dir');
    fs.mkdirSync(dir);

    const photoPath = path.join(dir, 'landscape.png');
    fs.copyFileSync(PHOTO_FIXTURE, photoPath);

    const summary = await runIngestDir(
      root,
      'topic1',
      { actor: 'ACTOR-001', dir, kind: 'photo', stub: true }
    );

    expect(summary.successCount).toBe(1);

    const hash = await hashFile(photoPath);
    const extractPayload = manifestStore.readExtract<{ facts: any[]; summary: string }>(
      root,
      'topic1',
      hash
    );

    expect(extractPayload).not.toBeNull();
    expect(extractPayload?.facts).toEqual([]);
  });

  it('a failing file does not abort the batch and appears in failed.json', async () => {
    const root = makeRoot();
    runCreate(root, 'topic1', { actor: 'ACTOR-001' });

    const dir = path.join(root, 'input-dir');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'good.txt'), 'Good text file', 'utf-8');
    fs.writeFileSync(path.join(dir, 'bad.png'), 'corrupt png data', 'utf-8');

    // Force OCR endpoint to fail for bad.png
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/analyze/ocr')) {
        return {
          ok: false,
          status: 500,
          text: async () => 'OCR engine failure',
        };
      }
      return { ok: true, json: async () => ({ text: 'ok', metadata: {} }) };
    }) as any;

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    const summary = await runIngestDir(
      root,
      'topic1',
      { actor: 'ACTOR-001', dir, kind: 'text-doc', stub: true }
    );
    consoleSpy.mockRestore();

    expect(summary.totalFiles).toBe(2);
    expect(summary.successCount).toBe(1);
    expect(summary.failureCount).toBe(1);

    const failed = failedStore.readFailed(root, 'topic1');
    expect(failed.length).toBe(1);
    expect(failed[0].sourcePath).toContain('bad.png');
  });

  it('--retry-failed reprocesses only failed items', async () => {
    const root = makeRoot();
    runCreate(root, 'topic1', { actor: 'ACTOR-001' });

    const dir = path.join(root, 'input-dir');
    fs.mkdirSync(dir);
    const badPath = path.join(dir, 'bad.png');
    fs.writeFileSync(badPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    // First run fails OCR
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/analyze/ocr')) {
        return {
          ok: false,
          status: 500,
          text: async () => 'OCR internal error',
        };
      }
      return { ok: true, json: async () => ({ text: 'ok', metadata: {} }) };
    }) as any;

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, kind: 'text-doc', stub: true });
    consoleSpy.mockRestore();

    expect(failedStore.readFailed(root, 'topic1').length).toBe(1);

    // Fix OCR service behavior
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('/api/analyze/ocr')) {
        return {
          ok: true,
          json: async () => ({
            text: 'Recovered OCR text after fix',
            metadata: { format: 'png', size: 16, processedAt: new Date().toISOString(), latencyMs: 10 },
          }),
        };
      }
      return { ok: true, json: async () => ({ text: 'ok', metadata: {} }) };
    }) as any;

    // Retry failed items
    const retrySummary = await runIngestDir(
      root,
      'topic1',
      { actor: 'ACTOR-001', dir, kind: 'text-doc', retryFailed: true, stub: true }
    );

    expect(retrySummary.totalFiles).toBe(1);
    expect(retrySummary.successCount).toBe(1);
    expect(retrySummary.failureCount).toBe(0);

    // failedStore should now be empty
    expect(failedStore.readFailed(root, 'topic1')).toEqual([]);
  });
});
