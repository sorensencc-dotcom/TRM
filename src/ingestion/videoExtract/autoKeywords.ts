import * as manifestStore from '../../core/manifestStore';
import { Fact } from '../../scoring/types';
import { CATEGORY_VOCAB } from '../../extraction/prompts/extractFacts';

interface ExtractPayload {
  facts: Fact[];
  summary: string;
}

// Fact.categories is a schema-enforced closed taxonomy (history/genealogy/
// industry/geopolitics/biography, see extractFacts.ts) -- analytical labels,
// not free-text terms anyone actually says on camera. Filtering these out
// keeps --auto-keywords from triggering the (slower) staged keyword-filter
// pipeline for a keyword list that can never match real transcript text.
const KNOWN_TAXONOMY_CATEGORIES = new Set<string>(CATEGORY_VOCAB);

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

  const derived = [...categories];
  const usable = derived.filter((c) => !KNOWN_TAXONOMY_CATEGORIES.has(c));

  if (derived.length > 0 && usable.length === 0) {
    console.error(
      `[ingest-dir] --auto-keywords: every derived category (${derived.join(', ')}) is a closed-taxonomy label, not a free-text term -- no auto-derived keywords were used. Pass --keywords explicitly for terms likely to appear in the transcript.`
    );
  }

  return usable;
}
