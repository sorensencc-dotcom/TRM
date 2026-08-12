import { slugifyTitle, stagingRelativePath, isPathContained } from './stagingName';
import * as path from 'node:path';

describe('stagingName', () => {
  it('slugifyTitle lowercases, replaces non-alphanumerics with hyphens, trims repeats', () => {
    expect(slugifyTitle('The Willys-Overland Plant: 1943 Production!')).toBe('the-willys-overland-plant-1943-production');
  });

  it('slugifyTitle handles empty/whitespace-only titles with a fallback', () => {
    expect(slugifyTitle('   ')).toBe('untitled');
  });

  it('stagingRelativePath composes notebook slug, item id, and title slug', () => {
    expect(stagingRelativePath('cic-daily-research', 'src-abc-123', 'Willow Run Bomber Plant')).toBe(
      'intake/notebooklm/cic-daily-research/src-abc-123--willow-run-bomber-plant.md'
    );
  });

  it('a malicious title cannot escape intake/ once slugified', () => {
    const relPath = stagingRelativePath('nb', 'id1', '../../../etc/passwd');
    const root = path.resolve('/vault');
    const resolved = path.resolve(root, relPath);
    expect(isPathContained(root, relPath)).toBe(true);
    expect(resolved.startsWith(path.join(root, 'intake'))).toBe(true);
  });

  it('isPathContained rejects a path with raw traversal segments regardless of source', () => {
    expect(isPathContained('/vault', 'intake/../../outside.md')).toBe(false);
  });
});
