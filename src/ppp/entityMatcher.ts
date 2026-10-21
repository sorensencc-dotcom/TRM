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

const ALIAS_PREFIXES = /^(?:A\/?K\/?A\.?|F\/?K\/?A\.?|N\/?K\/?A\.?|D\/?B\/?A\.?|T\/?A\.?)\s+/i;

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
 * Extracts candidate names by expanding parenthetical aliases and short names.
 * e.g., "GLOBAL INFORMATION TECHNOLOGY SOLUTIONS (GITS)" -> ["GLOBAL INFORMATION TECHNOLOGY SOLUTIONS", "GITS"]
 * e.g., "JOHN DOE (AKA JOHNNY DOE)" -> ["JOHN DOE", "JOHNNY DOE"]
 * e.g., "JANE DOE (AKA JANIE, JANE SMITH)" -> ["JANE DOE", "JANIE", "JANE SMITH"]
 */
export function extractParentheticalCandidates(rawName: string): string[] {
  if (!rawName) return [];
  const candidates = new Set<string>();

  // Extract everything inside parentheses
  const parenMatches = rawName.match(/\(([^)]+)\)/g);
  if (parenMatches) {
    for (const match of parenMatches) {
      const inner = match.slice(1, -1).trim();
      const subParts = inner.split(/[,;]/);
      for (const part of subParts) {
        const stripped = part.trim().replace(ALIAS_PREFIXES, '').trim();
        if (stripped.length > 0) {
          candidates.add(stripped);
        }
      }
    }
  }

  // Extract the text outside of all parentheses
  const outside = rawName.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (outside.length > 0) {
    candidates.add(outside);
  }

  return Array.from(candidates);
}

/**
 * Splits strings containing DBA/TA trade names into individual candidate names.
 */
export function extractDbaCandidates(rawName: string): string[] {
  if (!rawName) return [];
  const parts = rawName.split(/\b(?:DBA|D\/B\/A|T\/A|TA|DOING BUSINESS AS)\b/i);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * Expands a name string into all candidate variations:
 * 1. Parenthetical aliases and short names
 * 2. DBA trade name splits
 */
export function expandNameCandidates(rawName: string): string[] {
  if (!rawName) return [];
  const candidates = new Set<string>();

  const parenExpanded = extractParentheticalCandidates(rawName);
  const baseList = parenExpanded.length > 0 ? parenExpanded : [rawName];

  for (const item of baseList) {
    candidates.add(item);
    const dbaParts = extractDbaCandidates(item);
    for (const part of dbaParts) {
      candidates.add(part);
    }
  }

  return Array.from(candidates).filter((c) => c.trim().length > 0);
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
 * Expands parenthetical aliases (e.g. AKA) and entity short names (e.g. GITS).
 * Stage 1: Normalized exact match.
 * Stage 2: Literal exact match.
 */
export function matchExclusion(
  borrowerName: string,
  exclusions: PppExclusionRow[]
): MatchExclusionResult {
  const borrowerCandidates = expandNameCandidates(borrowerName);

  for (const bCandidate of borrowerCandidates) {
    const normBCandidate = normalizeEntityName(bCandidate);
    const upperBCandidate = bCandidate.toUpperCase().trim();

    if (!normBCandidate && !upperBCandidate) continue;

    for (const row of exclusions) {
      // 1. Check defendant column (including aliases in parentheses)
      const defCandidates = expandNameCandidates(row.defendant);
      for (const dCandidate of defCandidates) {
        const normDef = normalizeEntityName(dCandidate);
        const upperDef = dCandidate.toUpperCase().trim();

        if (normBCandidate && normBCandidate === normDef) {
          return {
            matched: true,
            matchType: 'normalized_exact',
            matchedOn: 'defendant',
            matchedValue: dCandidate,
            exclusion: row,
          };
        }

        if (upperBCandidate && upperBCandidate === upperDef) {
          return {
            matched: true,
            matchType: 'literal',
            matchedOn: 'defendant',
            matchedValue: dCandidate,
            exclusion: row,
          };
        }
      }

      // 2. Check entities list (comma or semicolon separated, plus parenthetical short names and DBAs)
      const rawEntityItems = row.entities
        ? row.entities.split(/[,;]/).map((e) => e.trim()).filter(Boolean)
        : [];

      for (const rawEnt of rawEntityItems) {
        const entCandidates = expandNameCandidates(rawEnt);
        for (const eCandidate of entCandidates) {
          const normEnt = normalizeEntityName(eCandidate);
          const upperEnt = eCandidate.toUpperCase().trim();

          if (normBCandidate && normBCandidate === normEnt) {
            return {
              matched: true,
              matchType: 'normalized_exact',
              matchedOn: 'entity',
              matchedValue: eCandidate,
              exclusion: row,
            };
          }

          if (upperBCandidate && upperBCandidate === upperEnt) {
            return {
              matched: true,
              matchType: 'literal',
              matchedOn: 'entity',
              matchedValue: eCandidate,
              exclusion: row,
            };
          }
        }
      }
    }
  }

  return { matched: false };
}
