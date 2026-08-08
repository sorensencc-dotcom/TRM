import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCreate } from '../../src/cli/commands/create';
import { runIngest } from '../../src/cli/commands/ingest';
import { runExtract } from '../../src/cli/commands/extract';
import { stubRunner } from '../../src/extraction/stubRunner';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ default_scoring_adapter: 'stub', promotion_threshold: 80, actor_source: 'cli-only', time_source: 'system' }));
  return root;
}

describe('runExtract', () => {
  it('writes extract.json and summary.md from ingested source text', () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    runIngest(root, 'cuba', { actor: 'ACTOR-001', type: 'text', title: 'x', origin: 'x', url: 'x' });
    const rawDir = path.join(root, 'topics', 'cuba', 'sources', 'raw');
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(path.join(rawDir, 'SRC-001.json'), JSON.stringify({
      sourceId: 'SRC-001', kind: 'text', capturedAt: '2026-07-25T00:00:00.000Z', text: 'Fact one.\nFact two.\n',
    }));

    const result = runExtract(root, 'cuba', { actor: 'ACTOR-001' }, stubRunner);
    expect(result?.facts).toHaveLength(2);
    const extractPath = path.join(root, 'topics', 'cuba', 'extracts', 'extract.json');
    expect(JSON.parse(fs.readFileSync(extractPath, 'utf-8')).facts).toHaveLength(2);
    expect(fs.existsSync(path.join(root, 'topics', 'cuba', 'extracts', 'summary.md'))).toBe(true);
  });

  it('renumbers fact ids globally across multiple sources (no collisions)', () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    runIngest(root, 'cuba', { actor: 'ACTOR-001', type: 'text', title: 'a', origin: 'x', url: 'x' });
    runIngest(root, 'cuba', { actor: 'ACTOR-001', type: 'text', title: 'b', origin: 'x', url: 'x' });
    const rawDir = path.join(root, 'topics', 'cuba', 'sources', 'raw');
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(path.join(rawDir, 'SRC-001.json'), JSON.stringify({
      sourceId: 'SRC-001', kind: 'text', capturedAt: '2026-07-25T00:00:00.000Z', text: 'Fact one.\nFact two.\n',
    }));
    fs.writeFileSync(path.join(rawDir, 'SRC-002.json'), JSON.stringify({
      sourceId: 'SRC-002', kind: 'text', capturedAt: '2026-07-25T00:00:00.000Z', text: 'Fact three.\nFact four.\n',
    }));

    const result = runExtract(root, 'cuba', { actor: 'ACTOR-001' }, stubRunner);
    expect(result?.facts).toHaveLength(4);
    const ids = result?.facts.map((f) => f.id);
    expect(ids).toEqual(['FCT-001', 'FCT-002', 'FCT-003', 'FCT-004']);
    expect(new Set(ids).size).toBe(4);
    expect(result?.facts[2].source_id).toBe('SRC-002');
  });

  it('dry-run writes nothing', () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    runIngest(root, 'cuba', { actor: 'ACTOR-001', type: 'text', title: 'x', origin: 'x', url: 'x' });
    const rawDir = path.join(root, 'topics', 'cuba', 'sources', 'raw');
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(path.join(rawDir, 'SRC-001.json'), JSON.stringify({
      sourceId: 'SRC-001', kind: 'text', capturedAt: '2026-07-25T00:00:00.000Z', text: 'Fact one.\n',
    }));

    const result = runExtract(root, 'cuba', { actor: 'ACTOR-001', dryRun: true }, stubRunner);
    expect(result).toBeNull();
    expect(fs.existsSync(path.join(root, 'topics', 'cuba', 'extracts', 'extract.json'))).toBe(false);
  });

  it('skips image-kind sources with a logged reason instead of silently dropping them', () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    runIngest(root, 'cuba', { actor: 'ACTOR-001', type: 'image', title: 'photo', origin: 'x', url: 'x' });
    const rawDir = path.join(root, 'topics', 'cuba', 'sources', 'raw');
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(path.join(rawDir, 'SRC-001.json'), JSON.stringify({
      sourceId: 'SRC-001',
      kind: 'image',
      capturedAt: '2026-07-25T00:00:00.000Z',
      image: { matches: [], metadata: { format: 'png', size: 1, processedAt: '2026-07-25T00:00:00.000Z', visionApiUsed: false }, mock: true },
    }));

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = runExtract(root, 'cuba', { actor: 'ACTOR-001' }, stubRunner);

    expect(result?.facts).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('SRC-001'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no text content'));

    warnSpy.mockRestore();
  });

  it('does NOT skip video-kind sources; passes video text to runner.run()', () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    runIngest(root, 'cuba', { actor: 'ACTOR-001', type: 'video', title: 'interview', origin: 'archive.org', url: 'x' });
    const rawDir = path.join(root, 'topics', 'cuba', 'sources', 'raw');
    fs.mkdirSync(rawDir, { recursive: true });

    const videoTranscript = 'Speaker A: This is an important statement.\nSpeaker B: And this is a response.\n';
    fs.writeFileSync(path.join(rawDir, 'SRC-001.json'), JSON.stringify({
      sourceId: 'SRC-001',
      kind: 'video',
      capturedAt: '2026-07-25T00:00:00.000Z',
      text: videoTranscript,
      frames: [],
    }));

    // Mock runner to track calls
    const mockRunner = {
      run: jest.fn((source: any, rawText: string) => {
        const lines = rawText.split('\n').map((l: string) => l.trim()).filter(Boolean);
        return {
          facts: lines.map((text: string, i: number) => ({
            id: `FCT-${String(i + 1).padStart(3, '0')}`,
            text,
            source_id: source.id,
            confidence: 0.9,
            categories: ['video-transcript'] as string[],
          })),
          summary: `Extracted ${lines.length} fact(s) from video: ${source.title}.`,
        };
      }),
    };

    const result = runExtract(root, 'cuba', { actor: 'ACTOR-001' }, mockRunner);

    // Assert runner was called with the video source
    expect(mockRunner.run).toHaveBeenCalled();
    expect(mockRunner.run).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'SRC-001', title: 'interview' }),
      videoTranscript
    );

    // Assert facts from video were extracted
    expect(result?.facts).toHaveLength(2);
    expect(result?.facts[0]?.text).toBe('Speaker A: This is an important statement.');
    expect(result?.facts[1]?.text).toBe('Speaker B: And this is a response.');
    expect(result?.summary).toContain('2 fact(s) from video');
  });
});
