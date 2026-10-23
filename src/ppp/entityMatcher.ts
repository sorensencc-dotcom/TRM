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
const ALL_CAPS_SHORT_TOKEN = /^[A-Z0-9]{2,}$/;
const SINGLE_ALPHA_TOKEN = /^[A-Za-z]{2,}$/;
const DBA_CONTINUATION = /^(?:DBA|D\/B\/A|T\/A|TA|DOING BUSINESS AS)\b/i;
const LEADING_CORP_SUFFIX =
  /^\s*(?:INC|INCORPORATED|LLC|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|LP|PLLC|PC|PA)\b/i;

function cleanStrayParens(value: string): string {
  return value.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
}

function splitOutsideParens(
  input: string,
  isSeparator: (ch: string, rest: string) => boolean
): string[] {
  if (!input) return [];
  const items: string[] = [];
  let current = '';
  let depth = 0;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '(') {
      depth++;
      current += ch;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
      current += ch;
    } else if (depth === 0 && isSeparator(ch, input.slice(i + 1))) {
      const trimmed = current.trim();
      if (trimmed.length > 0) items.push(trimmed);
      current = '';
    } else {
      current += ch;
    }
  }

  const trimmed = current.trim();
  if (trimmed.length > 0) items.push(trimmed);
  return items;
}

function splitDefendants(raw: string): string[] {
  return splitOutsideParens(raw, (ch) => ch === ';');
}

function splitEntities(raw: string): string[] {
  return splitOutsideParens(raw, (ch, rest) => {
    if (ch === ';') return true;
    if (ch === ',') return !LEADING_CORP_SUFFIX.test(rest);
    return false;
  });
}

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

  const parenRegex = /\(([^)]+)\)/g;
  for (const match of rawName.matchAll(parenRegex)) {
    const inner = match[1].trim();
    const matchIndex = match.index ?? 0;
    const before = cleanStrayParens(rawName.slice(0, matchIndex).replace(/\([^)]*\)/g, ' '));
    const after = cleanStrayParens(
      rawName.slice(matchIndex + match[0].length).replace(/\([^)]*\)/g, ' ')
    );

    if (ALIAS_PREFIXES.test(inner)) {
      const subParts = inner.split(/[,;]/);
      for (const part of subParts) {
        const stripped = cleanStrayParens(part.trim().replace(ALIAS_PREFIXES, ''));
        if (stripped.length > 0) {
          candidates.add(stripped);
        }
      }
      continue;
    }

    if (
      SINGLE_ALPHA_TOKEN.test(inner) &&
      before.length > 0 &&
      after.length > 0 &&
      !DBA_CONTINUATION.test(after) &&
      normalizeEntityName(after).length > 0
    ) {
      candidates.add(cleanStrayParens(`${inner} ${after}`));
      continue;
    }

    const subParts = inner.split(/[,;]/);
    for (const part of subParts) {
      const trimmedPart = part.trim();
      if (ALIAS_PREFIXES.test(trimmedPart)) {
        const stripped = cleanStrayParens(trimmedPart.replace(ALIAS_PREFIXES, ''));
        if (stripped.length > 0) {
          candidates.add(stripped);
        }
      } else {
        const cleanedPart = cleanStrayParens(trimmedPart);
        if (
          ALL_CAPS_SHORT_TOKEN.test(cleanedPart) &&
          /[A-Z]/.test(cleanedPart) &&
          !STRIP_SUFFIXES.has(cleanedPart)
        ) {
          candidates.add(cleanedPart);
        }
      }
    }
  }

  // Extract the text outside of all parentheses
  const outside = cleanStrayParens(rawName.replace(/\([^)]*\)/g, ' '));
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
  return parts.map((p) => cleanStrayParens(p)).filter((p) => p.length > 0);
}

/**
 * Expands a name string into all candidate variations:
 * 1. Semicolon splits outside parentheses
 * 2. Parenthetical aliases and short names
 * 3. DBA trade name splits
 */
export function expandNameCandidates(rawName: string): string[] {
  if (!rawName) return [];
  const candidates = new Set<string>();
  const topItems = splitDefendants(rawName);

  for (const topItem of topItems) {
    const parenExpanded = extractParentheticalCandidates(topItem);

    for (const item of parenExpanded) {
      const cleanItem = cleanStrayParens(item);
      if (cleanItem.length > 0) {
        candidates.add(cleanItem);
      }
      const dbaParts = extractDbaCandidates(cleanItem);
      for (const part of dbaParts) {
        const cleanPart = cleanStrayParens(part);
        if (cleanPart.length > 0) {
          candidates.add(cleanPart);
        }
      }
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
      // 1. Check defendant column (semicolon-separated outside parens, plus aliases in parentheses)
      const rawDefItems = splitDefendants(row.defendant);
      for (const rawDef of rawDefItems) {
        const defCandidates = expandNameCandidates(rawDef);
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
      }

      // 2. Check entities list (separated outside parens, plus parenthetical short names and DBAs)
      const rawEntityItems = splitEntities(row.entities);

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
