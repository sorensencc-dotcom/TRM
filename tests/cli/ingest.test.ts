import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCreate } from '../../src/cli/commands/create';
import { runIngest } from '../../src/cli/commands/ingest';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ default_scoring_adapter: 'stub', promotion_threshold: 80, actor_source: 'cli-only', time_source: 'system' }));
  return root;
}

describe('runIngest', () => {
  it('ingests a source and marks the node active', async () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    const entry = await runIngest(root, 'cuba', { actor: 'ACTOR-001', type: 'pdf', title: 'Overview', origin: 'LOC', url: 'x' });
    expect(entry?.id).toBe('SRC-001');
  });

  it('dry-run writes nothing', async () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    const entry = await runIngest(root, 'cuba', { actor: 'ACTOR-001', type: 'pdf', title: 'Overview', origin: 'LOC', url: 'x', dryRun: true });
    expect(entry).toBeNull();
    const metadataPath = path.join(root, 'topics', 'cuba', 'sources', 'metadata.json');
    expect(fs.existsSync(metadataPath)).toBe(false);
  });

  it('with --file and no url, writes the converted text to sources/raw/SRC-001.txt and derives a local: url', async () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    const filePath = path.join(root, 'doc.txt');
    fs.writeFileSync(filePath, 'Converted file content.', 'utf-8');

    const entry = await runIngest(root, 'cuba', { actor: 'ACTOR-001', type: 'pdf', title: 'Overview', origin: 'LOC', file: filePath });

    expect(entry?.url).toBe('local:doc.txt');
    const rawPath = path.join(root, 'topics', 'cuba', 'sources', 'raw', 'SRC-001.txt');
    expect(fs.existsSync(rawPath)).toBe(true);
    expect(fs.readFileSync(rawPath, 'utf-8')).toBe('Converted file content.');
  });

  it('with --file AND an explicit url, the explicit url wins', async () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    const filePath = path.join(root, 'doc.txt');
    fs.writeFileSync(filePath, 'Content.', 'utf-8');

    const entry = await runIngest(root, 'cuba', { actor: 'ACTOR-001', type: 'pdf', title: 'Overview', origin: 'LOC', url: 'https://example.com/real', file: filePath });

    expect(entry?.url).toBe('https://example.com/real');
  });

  it('throws when neither url nor file is provided', async () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    await expect(
      runIngest(root, 'cuba', { actor: 'ACTOR-001', type: 'pdf', title: 'Overview', origin: 'LOC' })
    ).rejects.toThrow(/either.*url.*--file/i);
  });

  it('dry-run with --file writes nothing (no raw file, no metadata)', async () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    const filePath = path.join(root, 'doc.txt');
    fs.writeFileSync(filePath, 'Content.', 'utf-8');

    const entry = await runIngest(root, 'cuba', { actor: 'ACTOR-001', type: 'pdf', title: 'Overview', origin: 'LOC', file: filePath, dryRun: true });

    expect(entry).toBeNull();
    expect(fs.existsSync(path.join(root, 'topics', 'cuba', 'sources', 'metadata.json'))).toBe(false);
  });
});
