import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeEvidenceMarkdown } from './evidenceWriter';
import { WebSearchResult } from './webSearch';

describe('writeEvidenceMarkdown', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-evidence-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const sampleResult: WebSearchResult = {
    query: 'latest release of widget-lib',
    hits: [
      { title: 'Widget Lib Releases', url: 'https://example.com/releases', snippet: 'v3.2.0 was released on 2026-09-01.' },
      { title: '(untitled)', url: 'https://example.com/other', snippet: '' },
    ],
  };

  it('writes a markdown file with the query and each hit, and returns its path', () => {
    const returnedPath = writeEvidenceMarkdown(root, 'open-contradictions', 'latest release of widget-lib', sampleResult);

    expect(returnedPath).toBe(path.join(root, '_kb-sync-staging', 'trm', 'gap-open-contradictions-evidence.md'));
    const content = fs.readFileSync(returnedPath, 'utf-8');
    expect(content).toContain('latest release of widget-lib');
    expect(content).toContain('### Widget Lib Releases');
    expect(content).toContain('https://example.com/releases');
    expect(content).toContain('v3.2.0 was released on 2026-09-01.');
    expect(content).toContain('### (untitled)');
    expect(content).toContain('https://example.com/other');
  });

  it('creates the staging directory if it does not exist', () => {
    expect(fs.existsSync(path.join(root, '_kb-sync-staging'))).toBe(false);
    writeEvidenceMarkdown(root, 'gap-1', 'q', sampleResult);
    expect(fs.existsSync(path.join(root, '_kb-sync-staging', 'trm'))).toBe(true);
  });

  it('overwrites an existing file at the same path', () => {
    writeEvidenceMarkdown(root, 'gap-1', 'first query', sampleResult);
    writeEvidenceMarkdown(root, 'gap-1', 'second query', sampleResult);
    const content = fs.readFileSync(path.join(root, '_kb-sync-staging', 'trm', 'gap-gap-1-evidence.md'), 'utf-8');
    expect(content).toContain('second query');
    expect(content).not.toContain('first query');
  });

  it.each([
    ['contains a slash', 'gap/1'],
    ['contains dots', '../etc'],
    ['contains spaces', 'gap 1'],
    ['is empty', ''],
    ['exceeds 64 chars', 'a'.repeat(65)],
  ])('throws when id %s', (_desc, badId) => {
    expect(() => writeEvidenceMarkdown(root, badId, 'q', sampleResult)).toThrow(/invalid id/i);
  });
});
