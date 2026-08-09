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
});

describe('frameInWindows', () => {
  it('true when inside a window, false outside', () => {
    expect(frameInWindows(5000, [[1000, 10000]])).toBe(true);
    expect(frameInWindows(15000, [[1000, 10000]])).toBe(false);
  });
});
