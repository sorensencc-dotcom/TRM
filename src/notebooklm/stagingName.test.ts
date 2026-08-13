import { slugifyTitle, stagingRelativePath, isPathContained } from './stagingName';
import * as path from 'node:path';

describe('stagingName', () => {
  it('slugifyTitle lowercases, replaces non-alphanumerics with hyphens, trims repeats', () => {
    expect(slugifyTitle('The Willys-Overland Plant: 1943 Production!')).toBe('the-willys-overland-plant-1943-production');
  });

  it('slugifyTitle handles empty/whitespace-only titles with a fallback', () => {
    expect(slugifyTitle('   ')).toBe('untitled');
  });

  it('slugifyTitle caps length so staged paths stay under Windows MAX_PATH', () => {
    const longTitle =
      'Banco Nacional de Cuba, Appellant, v. Peter L. F. Sabbatino, as Receiver, and F. Shelton Parr, William F. Prescott, Emet Whitlock, Lawrence H. Dixon, H. Bartow Farr, Elizabeth C. Prescott, Fabio Freyre, and Helen G. Downs, Co-Partners, Doing Business as Farr, Whitlock & Co., Appellees, 307 F.2d 845 (2d Cir. 1962) - Justia Law';
    const slug = slugifyTitle(longTitle);
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug.endsWith('-')).toBe(false);
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
