import * as path from 'node:path';

const MAX_SLUG_LENGTH = 80;

export function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'untitled';
}

export function stagingRelativePath(notebookSlug: string, itemId: string, title: string): string {
  const safeItemId = itemId.replace(/[^a-zA-Z0-9-]/g, '');
  return `intake/notebooklm/${notebookSlug}/${safeItemId}--${slugifyTitle(title)}.md`;
}

export function isPathContained(root: string, relativePath: string): boolean {
  const intakeRoot = path.join(path.resolve(root), 'intake');
  const resolved = path.resolve(root, relativePath);
  const rel = path.relative(intakeRoot, resolved);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}
