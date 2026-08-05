import * as fs from 'node:fs';

export interface TopicRoutingConfig {
  [topicSlug: string]: string[];
}

export interface MatchResult {
  topic: string;
  matchedKeyword: string;
}

const SLUG_PATTERN = /^[a-z0-9-]+$/;

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[_\-/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function loadTopicRoutingConfig(configPath: string): TopicRoutingConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`topic-routing config not found at "${configPath}"`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (err) {
    throw new Error(`topic-routing config at "${configPath}" is not valid JSON: ${(err as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`topic-routing config at "${configPath}" must be a JSON object mapping topic slug -> keyword array`);
  }

  const config = parsed as Record<string, unknown>;
  const normalizedKeywordOwners = new Map<string, string>(); // normalized keyword -> topic that first claimed it

  for (const [slug, value] of Object.entries(config)) {
    if (!SLUG_PATTERN.test(slug)) {
      throw new Error(`topic-routing config: invalid topic slug "${slug}" (must match ${SLUG_PATTERN})`);
    }
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error(`topic-routing config: topic "${slug}" must have a non-empty keyword array`);
    }
    for (const keyword of value) {
      if (typeof keyword !== 'string' || keyword.trim().length === 0) {
        throw new Error(`topic-routing config: topic "${slug}" has an empty or non-string keyword`);
      }
      const normalizedKeyword = normalize(keyword);
      const owner = normalizedKeywordOwners.get(normalizedKeyword);
      if (owner && owner !== slug) {
        throw new Error(
          `topic-routing config: keyword "${keyword}" (normalized: "${normalizedKeyword}") collides between topics "${owner}" and "${slug}"`
        );
      }
      normalizedKeywordOwners.set(normalizedKeyword, slug);
    }
  }

  return config as TopicRoutingConfig;
}

function wordBoundaryIncludes(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(haystack);
}

export function classifyPath(
  normalizedInputPath: string,
  config: TopicRoutingConfig
): { result: MatchResult | null; ambiguous: boolean } {
  let best: { topic: string; keyword: string; tokenCount: number; length: number }[] = [];

  for (const [topic, keywords] of Object.entries(config)) {
    let topicBest: { keyword: string; tokenCount: number; length: number } | null = null;
    for (const keyword of keywords) {
      const normalizedKeyword = normalize(keyword);
      if (!wordBoundaryIncludes(normalizedInputPath, normalizedKeyword)) continue;
      const tokenCount = normalizedKeyword.split(' ').length;
      const length = normalizedKeyword.length;
      if (!topicBest || tokenCount > topicBest.tokenCount || (tokenCount === topicBest.tokenCount && length > topicBest.length)) {
        topicBest = { keyword, tokenCount, length };
      }
    }
    if (topicBest) best.push({ topic, ...topicBest });
  }

  if (best.length === 0) return { result: null, ambiguous: false };

  const maxTokenCount = Math.max(...best.map((b) => b.tokenCount));
  best = best.filter((b) => b.tokenCount === maxTokenCount);
  const maxLength = Math.max(...best.map((b) => b.length));
  best = best.filter((b) => b.length === maxLength);

  if (best.length > 1) return { result: null, ambiguous: true };

  return { result: { topic: best[0].topic, matchedKeyword: best[0].keyword }, ambiguous: false };
}
