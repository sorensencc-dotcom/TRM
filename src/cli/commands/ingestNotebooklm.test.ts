import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pullAndStage } from './ingestNotebooklm';
import * as nlmCli from '../../notebooklm/nlmCli';
import { registryPath } from '../../notebooklm/registry';

jest.mock('../../notebooklm/nlmCli');

function seedRegistry(root: string): void {
  fs.writeFileSync(
    registryPath(root),
    JSON.stringify({
      version: 1,
      notebooks: [
        {
          notebook_id: 'nb-1',
          title: 'CIC-KB',
          url: 'https://notebooklm.google.com/notebook/nb-1',
          last_pulled_hashes: {},
          quarantined: {},
          last_ingested_at: null,
          last_mined_at: null,
          last_mined_answer_keys: [],
        },
      ],
    })
  );
}

describe('pullAndStage', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-nlmingest-'));
    seedRegistry(root);
    jest.resetAllMocks();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('stages a new source and a new note as physical files under intake/notebooklm/', () => {
    (nlmCli.listSources as jest.Mock).mockReturnValue({
      ok: true,
      data: [{ id: 'src-1', title: 'Willow Run Plant', type: 'web_page', url: 'https://example.com/a' }],
    });
    (nlmCli.getSourceContent as jest.Mock).mockReturnValue({ ok: true, data: 'Real source content.' });
    (nlmCli.listNotes as jest.Mock).mockReturnValue({
      ok: true,
      data: [{ id: 'note-1', title: 'Discovery', content: 'A curated finding.' }],
    });

    const staged = pullAndStage(root, 'nb-1', 'run-1');

    expect(staged).toHaveLength(2);
    const sourceItem = staged.find((s) => s.key === 'source:src-1')!;
    expect(fs.readFileSync(path.join(root, sourceItem.relativePath), 'utf-8')).toBe('Real source content.');
    expect(sourceItem.origin).toBe('notebooklm');

    const noteItem = staged.find((s) => s.key === 'note:note-1')!;
    expect(fs.readFileSync(path.join(root, noteItem.relativePath), 'utf-8')).toBe('A curated finding.');
  });

  it('marks a youtube-typed source as derived provenance with a marker line', () => {
    (nlmCli.listSources as jest.Mock).mockReturnValue({
      ok: true,
      data: [{ id: 'src-yt', title: 'Bomber Plant Footage', type: 'youtube', url: 'https://youtube.com/x' }],
    });
    (nlmCli.getSourceContent as jest.Mock).mockReturnValue({ ok: true, data: 'Derived summary text.' });
    (nlmCli.listNotes as jest.Mock).mockReturnValue({ ok: true, data: [] });

    const staged = pullAndStage(root, 'nb-1', 'run-1');

    expect(staged[0].origin).toBe('notebooklm-derived');
    const content = fs.readFileSync(path.join(root, staged[0].relativePath), 'utf-8');
    expect(content.split('\n')[0]).toBe('<!-- provenance: derived -->');
  });

  it('skips a source whose content hash is unchanged from the registry', () => {
    (nlmCli.listSources as jest.Mock).mockReturnValue({
      ok: true,
      data: [{ id: 'src-1', title: 'Willow Run Plant', type: 'web_page', url: 'https://example.com/a' }],
    });
    (nlmCli.getSourceContent as jest.Mock).mockReturnValue({ ok: true, data: 'Unchanged content.' });
    (nlmCli.listNotes as jest.Mock).mockReturnValue({ ok: true, data: [] });

    pullAndStage(root, 'nb-1', 'run-1');
    const secondRun = pullAndStage(root, 'nb-1', 'run-2');

    expect(secondRun).toHaveLength(0);
  });

  it('quarantines empty content instead of staging it, and does not re-log unchanged empty content', () => {
    (nlmCli.listSources as jest.Mock).mockReturnValue({
      ok: true,
      data: [{ id: 'src-empty', title: 'Empty Source', type: 'web_page', url: 'https://example.com/e' }],
    });
    (nlmCli.getSourceContent as jest.Mock).mockReturnValue({ ok: true, data: '' });
    (nlmCli.listNotes as jest.Mock).mockReturnValue({ ok: true, data: [] });

    const first = pullAndStage(root, 'nb-1', 'run-1');
    const second = pullAndStage(root, 'nb-1', 'run-2');

    expect(first).toHaveLength(0);
    expect(second).toHaveLength(0);
    expect(fs.existsSync(path.join(root, 'intake', 'notebooklm'))).toBe(false);
  });

  it('quarantines a source when getSourceContent returns an MCP-style error, without throwing', () => {
    (nlmCli.listSources as jest.Mock).mockReturnValue({
      ok: true,
      data: [{ id: 'src-bad', title: 'Broken', type: 'web_page', url: 'https://example.com/b' }],
    });
    (nlmCli.getSourceContent as jest.Mock).mockReturnValue({ ok: false, error: 'API error (code 5): NOT_FOUND' });
    (nlmCli.listNotes as jest.Mock).mockReturnValue({ ok: true, data: [] });

    expect(() => pullAndStage(root, 'nb-1', 'run-1')).not.toThrow();
    expect(pullAndStage(root, 'nb-1', 'run-1')).toHaveLength(0);
  });
});
