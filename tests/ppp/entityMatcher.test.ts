import {
  extractDbaCandidates,
  matchExclusion,
  normalizeEntityName,
} from '../../src/ppp/entityMatcher';
import { SAMPLE_EXCLUSION_ROWS } from '../../src/ppp/fixtures/exclusionSample';

describe('PPP Texas - Entity Matcher', () => {
  describe('normalizeEntityName', () => {
    it('uppercases and cleans punctuation', () => {
      expect(normalizeEntityName('Cybersolve, It!')).toBe('CYBERSOLVE IT');
    });

    it('strips corporate suffixes on token boundaries without mangling root names', () => {
      expect(normalizeEntityName('CYBERSOLVE IT INC')).toBe('CYBERSOLVE IT');
      expect(normalizeEntityName('ACME LOGISTICS LLC')).toBe('ACME LOGISTICS');
      expect(normalizeEntityName('TEXAS HEALTHCARE CORP')).toBe('TEXAS HEALTHCARE');
      expect(normalizeEntityName('GLOBAL VENTURES COMPANY')).toBe('GLOBAL VENTURES');
      expect(normalizeEntityName('ALPHA PARTNERS LTD')).toBe('ALPHA PARTNERS');
      expect(normalizeEntityName('DELTA HOLDINGS PLLC')).toBe('DELTA HOLDINGS');
      expect(normalizeEntityName('FIRST MEDICAL PA')).toBe('FIRST MEDICAL');
    });

    it('does not corrupt internal occurrences of suffix words', () => {
      expect(normalizeEntityName('INCORPORATED SERVICES')).toBe('INCORPORATED SERVICES');
      expect(normalizeEntityName('COMPANY STORE')).toBe('COMPANY STORE');
    });
  });

  describe('extractDbaCandidates', () => {
    it('splits trade names correctly', () => {
      const candidates = extractDbaCandidates('RIO GRANDE IMPORTS DBA BORDER CARGO');
      expect(candidates).toEqual(['RIO GRANDE IMPORTS', 'BORDER CARGO']);
    });

    it('handles T/A and DOING BUSINESS AS variants', () => {
      expect(extractDbaCandidates('SMITH CONSULTING T/A FAST ADVISORS')).toEqual([
        'SMITH CONSULTING',
        'FAST ADVISORS',
      ]);
    });
  });

  describe('matchExclusion', () => {
    it('matches defendant column by normalized exact match', () => {
      const result = matchExclusion('JOHN DOE', SAMPLE_EXCLUSION_ROWS);
      expect(result.matched).toBe(true);
      expect(result.matchType).toBe('normalized_exact');
      expect(result.matchedOn).toBe('defendant');
      expect(result.exclusion?.district).toBe('SDTX');
    });

    it('matches entities column by normalized exact match', () => {
      const result = matchExclusion('ACME LOGISTICS', SAMPLE_EXCLUSION_ROWS);
      expect(result.matched).toBe(true);
      expect(result.matchedOn).toBe('entity');
      expect(result.matchedValue).toBe('ACME LOGISTICS LLC');
    });

    it('matches DBA candidates in exclusion list', () => {
      const result = matchExclusion('BORDER CARGO', SAMPLE_EXCLUSION_ROWS);
      expect(result.matched).toBe(true);
      expect(result.exclusion?.district).toBe('WDTX');
    });

    it('returns false for unlisted entities without asserting innocence', () => {
      const result = matchExclusion('CYBERSOLVE IT INC', SAMPLE_EXCLUSION_ROWS);
      expect(result.matched).toBe(false);
      expect(result.exclusion).toBeUndefined();
    });
  });
});
