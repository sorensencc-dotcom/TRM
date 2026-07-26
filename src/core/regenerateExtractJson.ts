import * as fs from 'node:fs';
import * as path from 'node:path';
import { listEntries, readExtract } from './manifestStore';
import { nodeDir } from './paths';
import { Fact } from '../scoring/types';

interface PerSourceExtract {
  facts: Fact[];
  summary: string;
}

/**
 * Rebuild the legacy merged extract view from completed per-source payloads.
 * listEntries currently returns Object.values(manifest.entries), so this relies
 * on manifest insertion order to match extract.ts's source order. If manifest
 * ordering becomes nondeterministic, regenerated fact order is a known limitation.
 */
export function regenerateExtractJson(root: string, topicPath: string): void {
  const allFacts: Fact[] = [];
  const summaries: string[] = [];

  for (const entry of listEntries(root, topicPath)) {
    if (entry.status !== 'done') continue;

    const payload = readExtract<PerSourceExtract>(root, topicPath, entry.hash);
    if (!payload) continue;

    allFacts.push(...payload.facts);
    summaries.push(payload.summary);
  }

  const renumberedFacts = allFacts.map((fact, i) => ({
    ...fact,
    id: `FCT-${String(i + 1).padStart(3, '0')}`,
  }));
  const extractsDir = path.join(nodeDir(root, topicPath), 'extracts');
  fs.mkdirSync(extractsDir, { recursive: true });
  fs.writeFileSync(
    path.join(extractsDir, 'extract.json'),
    JSON.stringify({ facts: renumberedFacts }, null, 2)
  );
  fs.writeFileSync(path.join(extractsDir, 'summary.md'), summaries.join('\n\n'));
}
