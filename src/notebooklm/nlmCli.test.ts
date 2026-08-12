import { listSources, getSourceContent, listNotes, queryNotebook } from './nlmCli';
import * as childProcess from 'node:child_process';

jest.mock('node:child_process');
const mockSpawnSync = childProcess.spawnSync as jest.Mock;

describe('nlmCli', () => {
  afterEach(() => jest.resetAllMocks());

  it('listSources parses a successful --json array', () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify([
        { id: 'src-1', title: 'memcode-ai/memcode', type: 'web_page', url: 'https://github.com/memcode-ai/memcode' },
        { id: 'src-2', title: 'repo_knowledge_pack.txt', type: 'generated_text', url: null },
      ]),
      stderr: '',
    });

    const result = listSources('nb-1');

    expect(result).toEqual({
      ok: true,
      data: [
        { id: 'src-1', title: 'memcode-ai/memcode', type: 'web_page', url: 'https://github.com/memcode-ai/memcode' },
        { id: 'src-2', title: 'repo_knowledge_pack.txt', type: 'generated_text', url: null },
      ],
    });
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'nlm',
      ['source', 'list', 'nb-1', '--json', '--skip-freshness'],
      expect.objectContaining({ encoding: 'utf-8' })
    );
  });

  it('getSourceContent returns ok:false on a non-zero exit with an error payload', () => {
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: JSON.stringify({ status: 'error', error: 'API error (code 5): NOT_FOUND' }),
      stderr: '',
    });

    const result = getSourceContent('bad-id');

    expect(result).toEqual({ ok: false, error: 'API error (code 5): NOT_FOUND' });
  });

  it('getSourceContent returns ok:false when stdout is not valid JSON', () => {
    mockSpawnSync.mockReturnValue({ status: 0, stdout: 'not json', stderr: '' });

    const result = getSourceContent('src-1');

    expect(result.ok).toBe(false);
  });

  it('listNotes parses the {notebook_id, notes} wrapper', () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        notebook_id: 'nb-1',
        notes: [{ id: 'note-1', title: 'T', content: 'full note body' }],
      }),
      stderr: '',
    });

    const result = listNotes('nb-1');

    expect(result).toEqual({ ok: true, data: [{ id: 'note-1', title: 'T', content: 'full note body' }] });
  });

  it('queryNotebook passes timeout and returns the answer text', () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ status: 'success', answer: 'The answer.' }),
      stderr: '',
    });

    const result = queryNotebook('nb-1', 'What is unresolved?', 60);

    expect(result).toEqual({ ok: true, data: 'The answer.' });
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'nlm',
      ['query', 'notebook', 'nb-1', 'What is unresolved?', '--json', '--timeout', '60'],
      expect.objectContaining({ encoding: 'utf-8' })
    );
  });

  it('returns ok:false when spawnSync itself reports an error (binary not found)', () => {
    mockSpawnSync.mockReturnValue({ status: null, error: new Error('ENOENT'), stdout: '', stderr: '' });

    const result = listSources('nb-1');

    expect(result).toEqual({ ok: false, error: 'ENOENT' });
  });
});
