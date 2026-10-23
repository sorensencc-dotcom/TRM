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

  describe('Real-row regressions (multi-defendant, nicknames, parenthetical notes, unbalanced parens)', () => {
    const realRows: PppExclusionRow[] = [
      {
        defendant: 'Weldon Greer, Jr.; Jarrod Durant Wilburn',
        entities: '',
        city: 'Houston',
        district: 'EDTX',
        status: 'pleaded guilty (Greer); charged (Wilburn)',
        release_date: '2026-09-14',
        url: 'https://www.justice.gov/usao-edtx/pr/eastern-district-texas-joins-doj-fraud-division-sba-and-sba-oig-covid-era-loan',
      },
      {
        defendant:
          'Mihir Patel; Kinjal Patel; Wajahat (Ray) Khan; Bhavesh (Bobby) Patel; Usha Chapain (aka Usha Sharma)',
        entities: 'Mammoth Metal Recycling; Elephant Recycling',
        city: '(TX, CA, OK - not stated per defendant)',
        district: 'NDTX',
        status: 'charged',
        release_date: '2023-06-28',
        url: 'https://www.justice.gov/usao-ndtx/pr/cfo-controller-corporate-officers-charged-53-million-fraud-scheme-involving-pandemic',
      },
      {
        defendant: 'Kaylee Ree Lunn',
        entities: 'First Capital Bank (employer, victim); Prosperity Bank',
        city: 'Holliday / Wichita Falls',
        district: 'NDTX',
        status: 'sentenced',
        release_date: '2025-12-05',
        url: 'https://www.justice.gov/usao-ndtx/pr/former-bank-vice-president-sentenced-four-years-federal-prison-fraudulent-ppp-and-eidl',
      },
      {
        defendant: 'Fahad Shah',
        entities: 'WBF Weddings by Farah Inc. (WBF)',
        city: 'Murphy',
        district: 'EDTX',
        status: 'sentenced',
        release_date: '2021-09-16',
        url: 'https://www.justice.gov/usao-edtx/pr/collin-county-wedding-planner-sentenced-covid-relief-fraud',
      },
      {
        defendant: 'Brian Bui',
        entities: '(dentistry business, unnamed)',
        city: 'Plano',
        district: 'EDTX',
        status: 'sentenced',
        release_date: '2023-06-05',
        url: 'https://www.justice.gov/usao-edtx/pr/collin-county-dentist-sentenced-covid-19-relief-related-fraud',
      },
      {
        defendant: 'Nathan Reis',
        entities: 'Blueacorn (lender service provider)',
        city: 'Rio Grande PR (formerly AZ)',
        district: 'NDTX',
        status: 'sentenced',
        release_date: '2025-12-18',
        url: 'https://www.justice.gov/usao-ndtx/pr/co-founder-paycheck-protection-program-lender-service-provider-sentenced-65m-covid-19',
      },
      {
        defendant: 'Leticia Arceneaux',
        entities: '(volleyball club, unnamed)',
        city: 'San Antonio',
        district: 'WDTX',
        status: 'sentenced',
        release_date: '2025-11-20',
        url: 'https://www.justice.gov/usao-wdtx/pr/san-antonio-woman-sentenced-federal-prison-defrauding-covid-relief-program',
      },
    ];

    it('splits multi-defendant on semicolon without breaking comma suffixes like "Weldon Greer, Jr."', () => {
      expect(matchExclusion('Weldon Greer Jr', realRows).matched).toBe(true);
      expect(matchExclusion('WELDON GREER JR', realRows).matched).toBe(true);
      expect(matchExclusion('Jarrod Durant Wilburn', realRows).matched).toBe(true);
      expect(matchExclusion('Jr', realRows).matched).toBe(false);
    });

    it('expands bare single-token nicknames as nickname + surname and rejects bare nickname or surname alone', () => {
      for (const name of [
        'Mihir Patel',
        'Kinjal Patel',
        'Wajahat Khan',
        'Ray Khan',
        'Bhavesh Patel',
        'Bobby Patel',
        'Usha Chapain',
        'Usha Sharma',
      ]) {
        const res = matchExclusion(name, realRows);
        expect(res.matched).toBe(true);
        expect(res.matchedOn).toBe('defendant');
      }

      for (const nonMatch of ['Ray', 'Bobby', 'Patel', 'Khan']) {
        expect(matchExclusion(nonMatch, realRows).matched).toBe(false);
      }
    });

    it('keeps entities with parenthetical notes intact, drops note tokens, and leaves no stray parentheses', () => {
      expect(matchExclusion('First Capital Bank', realRows).matched).toBe(true);
      expect(matchExclusion('Prosperity Bank', realRows).matched).toBe(true);
      expect(matchExclusion('Blueacorn', realRows).matched).toBe(true);

      for (const noteWord of [
        'victim',
        'employer',
        'unnamed',
        'dentistry business',
        'lender service provider',
        'volleyball club',
      ]) {
        expect(matchExclusion(noteWord, realRows).matched).toBe(false);
      }

      const candidates = [
        ...expandNameCandidates('First Capital Bank (employer, victim); Prosperity Bank'),
        ...expandNameCandidates('(dentistry business, unnamed)'),
        ...expandNameCandidates('First Capital Bank (employer'),
        ...expandNameCandidates('victim)'),
      ];
      for (const c of candidates) {
        expect(c).not.toContain('(');
        expect(c).not.toContain(')');
      }
    });

    it('still yields all-caps short names like GITS and WBF', () => {
      expect(
        expandNameCandidates('GLOBAL INFORMATION TECHNOLOGY SOLUTIONS (GITS)')
      ).toContain('GITS');
      expect(matchExclusion('WBF', realRows).matched).toBe(true);
    });
  });
});
