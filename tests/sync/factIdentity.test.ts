import { normalize, tokenize, factKey } from '../../src/sync/factIdentity';

describe('normalize', () => {
  it('lowercases, strips punctuation, collapses whitespace, trims', () => {
    expect(normalize('  Sorensen, C.E.!!  visits  Willow Run.  ')).toBe('sorensen ce visits willow run');
  });

  it('is idempotent', () => {
    const once = normalize('Fleet & Consolidated (San Diego)');
    expect(normalize(once)).toBe(once);
  });
});

describe('tokenize', () => {
  it('dedupes and drops stopwords', () => {
    expect(tokenize('the the fleet and consolidated fleet')).toEqual(['fleet', 'consolidated']);
  });

  it('returns empty array for an all-stopword string', () => {
    expect(tokenize('the and of a')).toEqual([]);
  });
});

describe('factKey', () => {
  it('is deterministic for identical input', () => {
    const fact = { source_id: 'SRC-001', text: 'Sorensen visits Willow Run.' };
    expect(factKey(fact)).toBe(factKey({ ...fact }));
  });

  it('differs when text changes', () => {
    const a = factKey({ source_id: 'SRC-001', text: 'original text' });
    const b = factKey({ source_id: 'SRC-001', text: 'edited text' });
    expect(a).not.toBe(b);
  });

  it('differs when source_id changes', () => {
    const a = factKey({ source_id: 'SRC-001', text: 'same text' });
    const b = factKey({ source_id: 'SRC-002', text: 'same text' });
    expect(a).not.toBe(b);
  });

  it('is unaffected by whitespace/punctuation differences that normalize away', () => {
    const a = factKey({ source_id: 'SRC-001', text: 'Sorensen visits Willow Run.' });
    const b = factKey({ source_id: 'SRC-001', text: '  sorensen   visits willow run  ' });
    expect(a).toBe(b);
  });

  it('is a 64-char hex sha256 digest', () => {
    const key = factKey({ source_id: 'SRC-001', text: 'x' });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps distinct keys for different all-punctuation/non-Latin text from the same source (regression: empty-normalize collision)', () => {
    const a = factKey({ source_id: 'SRC-016', text: '"' });
    const b = factKey({ source_id: 'SRC-016', text: 'реакто' });
    const c = factKey({ source_id: 'SRC-016', text: '%' });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });

  it('still merges identical all-punctuation text from the same source', () => {
    const a = factKey({ source_id: 'SRC-016', text: '"' });
    const b = factKey({ source_id: 'SRC-016', text: '"' });
    expect(a).toBe(b);
  });
});
