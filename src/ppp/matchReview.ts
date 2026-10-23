import { MatchExclusionResult, normalizeEntityName } from './entityMatcher';
import { PppExclusionRow, PppLoanRow } from './types';

export type MatchConfidence = 'strong' | 'weak';

export interface MatchEvidence {
  release_url: string;
  matched_value: string;
  exclusion_entities: string;
  loan_number: string;
}

export interface MatchChecks {
  city_match: boolean | null;
  zip_match: boolean | null;
  approved_before_release: boolean | null;
  confidence: MatchConfidence;
  reason: string;
  evidence: MatchEvidence;
}

const TEXAS_PLACE_WORDS = new Set([
  'TEXAS',
  'TEXAN',
  'TX',
  'HOUSTON',
  'DALLAS',
  'AUSTIN',
  'SAN',
  'ANTONIO',
  'FORT',
  'WORTH',
  'EL',
  'PASO',
  'PLANO',
  'IRVING',
  'GARLAND',
  'LUBBOCK',
  'AMARILLO',
  'WACO',
  'LAREDO',
  'CORPUS',
  'CHRISTI',
  'ARLINGTON',
  'FRISCO',
  'KATY',
  'LONE',
  'STAR',
  'GULF',
  'COAST',
  'ALAMO',
]);

const COMMON_TRADE_WORDS = new Set([
  'LANDSCAPING',
  'LANDSCAPE',
  'LAWN',
  'BARBECUE',
  'BARBEQUE',
  'BBQ',
  'PLUMBING',
  'ROOFING',
  'TRUCKING',
  'CONSTRUCTION',
  'CONTRACTORS',
  'CONTRACTING',
  'SERVICES',
  'SERVICE',
  'ENTERPRISES',
  'CONSULTING',
  'CLEANING',
  'PAINTING',
  'HVAC',
  'ELECTRIC',
  'ELECTRICAL',
  'AUTO',
  'REPAIR',
  'TRANSPORT',
  'TRANSPORTATION',
  'LOGISTICS',
  'RESTAURANT',
  'GRILL',
  'CAFE',
  'CATERING',
  'BAKERY',
  'SALON',
  'REALTY',
  'PROPERTIES',
  'HOMES',
  'FENCE',
  'PEST',
  'CONTROL',
  'TOWING',
  'MOVING',
  'STAFFING',
]);

const FILLER_WORDS = new Set(['THE', 'OF', 'AND', 'N']);

/**
 * A name is generic when every token is a Texas place word, a common trade word,
 * or filler, with at least one place word and one trade word.
 */
export function isGenericName(borrowerName: string): boolean {
  const tokens = normalizeEntityName(borrowerName)
    .split(' ')
    .filter((t) => t.length > 0 && !FILLER_WORDS.has(t));
  if (tokens.length === 0) return false;
  let hasPlace = false;
  let hasTrade = false;
  for (const token of tokens) {
    if (TEXAS_PLACE_WORDS.has(token)) hasPlace = true;
    else if (COMMON_TRADE_WORDS.has(token)) hasTrade = true;
    else return false;
  }
  return hasPlace && hasTrade;
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(';')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

export function cityMatch(loanCity: string, releaseCity: string): boolean | null {
  const city = (loanCity || '').trim().toLowerCase();
  const cities = splitList(releaseCity);
  if (!city || cities.length === 0) return null;
  return cities.includes(city);
}

function zip5(value: string): string {
  return value.trim().slice(0, 5);
}

export function zipMatch(loanZip: string, releaseZip: string | undefined): boolean | null {
  const zip = zip5(loanZip || '');
  const zips = splitList(releaseZip).map(zip5);
  if (!zip || zips.length === 0) return null;
  return zips.includes(zip);
}

function parseDate(value: string | undefined): number | null {
  if (!value) return null;
  const v = value.trim();
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(v);
  if (us) return Date.UTC(Number(us[3]), Number(us[1]) - 1, Number(us[2]));
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (iso) return Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  return null;
}

export function approvedBeforeRelease(
  dateApproved: string | undefined,
  releaseDate: string
): boolean | null {
  const approved = parseDate(dateApproved);
  const release = parseDate(releaseDate);
  if (approved === null || release === null) return null;
  return approved < release;
}

export function evaluateMatch(
  loan: PppLoanRow,
  match: MatchExclusionResult & { exclusion: PppExclusionRow; matchedValue: string }
): MatchChecks {
  const row = match.exclusion;
  const generic = isGenericName(loan.BorrowerName);
  const viaDefendant = match.matchedOn === 'defendant';

  let confidence: MatchConfidence;
  let reason: string;
  if (generic) {
    confidence = 'weak';
    reason = 'generic name (Texas place word plus common trade word)';
  } else if (viaDefendant) {
    confidence = 'weak';
    reason = 'defendant-name-only match on a person';
  } else {
    confidence = 'strong';
    reason = 'entity match on non-generic name';
  }

  return {
    city_match: cityMatch(loan.BorrowerCity, row.city),
    zip_match: zipMatch(loan.BorrowerZip, row.zip),
    approved_before_release: approvedBeforeRelease(loan.DateApproved, row.release_date),
    confidence,
    reason,
    evidence: {
      release_url: row.url,
      matched_value: match.matchedValue,
      exclusion_entities: row.entities,
      loan_number: loan.LoanNumber,
    },
  };
}

export interface ReviewMatch {
  loanNumber: string;
  borrowerName: string;
  borrowerCity: string;
  amount: string;
  loanStatus: string;
  dateApproved?: string;
  matchedOn: 'defendant' | 'entity';
  matchType: 'normalized_exact' | 'literal';
  checks: MatchChecks;
}

export interface ReviewRelease {
  defendant: string;
  district: string;
  status: string;
  release_date: string;
  url: string;
  loans: ReviewMatch[];
}

export function groupByRelease(
  items: Array<{ exclusion: PppExclusionRow; loan: ReviewMatch }>
): ReviewRelease[] {
  const groups = new Map<PppExclusionRow, ReviewRelease>();
  for (const { exclusion, loan } of items) {
    let group = groups.get(exclusion);
    if (!group) {
      group = {
        defendant: exclusion.defendant,
        district: exclusion.district,
        status: exclusion.status,
        release_date: exclusion.release_date,
        url: exclusion.url,
        loans: [],
      };
      groups.set(exclusion, group);
    }
    group.loans.push(loan);
  }
  return Array.from(groups.values());
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function renderMatchesMarkdown(releases: ReviewRelease[]): string {
  const lines = [
    '# PPP exclusion matches',
    '',
    '| Release | Borrower | Loan # | Amount | Loan status | Confidence | city_match | approved_before_release |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const release of releases) {
    const label = release.url ? `[${cell(release.defendant)}](${release.url})` : cell(release.defendant);
    for (const loan of release.loans) {
      lines.push(
        `| ${label} | ${cell(loan.borrowerName)} | ${cell(loan.loanNumber)} | ${cell(loan.amount)} | ${cell(loan.loanStatus)} | ${loan.checks.confidence} | ${cell(loan.checks.city_match)} | ${cell(loan.checks.approved_before_release)} |`
      );
    }
  }
  return lines.join('\n') + '\n';
}
