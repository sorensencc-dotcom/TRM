import {
  expandNameCandidates,
  extractDbaCandidates,
  extractParentheticalCandidates,
  matchExclusion,
  normalizeEntityName,
} from '../../src/ppp/entityMatcher';
import { SAMPLE_EXCLUSION_ROWS } from '../../src/ppp/fixtures/exclusionSample';
import { PppExclusionRow } from '../../src/ppp/types';

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

  describe('extractParentheticalCandidates', () => {
    it('extracts acronyms and short names from parentheses', () => {
      const candidates = extractParentheticalCandidates('GLOBAL INFORMATION TECHNOLOGY SOLUTIONS (GITS)');
      expect(candidates).toContain('GITS');
      expect(candidates).toContain('GLOBAL INFORMATION TECHNOLOGY SOLUTIONS');
    });

    it('strips alias prefixes like AKA, FKA, NKA from parenthetical content', () => {
      const candidates1 = extractParentheticalCandidates('JOHN DOE (AKA JOHNNY DOE)');
      expect(candidates1).toContain('JOHNNY DOE');
      expect(candidates1).toContain('JOHN DOE');

      const candidates2 = extractParentheticalCandidates('JANE ROE (F/K/A JANE SMITH, NKA JANE DOE)');
      expect(candidates2).toContain('JANE SMITH');
      expect(candidates2).toContain('JANE DOE');
      expect(candidates2).toContain('JANE ROE');
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

  describe('expandNameCandidates', () => {
    it('combines parenthetical short names and DBA candidate splits', () => {
      const expanded = expandNameCandidates('GLOBAL TECH SOLUTIONS (GITS) DBA FAST CLOUD (FC)');
      expect(expanded).toContain('GITS');
      expect(expanded).toContain('FC');
      expect(expanded).toContain('GLOBAL TECH SOLUTIONS');
      expect(expanded).toContain('FAST CLOUD');
    });
  });

  describe('matchExclusion with Parentheses & DBA rules', () => {
    const extendedExclusions: PppExclusionRow[] = [
      ...SAMPLE_EXCLUSION_ROWS,
      {
        defendant: 'ROBERT TAYLOR (AKA BOBBY TAYLOR, BOB TAYLOR)',
        entities: 'GLOBAL INFORMATION TECHNOLOGY SOLUTIONS (GITS), APEX TECH (AT)',
        city: 'DALLAS',
        district: 'NDTX',
        status: 'Charged',
        release_date: '2022-03-15',
        url: 'https://www.justice.gov/usao-ndtx/pr/taylor',
      },
    ];

    it('matches defendant column by normalized exact match', () => {
      const result = matchExclusion('JOHN DOE', extendedExclusions);
      expect(result.matched).toBe(true);
      expect(result.matchType).toBe('normalized_exact');
      expect(result.matchedOn).toBe('defendant');
      expect(result.exclusion?.district).toBe('SDTX');
    });

    it('matches defendant parenthetical alias (e.g. AKA BOBBY TAYLOR)', () => {
      const result = matchExclusion('BOBBY TAYLOR', extendedExclusions);
      expect(result.matched).toBe(true);
      expect(result.matchedOn).toBe('defendant');
      expect(result.matchedValue).toBe('BOBBY TAYLOR');
      expect(result.exclusion?.defendant).toContain('ROBERT TAYLOR');
    });

    it('matches entity parenthetical short name / acronym (e.g. GITS)', () => {
      const result = matchExclusion('GITS', extendedExclusions);
      expect(result.matched).toBe(true);
      expect(result.matchedOn).toBe('entity');
      expect(result.matchedValue).toBe('GITS');
      expect(result.exclusion?.entities).toContain('GLOBAL INFORMATION TECHNOLOGY SOLUTIONS (GITS)');
    });

    it('matches full entity name when exclusion has parenthetical acronym', () => {
      const result = matchExclusion('GLOBAL INFORMATION TECHNOLOGY SOLUTIONS INC', extendedExclusions);
      expect(result.matched).toBe(true);
      expect(result.matchedOn).toBe('entity');
      expect(result.matchedValue).toBe('GLOBAL INFORMATION TECHNOLOGY SOLUTIONS');
    });

    it('matches DBA candidates in exclusion list', () => {
      const result = matchExclusion('BORDER CARGO', extendedExclusions);
      expect(result.matched).toBe(true);
      expect(result.exclusion?.district).toBe('WDTX');
    });

    it('returns false for unlisted entities without asserting innocence', () => {
      const result = matchExclusion('CYBERSOLVE IT INC', extendedExclusions);
      expect(result.matched).toBe(false);
      expect(result.exclusion).toBeUndefined();
    });
  });
});
