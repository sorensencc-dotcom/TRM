import { Fact } from '../scoring/types';
import { tokenize } from './factIdentity';
import { DependencyMap, DependencyMapItem } from './dependencyMap';

export const MATCH_CONFIG_VERSION = 1;

export type ConfidenceBucket = 'high' | 'medium' | 'low';

export interface MatchResult {
  itemId: string;
  score: number;
  bucket: ConfidenceBucket;
}

/**
 * Fast Jaccard similarity between two Sets.
 * Optimization: iterates over the smaller set to minimize lookup operations.
 */
function jaccardSets(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 || setB.size === 0) return 0;
  const [smaller, larger] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  let intersection = 0;
  for (const x of smaller) {
    if (larger.has(x)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

interface PrecomputedItemSets {
  categoriesSet: Set<string>;
  keywordsSet: Set<string>;
  claimTokensSet: Set<string>;
}

// Cache precomputed token/category/keyword Sets per DependencyMapItem using WeakMap.
// This avoids repeated string tokenization and Set allocations across multiple facts.
const itemSetsCache = new WeakMap<DependencyMapItem, PrecomputedItemSets>();

function getPrecomputedItemSets(item: DependencyMapItem): PrecomputedItemSets {
  let cached = itemSetsCache.get(item);
  if (!cached) {
    cached = {
      categoriesSet: new Set(item.categories ?? []),
      keywordsSet: new Set(item.keywords ?? []),
      claimTokensSet: new Set(tokenize(item.claim)),
    };
    itemSetsCache.set(item, cached);
  }
  return cached;
}

function bucketFor(score: number): ConfidenceBucket | null {
  if (score >= 0.6) return 'high';
  if (score >= 0.3) return 'medium';
  if (score >= 0.1) return 'low';
  return null;
}

/**
 * Computes match score between a pre-tokenized fact and a DependencyMapItem.
 * Reuses precomputed Sets for category, keyword, and claim tokens.
 */
function scoreFactWithSets(
  factCategoriesSet: Set<string>,
  factTokensSet: Set<string>,
  item: DependencyMapItem
): number {
  const itemSets = getPrecomputedItemSets(item);

  const categoryScore = jaccardSets(factCategoriesSet, itemSets.categoriesSet);
  const keywordScore = jaccardSets(factTokensSet, itemSets.keywordsSet);
  const claimScore = jaccardSets(factTokensSet, itemSets.claimTokensSet);

  return Math.round((0.4 * categoryScore + 0.3 * keywordScore + 0.3 * claimScore) * 1000) / 1000;
}

export function scoreFact(fact: Fact, item: DependencyMapItem): number {
  const factCategoriesSet = new Set(fact.categories);
  const factTokensSet = new Set(tokenize(fact.text));
  return scoreFactWithSets(factCategoriesSet, factTokensSet, item);
}

/**
 * Matches a fact against all items in a dependency map.
 * Optimization: Fact tokens and categories are parsed into Sets ONCE per fact,
 * and dependency map item tokens/sets are memoized via WeakMap.
 */
export function matchFact(fact: Fact, map: DependencyMap): MatchResult[] {
  const factCategoriesSet = new Set(fact.categories);
  const factTokensSet = new Set(tokenize(fact.text));

  const results: MatchResult[] = [];
  for (const item of map.items) {
    const score = scoreFactWithSets(factCategoriesSet, factTokensSet, item);
    const bucket = bucketFor(score);
    if (bucket === null) continue;
    results.push({ itemId: item.id, score, bucket });
  }
  results.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.itemId.localeCompare(b.itemId)));
  return results.slice(0, 3);
}
