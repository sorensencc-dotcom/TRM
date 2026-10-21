import { PppExclusionRow } from './types';

const STRIP_SUFFIXES = new Set([
  'INC',
  'INCORPORATED',
  'LLC',
  'CORP',
  'CORPORATION',
  'CO',
  'COMPANY',
  'LTD',
  'LIMITED',
  'LP',
  'PLLC',
  'PC',
  'PA',
  'DBA',
]);

/**
 * Normalizes an entity or defendant name for deterministic matching:
 * 1. Uppercase
 * 2. Replaces punctuation with spaces
 * 3. Tokenizes and strips corporate structure suffixes from trailing tokens
 * 4. Collapses whitespace
 */
export function normalizeEntityName(rawName: string): string {
  if (!rawName) return '';

  const clean = rawName
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .trim();

  let tokens = clean.split(/\s+/).filter(Boolean);

  while (tokens.length > 1 && STRIP_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }

  // Also strip leading DBA token if present
  if (tokens.length > 1 && tokens[0] === 'DBA') {
    tokens.shift();
  }

  return tokens.join(' ');
}

/**
 * Splits strings containing DBA/TA trade names into individual candidate names.
 */
export function extractDbaCandidates(rawName: string): string[] {
  if (!rawName) return [];
  const parts = rawName.split(/\b(?:DBA|D\/B\/A|T\/A|TA|DOING BUSINESS AS)\b/i);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

export interface MatchExclusionResult {
  matched: boolean;
  matchType?: 'normalized_exact' | 'literal';
  matchedOn?: 'defendant' | 'entity';
  matchedValue?: string;
  exclusion?: PppExclusionRow;
}

/**
 * Evaluates whether a borrower name matches any row in the exclusion list.
 * Checks both the defendant column and the entities column.
 * Stage 1: Normalized exact match.
 * Stage 2: Literal exact match.
 */
export function matchExclusion(
  borrowerName: string,
  exclusions: PppExclusionRow[]
): MatchExclusionResult {
  const candidateNames = extractDbaCandidates(borrowerName);
  if (candidateNames.length === 0) {
    candidateNames.push(borrowerName);
  }

  for (const candidate of candidateNames) {
    const normCandidate = normalizeEntityName(candidate);
    const upperCandidate = candidate.toUpperCase().trim();

    for (const row of exclusions) {
      // Check defendant
      const normDefendant = normalizeEntityName(row.defendant);
      const upperDefendant = row.defendant.toUpperCase().trim();

      if (normCandidate && normCandidate === normDefendant) {
        return {
          matched: true,
          matchType: 'normalized_exact',
          matchedOn: 'defendant',
          matchedValue: row.defendant,
          exclusion: row,
        };
      }

      if (upperCandidate && upperCandidate === upperDefendant) {
        return {
          matched: true,
          matchType: 'literal',
          matchedOn: 'defendant',
          matchedValue: row.defendant,
          exclusion: row,
        };
      }

      // Check entities list (comma or semicolon separated, plus DBA trade names)
      const rawEntityItems = row.entities
        ? row.entities.split(/[,;]/).map((e) => e.trim()).filter(Boolean)
        : [];

      const entityItems: string[] = [];
      for (const rawEnt of rawEntityItems) {
        entityItems.push(rawEnt);
        const subCandidates = extractDbaCandidates(rawEnt);
        if (subCandidates.length > 1) {
          entityItems.push(...subCandidates);
        }
      }

      for (const ent of entityItems) {
        const normEnt = normalizeEntityName(ent);
        const upperEnt = ent.toUpperCase().trim();

        if (normCandidate && normCandidate === normEnt) {
          return {
            matched: true,
            matchType: 'normalized_exact',
            matchedOn: 'entity',
            matchedValue: ent,
            exclusion: row,
          };
        }

        if (upperCandidate && upperCandidate === upperEnt) {
          return {
            matched: true,
            matchType: 'literal',
            matchedOn: 'entity',
            matchedValue: ent,
            exclusion: row,
          };
        }
      }
    }
  }

  return { matched: false };
}
