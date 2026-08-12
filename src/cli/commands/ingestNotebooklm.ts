import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { listSources, getSourceContent, listNotes } from '../../notebooklm/nlmCli';
import { readRegistry, findNotebook, sourceKey, noteKey, checkItem, flushPulledHash, flushQuarantine } from '../../notebooklm/registry';
import { stagingRelativePath } from '../../notebooklm/stagingName';
import { createRunReport, recordItem } from '../../notebooklm/runReport';

export interface StagedItem {
  key: string;
  relativePath: string;
  title: string;
  sourceUrl: string | null;
  origin: 'notebooklm' | 'notebooklm-derived';
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

function notebookSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function writeStaged(root: string, relativePath: string, content: string): void {
  const absPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}

export function pullAndStage(root: string, notebookId: string, runId: string): StagedItem[] {
  const registry = readRegistry(root);
  const entry = findNotebook(registry, notebookId);
  if (!entry) {
    throw new Error(`notebooklm-registry.json has no entry for notebook "${notebookId}"`);
  }

  const now = new Date().toISOString();
  createRunReport(root, runId, notebookId, now);
  const slug = notebookSlug(entry.title);
  const staged: StagedItem[] = [];

  const sourcesResult = listSources(notebookId);
  const sources = sourcesResult.ok ? sourcesResult.data : [];

  for (const source of sources) {
    const key = sourceKey(source.id);
    const contentResult = getSourceContent(source.id);

    if (!contentResult.ok) {
      flushQuarantine(root, notebookId, key, hashContent(''), contentResult.error, now);
      recordItem(root, runId, { key, status: 'quarantined', detail: contentResult.error });
      continue;
    }

    const content = contentResult.data;
    const hash = hashContent(content);
    const status = checkItem(entry, key, hash);

    if (status === 'unchanged' || status === 'quarantined-same') continue;

    if (content.trim().length === 0) {
      flushQuarantine(root, notebookId, key, hash, 'empty content', now);
      recordItem(root, runId, { key, status: 'quarantined', detail: 'empty content' });
      continue;
    }

    const isDerived = source.type === 'youtube';
    const relativePath = stagingRelativePath(slug, source.id, source.title);
    const fileContent = isDerived ? `<!-- provenance: derived -->\n${content}` : content;
    writeStaged(root, relativePath, fileContent);
    flushPulledHash(root, notebookId, key, hash);
    recordItem(root, runId, { key, status: 'staged' });

    staged.push({
      key,
      relativePath,
      title: source.title,
      sourceUrl: source.url,
      origin: isDerived ? 'notebooklm-derived' : 'notebooklm',
    });
  }

  const notesResult = listNotes(notebookId);
  const notes = notesResult.ok ? notesResult.data : [];

  for (const note of notes) {
    const key = noteKey(note.id);
    const hash = hashContent(note.content);
    const status = checkItem(entry, key, hash);

    if (status === 'unchanged' || status === 'quarantined-same') continue;

    if (note.content.trim().length === 0) {
      flushQuarantine(root, notebookId, key, hash, 'empty content', now);
      recordItem(root, runId, { key, status: 'quarantined', detail: 'empty content' });
      continue;
    }

    const relativePath = stagingRelativePath(slug, note.id, note.title);
    writeStaged(root, relativePath, note.content);
    flushPulledHash(root, notebookId, key, hash);
    recordItem(root, runId, { key, status: 'staged' });

    staged.push({
      key,
      relativePath,
      title: note.title,
      sourceUrl: `https://notebooklm.google.com/notebook/${notebookId}?note=${note.id}`,
      origin: 'notebooklm',
    });
  }

  return staged;
}
