import { computeTagOverlapStrength } from '../../src/crosslinks/relatedTopics';

describe('computeTagOverlapStrength', () => {
  it('returns 1 for identical tag sets', () => {
    expect(computeTagOverlapStrength(['a', 'b'], ['a', 'b'])).toBe(1);
  });
  it('returns 0 for disjoint tag sets', () => {
    expect(computeTagOverlapStrength(['a'], ['b'])).toBe(0);
  });
  it('returns 0 for empty input', () => {
    expect(computeTagOverlapStrength([], ['a'])).toBe(0);
  });
  it('returns partial overlap as Jaccard similarity', () => {
    expect(computeTagOverlapStrength(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3);
  });
});
