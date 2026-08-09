import {
  normalizeKeywords,
  computeKeywordWindows,
  frameInWindows,
  KEYWORD_MATCH_PADDING_MS,
} from '../../../src/ingestion/videoExtract/keywordFilter';
import { TranscriptSegment } from '../../../src/ingestion/videoExtract/transcribe';

describe('normalizeKeywords', () => {
  it('trims, lowercases, strips punctuation, drops empties, dedupes', () => {
    expect(normalizeKeywords([' Car ', 'CAR!', 'accident,', '', '   '])).toEqual(['car', 'accident']);
  });

  it('splits multi-word and hyphenated entries into independently-matchable tokens', () => {
    expect(normalizeKeywords(['World War II', 'car-accident'])).toEqual([
      'world',
      'war',
      'ii',
      'car',
      'accident',
    ]);
  });

  it('dedupes tokens produced by splitting against already-present single-word keywords', () => {
    expect(normalizeKeywords(['car', 'car accident'])).toEqual(['car', 'accident']);
  });
});

describe('computeKeywordWindows', () => {
  const clipDurationMs = 100000;

  it('matches whole words only, case-folded (not substrings)', () => {
    const segments: TranscriptSegment[] = [
      { startMs: 20000, endMs: 22000, text: 'A car crashed here' },
      { startMs: 40000, endMs: 42000, text: 'This is scary and a cartoon' },
    ];
    const { windows, matched } = computeKeywordWindows(segments, ['car'], clipDurationMs);
    expect(matched).toBe(true);
    expect(windows).toEqual([[20000 - KEYWORD_MATCH_PADDING_MS, 22000 + KEYWORD_MATCH_PADDING_MS]]);
  });

  it('unions windows across multiple matched segments', () => {
    const segments: TranscriptSegment[] = [
      { startMs: 10000, endMs: 11000, text: 'car' },
      { startMs: 50000, endMs: 51000, text: 'accident' },
    ];
    const { windows, matched } = computeKeywordWindows(segments, ['car', 'accident'], clipDurationMs);
    expect(matched).toBe(true);
    expect(windows).toHaveLength(2);
  });

  it('clamps windows to [0, clipDurationMs]', () => {
    const segments: TranscriptSegment[] = [{ startMs: 1000, endMs: 2000, text: 'car' }];
    const { windows } = computeKeywordWindows(segments, ['car'], clipDurationMs);
    expect(windows[0][0]).toBe(0);
  });

  it('an empty keyword list matches nothing', () => {
    const segments: TranscriptSegment[] = [{ startMs: 1000, endMs: 2000, text: 'car' }];
    const { windows, matched } = computeKeywordWindows(segments, [], clipDurationMs);
    expect(matched).toBe(false);
    expect(windows).toEqual([]);
  });

  it('zero matches across a real transcript returns matched: false', () => {
    const segments: TranscriptSegment[] = [{ startMs: 1000, endMs: 2000, text: 'nothing relevant here' }];
    const { matched } = computeKeywordWindows(segments, ['car'], clipDurationMs);
    expect(matched).toBe(false);
  });

  it('matches keywords containing apostrophes (contractions)', () => {
    const segments: TranscriptSegment[] = [
      { startMs: 30000, endMs: 32000, text: "I don't think that's right" },
    ];
    const { windows, matched } = computeKeywordWindows(segments, ["don't", "that's"], clipDurationMs);
    expect(matched).toBe(true);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toEqual([30000 - KEYWORD_MATCH_PADDING_MS, 32000 + KEYWORD_MATCH_PADDING_MS]);
  });

  it('matches both contractions and quoted words in same pass', () => {
    const segments: TranscriptSegment[] = [
      { startMs: 15000, endMs: 18000, text: "he said 'quoted' and that's important" },
    ];
    // Keywords: "quoted" (will match "'quoted'" after stripping apostrophes) and "that's" (contraction preserved)
    const { windows, matched } = computeKeywordWindows(segments, ['quoted', "that's"], clipDurationMs);
    expect(matched).toBe(true);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toEqual([15000 - KEYWORD_MATCH_PADDING_MS, 18000 + KEYWORD_MATCH_PADDING_MS]);
  });
});

describe('frameInWindows', () => {
  it('true when inside a window, false outside', () => {
    expect(frameInWindows(5000, [[1000, 10000]])).toBe(true);
    expect(frameInWindows(15000, [[1000, 10000]])).toBe(false);
  });
});
