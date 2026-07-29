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

function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const x of setA) if (setB.has(x)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function bucketFor(score: number): ConfidenceBucket | null {
  if (score >= 0.6) return 'high';
  if (score >= 0.3) return 'medium';
  if (score >= 0.1) return 'low';
  return null;
}

export function scoreFact(fact: Fact, item: DependencyMapItem): number {
  const factTokens = tokenize(fact.text);
  const claimTokens = tokenize(item.claim);

  const categoryScore = jaccard(fact.categories, item.categories ?? []);
  const keywordScore = jaccard(factTokens, item.keywords ?? []);
  const claimScore = jaccard(factTokens, claimTokens);

  return Math.round((0.4 * categoryScore + 0.3 * keywordScore + 0.3 * claimScore) * 1000) / 1000;
}

export function matchFact(fact: Fact, map: DependencyMap): MatchResult[] {
  const results: MatchResult[] = [];
  for (const item of map.items) {
    const score = scoreFact(fact, item);
    const bucket = bucketFor(score);
    if (bucket === null) continue;
    results.push({ itemId: item.id, score, bucket });
  }
  results.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.itemId.localeCompare(b.itemId)));
  return results.slice(0, 3);
}
