import * as crypto from 'node:crypto';

/**
 * Returns a canonical JSON representation of a row:
 * - Top-level keys sorted alphabetically
 * - String values trimmed
 * - Undefined values omitted
 * - Amounts and numbers formatted without floating-point conversion
 */
export function canonicalRowJson(row: Record<string, unknown>): string {
  const sortedKeys = Object.keys(row).sort();
  const normalized: Record<string, unknown> = {};

  for (const key of sortedKeys) {
    if (key === 'source_file') continue;
    const value = row[key];
    if (value === undefined) continue;
    if (typeof value === 'string') {
      normalized[key] = value.trim();
    } else {
      normalized[key] = value;
    }
  }

  return JSON.stringify(normalized);
}

/**
 * Computes deterministic span hash for an SBA PPP tabular row:
 * sha256(LoanNumber + "|" + canonical_row_json)
 */
export function computeSpanHash(
  loanNumber: string,
  row: Record<string, unknown>
): string;
export function computeSpanHash(
  _sourceFilePath: string,
  loanNumber: string,
  row: Record<string, unknown>
): string;
export function computeSpanHash(
  arg1: string,
  arg2: string | Record<string, unknown>,
  arg3?: Record<string, unknown>
): string {
  const loanNumber = typeof arg2 === 'string' ? arg2 : arg1;
  const row = (typeof arg2 === 'string' ? arg3 : arg2) || {};
  const normalizedLoanNumber = String(loanNumber).trim();
  const canonicalJson = canonicalRowJson(row);
  const payload = `${normalizedLoanNumber}|${canonicalJson}`;

  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Verifies if a given claim's span_hash matches a candidate row.
 */
export function verifySpanHash(
  claim: { span_hash: string; source_file?: string; loan_number?: string },
  row: Record<string, unknown>
): boolean {
  if (!claim.span_hash) return false;
  const loanNumber = claim.loan_number || (row.LoanNumber as string) || '';
  if (!loanNumber) return false;
  const expectedHash = computeSpanHash(loanNumber, row);
  return claim.span_hash.toLowerCase() === expectedHash.toLowerCase();
}
