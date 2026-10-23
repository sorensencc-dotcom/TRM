import {
  approvedBeforeRelease,
  cityMatch,
  isGenericName,
  renderMatchesMarkdown,
  zipMatch,
} from '../../src/ppp/matchReview';

describe('matchReview helpers', () => {
  it.each(['Houston Landscaping', 'Texas Barbecue LLC', 'Lone Star Plumbing Inc'])(
    'flags %s as generic',
    (name) => expect(isGenericName(name)).toBe(true)
  );

  it.each(['CYBERSOLVE IT INC', 'Houston', 'Landscaping', 'Prosperity Bank', ''])(
    'does not flag %s as generic',
    (name) => expect(isGenericName(name)).toBe(false)
  );

  it('matches city case-insensitively across a ; list, null without data', () => {
    expect(cityMatch('HOUSTON', 'Dallas; houston')).toBe(true);
    expect(cityMatch('Austin', 'Dallas;Houston')).toBe(false);
    expect(cityMatch('Austin', '')).toBeNull();
    expect(cityMatch('', 'Austin')).toBeNull();
  });

  it('matches zip on first five digits, null without data', () => {
    expect(zipMatch('75001-1234', '75001;76301')).toBe(true);
    expect(zipMatch('77001', '75001')).toBe(false);
    expect(zipMatch('77001', undefined)).toBeNull();
  });

  it('compares approval date strictly before release, handling both formats', () => {
    expect(approvedBeforeRelease('05/01/2020', '2026-09-14')).toBe(true);
    expect(approvedBeforeRelease('2026-09-14', '2026-09-14')).toBe(false);
    expect(approvedBeforeRelease(undefined, '2026-09-14')).toBeNull();
    expect(approvedBeforeRelease('05/01/2020', 'n/a')).toBeNull();
  });

  it('escapes pipes in markdown cells', () => {
    const md = renderMatchesMarkdown([
      {
        defendant: 'A|B',
        district: '',
        status: '',
        release_date: '',
        url: '',
        loans: [
          {
            loanNumber: '1',
            borrowerName: 'X|Y',
            borrowerCity: '',
            amount: '5',
            loanStatus: 'PIF',
            matchedOn: 'entity',
            matchType: 'literal',
            checks: {
              city_match: null,
              zip_match: null,
              approved_before_release: false,
              confidence: 'strong',
              reason: '',
              evidence: { release_url: '', matched_value: '', exclusion_entities: '', loan_number: '1' },
            },
          },
        ],
      },
    ]);
    expect(md).toContain('A\\|B');
    expect(md).toContain('X\\|Y');
  });
});
