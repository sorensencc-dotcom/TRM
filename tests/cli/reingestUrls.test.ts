// C:\dev\trm\tests\cli\reingestUrls.test.ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCreate } from '../../src/cli/commands/create';
import { runIngest } from '../../src/cli/commands/ingest';
import { runReingestUrls } from '../../src/cli/commands/reingestUrls';
import { readRawEnvelope } from '../../src/core/rawSource';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-reingest-'));
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({ default_scoring_adapter: 'stub', promotion_threshold: 80, actor_source: 'cli-only', time_source: 'system' })
  );
  return root;
}

describe('reingestUrls', () => {
  it('fetches and creates raw envelope when URL source is ingested via trm ingest', async () => {
    const root = makeRoot();
    runCreate(root, 'fcsc', { actor: 'ACTOR-001' });

    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => 'text/html' },
      text: async () => '<html><body><h1>FCSC Decision</h1><p>Claim CU-001 granted.</p></body></html>',
    });

    const entry = await runIngest(
      root,
      'fcsc',
      {
        actor: 'ACTOR-001',
        type: 'web',
        title: 'FCSC Cuba Decision',
        origin: 'DOJ',
        url: 'https://www.justice.gov/fcsc/cuba-cu-001',
      },
      { fetchFn: mockFetch as any }
    );

    expect(entry?.id).toBe('SRC-001');
    const raw = readRawEnvelope(root, 'fcsc', 'SRC-001');
    expect(raw).not.toBeNull();
    expect(raw?.kind).toBe('text');
    expect(raw?.text).toContain('FCSC Decision');
    expect(raw?.text).toContain('Claim CU-001 granted.');
  });

  it('backfills missing URL envelopes across topics without overwriting existing envelopes', async () => {
    const root = makeRoot();
    runCreate(root, 'cuba/fcsc', { actor: 'ACTOR-001' });

    const dir = path.join(root, 'topics', 'cuba', 'fcsc');
    const sourcesDir = path.join(dir, 'sources');
    fs.mkdirSync(sourcesDir, { recursive: true });

    // Seed metadata with 1 note (with raw) and 2 URLs (without raw)
    const metadata = {
      sources: [
        { id: 'SRC-001', type: 'note', title: 'NotebookLM Note', origin: 'NLM', url: 'local:note.txt' },
        { id: 'SRC-002', type: 'web', title: 'DOJ Archive', origin: 'DOJ', url: 'https://www.justice.gov/fcsc/doc1' },
        { id: 'SRC-003', type: 'web', title: 'Wikipedia', origin: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/FCSC' },
      ],
    };
    fs.writeFileSync(path.join(sourcesDir, 'metadata.json'), JSON.stringify(metadata, null, 2));

    // Create existing envelope for SRC-001
    const rawDir = path.join(sourcesDir, 'raw');
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(
      path.join(rawDir, 'SRC-001.json'),
      JSON.stringify({ sourceId: 'SRC-001', kind: 'text', capturedAt: '2026-09-01T00:00:00Z', text: 'Existing note text.' })
    );

    const mockFetch = jest.fn().mockImplementation(async (url: string) => {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => 'text/html' },
        text: async () => `<html><body><h1>Content for ${url}</h1></body></html>`,
      };
    });

    const result = await runReingestUrls(root, 'cuba/fcsc', {}, { fetchFn: mockFetch as any });

    expect(result.topicsProcessed).toBe(1);
    expect(result.urlsFound).toBe(2);
    expect(result.urlsIngested).toBe(2);
    expect(result.failures).toHaveLength(0);

    // Verify existing SRC-001 is preserved
    const raw1 = readRawEnvelope(root, 'cuba/fcsc', 'SRC-001');
    expect(raw1?.text).toBe('Existing note text.');

    // Verify missing envelopes are populated
    const raw2 = readRawEnvelope(root, 'cuba/fcsc', 'SRC-002');
    expect(raw2?.text).toContain('Content for https://www.justice.gov/fcsc/doc1');

    const raw3 = readRawEnvelope(root, 'cuba/fcsc', 'SRC-003');
    expect(raw3?.text).toContain('Content for https://en.wikipedia.org/wiki/FCSC');
  });

  it('respects dry-run option', async () => {
    const root = makeRoot();
    runCreate(root, 'cuba/fcsc', { actor: 'ACTOR-001' });

    const dir = path.join(root, 'topics', 'cuba', 'fcsc');
    const sourcesDir = path.join(dir, 'sources');
    fs.mkdirSync(sourcesDir, { recursive: true });

    const metadata = {
      sources: [
        { id: 'SRC-001', type: 'web', title: 'DOJ Archive', origin: 'DOJ', url: 'https://www.justice.gov/fcsc/doc1' },
      ],
    };
    fs.writeFileSync(path.join(sourcesDir, 'metadata.json'), JSON.stringify(metadata, null, 2));

    const result = await runReingestUrls(root, 'cuba/fcsc', { dryRun: true });
    expect(result.urlsFound).toBe(1);
    expect(result.urlsIngested).toBe(1);

    const raw = readRawEnvelope(root, 'cuba/fcsc', 'SRC-001');
    expect(raw).toBeNull();
  });
});
