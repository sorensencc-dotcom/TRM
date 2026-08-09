import { TranscriptSegment } from './transcribe';

export const KEYWORD_MATCH_PADDING_MS = 15000;

export function normalizeKeywords(raw: string[]): string[] {
  const set = new Set<string>();
  for (const entry of raw) {
    const cleaned = entry.trim().toLowerCase().replace(/^[^\w]+|[^\w]+$/g, '');
    if (cleaned.length > 0) set.add(cleaned);
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
    const words = segment.text.toLowerCase().split(/[^\w]+/).filter(Boolean);
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
