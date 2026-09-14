import * as fs from 'node:fs';
import * as path from 'node:path';
import { WebSearchResult } from './webSearch';

const ID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;

export function writeEvidenceMarkdown(root: string, id: string, query: string, result: WebSearchResult): string {
  if (!ID_PATTERN.test(id)) {
    throw new Error(`invalid id for evidence filename: "${id}"`);
  }

  const dir = path.join(root, '_kb-sync-staging', 'trm');
  fs.mkdirSync(dir, { recursive: true });

  const lines: string[] = [`# Web search evidence: ${id}`, '', `Query: ${query}`, ''];
  for (const hit of result.hits) {
    lines.push(`### ${hit.title}`, '', hit.url, '', hit.snippet, '');
  }

  const filePath = path.join(dir, `gap-${id}-evidence.md`);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  return filePath;
}
