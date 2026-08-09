import * as manifestStore from '../../core/manifestStore';
import { Fact } from '../../scoring/types';

interface ExtractPayload {
  facts: Fact[];
  summary: string;
}

/**
 * Live-reads each done entry's per-hash extract payload (not extract.json,
 * which is a regenerated cache that can be stale relative to these).
 */
export function deriveAutoKeywords(root: string, topicPath: string): string[] {
  const doneEntries = manifestStore.listEntries(root, topicPath).filter((e) => e.status === 'done');
  const categories = new Set<string>();

  for (const entry of doneEntries) {
    const payload = manifestStore.readExtract<ExtractPayload>(root, topicPath, entry.hash);
    if (!payload) continue;
    for (const fact of payload.facts) {
      for (const category of fact.categories ?? []) {
        if (category.trim().length > 0) categories.add(category);
      }
    }
  }

  return [...categories];
}
