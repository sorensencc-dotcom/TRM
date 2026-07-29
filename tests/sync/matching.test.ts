import { matchFact, MATCH_CONFIG_VERSION } from '../../src/sync/matching';
import { Fact } from '../../src/scoring/types';
import { DependencyMap } from '../../src/sync/dependencyMap';

function fact(overrides: Partial<Fact> = {}): Fact {
  return {
    id: 'FCT-001',
    text: 'Sorensen and Fleet discuss the San Diego bomber contract.',
    source_id: 'SRC-001',
    confidence: 0.9,
    categories: ['biography', 'industry'],
    ...overrides,
  };
}

describe('MATCH_CONFIG_VERSION', () => {
  it('is 1', () => {
    expect(MATCH_CONFIG_VERSION).toBe(1);
  });
});

describe('matchFact', () => {
  it('scores a fully-tagged item using categories, keywords, and claim text', () => {
    const map: DependencyMap = {
      matchSchemaVersion: 1,
      items: [
        {
          id: 'V-5.3',
          beat: '5.3',
          claim: 'Sorensen and Fleet negotiate the San Diego bomber deal.',
          categories: ['biography', 'industry'],
          keywords: ['fleet', 'san', 'diego', 'bomber'],
        },
      ],
    };
    const [result] = matchFact(fact(), map);
    expect(result.itemId).toBe('V-5.3');
    expect(result.score).toBeGreaterThan(0.6);
    expect(result.bucket).toBe('high');
  });

  it('falls back to claim-text overlap alone for an untagged item', () => {
    const map: DependencyMap = {
      matchSchemaVersion: 1,
      items: [{ id: 'V-9.1', beat: '9.1', claim: 'Sorensen and Fleet discuss the San Diego bomber contract terms.' }],
    };
    const [result] = matchFact(fact(), map);
    expect(result.itemId).toBe('V-9.1');
    expect(result.score).toBeGreaterThan(0);
  });

  it('scores 0 categoryScore for an item with empty categories', () => {
    const map: DependencyMap = {
      matchSchemaVersion: 1,
      items: [{ id: 'V-1.1', beat: '1.1', claim: 'unrelated claim text about something else entirely', categories: [] }],
    };
    const results = matchFact(fact({ text: 'completely different subject matter here' }), map);
    expect(results).toEqual([]);
  });

  it('omits items scoring below 0.1', () => {
    const map: DependencyMap = {
      matchSchemaVersion: 1,
      items: [{ id: 'V-0.0', beat: '0.0', claim: 'zzz qqq xxx nothing in common whatsoever' }],
    };
    expect(matchFact(fact(), map)).toEqual([]);
  });

  it('caps results at 3, highest score first', () => {
    const map: DependencyMap = {
      matchSchemaVersion: 1,
      items: Array.from({ length: 5 }, (_, i) => ({
        id: `V-${i}`,
        beat: `${i}`,
        claim: 'Sorensen and Fleet discuss the San Diego bomber contract.',
        keywords: ['sorensen', 'fleet', 'san', 'diego', 'bomber', 'contract'],
      })),
    };
    const results = matchFact(fact(), map);
    expect(results).toHaveLength(3);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it('breaks ties by itemId ascending', () => {
    const map: DependencyMap = {
      matchSchemaVersion: 1,
      items: [
        { id: 'V-2', beat: '2', claim: 'Sorensen',categories: ['biography', 'industry'], keywords: ['sorensen'] },
        { id: 'V-1', beat: '1', claim: 'Sorensen', categories: ['biography', 'industry'], keywords: ['sorensen'] },
      ],
    };
    const results = matchFact(fact(), map);
    expect(results[0].itemId).toBe('V-1');
    expect(results[1].itemId).toBe('V-2');
  });

  it('buckets exactly at each boundary', () => {
    // Constructed so categoryScore=1 (full overlap), keywordScore=0, claimScore=0 -> 0.4 * 1 = 0.4 -> medium
    const map: DependencyMap = {
      matchSchemaVersion: 1,
      items: [{ id: 'V-B', beat: 'b', claim: 'unrelated xyz', categories: ['biography', 'industry'], keywords: ['nothing'] }],
    };
    const [result] = matchFact(fact({ categories: ['biography', 'industry'], text: 'zzz qqq xxx' }), map);
    expect(result.score).toBeCloseTo(0.4, 3);
    expect(result.bucket).toBe('medium');
  });
});
