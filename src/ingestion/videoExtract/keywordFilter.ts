import { TranscriptSegment } from './transcribe';

export const KEYWORD_MATCH_PADDING_MS = 15000;

/**
 * Normalizes raw --keywords entries into individually-matchable tokens.
 *
 * There is no phrase-matching capability in this codebase: `computeKeywordWindows`
 * tokenizes transcript text into single words (split on non-word/apostrophe
 * boundaries), so a multi-word or hyphenated keyword like "World War II" or
 * "car-accident" can never match a whole transcript token. To keep matching
 * possible, each cleaned keyword entry is further split on the same
 * word-boundary pattern the transcript tokenizer uses, and each resulting
 * sub-token is added independently. This means multi-word keyword phrases
 * intentionally degrade to whole-word OR-matching across their constituent
 * words, not exact-phrase matching.
 */
export function normalizeKeywords(raw: string[]): string[] {
  const set = new Set<string>();
  for (const entry of raw) {
    const cleaned = entry.trim().toLowerCase().replace(/^[^\w]+|[^\w]+$/g, '');
    if (cleaned.length === 0) continue;
    for (const token of cleaned.split(/[^\w']+/)) {
      const word = token.replace(/^'+|'+$/g, '');
      if (word.length > 0) set.add(word);
    }
  }
  return [...set];
}

export function computeKeywordWindows(
  segments: TranscriptSegment[],
  keywords: string[],
  clipDurationMs: number
): { windows: Array<[number, number]>; matched: boolean } {
  if (keywords.length === 0) return { windows: [], matched: false };

  const keywordSet = new Set(keywords);
  const windows: Array<[number, number]> = [];
  let matched = false;

  for (const segment of segments) {
    const words = segment.text
      .toLowerCase()
      .split(/[^\w']+/)
      .filter(Boolean)
      .map((w) => w.replace(/^'+|'+$/g, ''))
      .filter(Boolean);
    if (words.some((w) => keywordSet.has(w))) {
      matched = true;
      windows.push([
        Math.max(0, segment.startMs - KEYWORD_MATCH_PADDING_MS),
        Math.min(clipDurationMs, segment.endMs + KEYWORD_MATCH_PADDING_MS),
      ]);
    }
  }

  return { windows, matched };
}

export function frameInWindows(timestampMs: number, windows: Array<[number, number]>): boolean {
  return windows.some(([start, end]) => timestampMs >= start && timestampMs <= end);
}
