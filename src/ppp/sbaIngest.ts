/// <reference path="./sqlite.d.ts" />
import * as fs from 'node:fs';
import * as readline from 'node:readline';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { normalizeEntityName } from './entityMatcher';
import { canonicalRowJson, computeSpanHash } from './spanHash';
import { PppClaim, PppLoanRow } from './types';

function getDatabaseSyncCtor(): (new (dbPath: string) => DatabaseSyncType) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sqlite = require('node:sqlite') as { DatabaseSync: new (dbPath: string) => DatabaseSyncType };
    return sqlite.DatabaseSync;
  } catch {
    return null;
  }
}

export class PppDatabase {
  private db: DatabaseSyncType | null = null;
  private fallbackStore = new Map<
    string,
    { raw_json: string; borrower_name_norm: string; source_file: string }
  >();

  constructor(dbPath: string = ':memory:') {
    const Ctor = getDatabaseSyncCtor();
    if (Ctor) {
      this.db = new Ctor(dbPath);
      this.init();
    }
  }

  private init(): void {
    if (!this.db) return;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS ppp_loans (
        loan_number TEXT PRIMARY KEY,
        borrower_name TEXT NOT NULL,
        borrower_name_norm TEXT NOT NULL,
        borrower_address TEXT,
        borrower_city TEXT,
        borrower_state TEXT,
        borrower_zip TEXT,
        current_approval_amount TEXT NOT NULL,
        loan_status TEXT NOT NULL,
        date_approved TEXT,
        source_file TEXT NOT NULL,
        raw_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ppp_norm_name ON ppp_loans(borrower_name_norm);
      CREATE INDEX IF NOT EXISTS idx_ppp_zip ON ppp_loans(borrower_zip);
      CREATE INDEX IF NOT EXISTS idx_ppp_amount ON ppp_loans(current_approval_amount);
    `);
  }

  public insertLoan(loan: PppLoanRow, sourceFile: string): void {
    const normName = normalizeEntityName(loan.BorrowerName);
    const loanNum = String(loan.LoanNumber).trim();
    if (!this.db) {
      this.fallbackStore.set(loanNum, {
        raw_json: JSON.stringify(loan),
        borrower_name_norm: normName,
        source_file: sourceFile,
      });
      return;
    }

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO ppp_loans (
        loan_number,
        borrower_name,
        borrower_name_norm,
        borrower_address,
        borrower_city,
        borrower_state,
        borrower_zip,
        current_approval_amount,
        loan_status,
        date_approved,
        source_file,
        raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      loanNum,
      String(loan.BorrowerName || '').trim(),
      normName,
      loan.BorrowerAddress ? String(loan.BorrowerAddress).trim() : null,
      loan.BorrowerCity ? String(loan.BorrowerCity).trim() : '',
      loan.BorrowerState ? String(loan.BorrowerState).trim() : '',
      loan.BorrowerZip ? String(loan.BorrowerZip).trim() : '',
      String(loan.CurrentApprovalAmount || '').trim(),
      String(loan.LoanStatus || '').trim(),
      loan.DateApproved ? String(loan.DateApproved).trim() : null,
      sourceFile,
      JSON.stringify(loan)
    );
  }

  public insertBatch(loans: PppLoanRow[], sourceFile: string): number {
    if (!this.db) {
      for (const loan of loans) {
        this.insertLoan(loan, sourceFile);
      }
      return loans.length;
    }
    this.db.exec('BEGIN TRANSACTION');
    try {
      for (const loan of loans) {
        this.insertLoan(loan, sourceFile);
      }
      this.db.exec('COMMIT');
      return loans.length;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  public findByLoanNumber(loanNumber: string): (PppLoanRow & { source_file: string }) | null {
    const key = String(loanNumber).trim();
    if (!this.db) {
      const entry = this.fallbackStore.get(key);
      if (!entry) return null;
      return { ...(JSON.parse(entry.raw_json) as PppLoanRow), source_file: entry.source_file };
    }
    const stmt = this.db.prepare('SELECT * FROM ppp_loans WHERE loan_number = ?');
    const result = stmt.get(key) as any;
    if (!result) return null;

    const row = JSON.parse(result.raw_json) as PppLoanRow;
    return { ...row, source_file: result.source_file };
  }

  public findByNormalizedName(normName: string): (PppLoanRow & { source_file: string })[] {
    if (!this.db) {
      const matches: (PppLoanRow & { source_file: string })[] = [];
      for (const entry of this.fallbackStore.values()) {
        if (entry.borrower_name_norm === normName) {
          matches.push({
            ...(JSON.parse(entry.raw_json) as PppLoanRow),
            source_file: entry.source_file,
          });
        }
      }
      return matches;
    }
    const stmt = this.db.prepare('SELECT * FROM ppp_loans WHERE borrower_name_norm = ?');
    const results = stmt.all(normName) as any[];
    return results.map((r) => ({
      ...(JSON.parse(r.raw_json) as PppLoanRow),
      source_file: r.source_file,
    }));
  }

  public close(): void {
    if (this.db) {
      this.db.close();
    } else {
      this.fallbackStore.clear();
    }
  }
}

/**
 * Streams an SBA CSV file using latin1 encoding.
 * Parses headers and yields typed objects.
 */
export async function streamSbaCsv(
  filePath: string,
  onRow: (row: Record<string, string>) => void | Promise<void>,
  options: { encoding?: BufferEncoding } = {}
): Promise<{ rowCount: number }> {
  const encoding = options.encoding || 'latin1';
  const fileStream = fs.createReadStream(filePath, { encoding });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let headers: string[] | null = null;
  let rowCount = 0;

  for await (const line of rl) {
    if (!line || line.trim().length === 0) continue;

    // Simple robust CSV line splitter honoring double quotes
    const cells: string[] = [];
    let insideQuotes = false;
    let currentCell = '';

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (insideQuotes && line[i + 1] === '"') {
          currentCell += '"';
          i++; // skip escaped quote
        } else {
          insideQuotes = !insideQuotes;
        }
      } else if (char === ',' && !insideQuotes) {
        cells.push(currentCell.trim());
        currentCell = '';
      } else {
        currentCell += char;
      }
    }
    cells.push(currentCell.trim());

    if (!headers) {
      headers = cells.map((h) => h.replace(/^["']|["']$/g, '').trim());
      continue;
    }

    const row: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      row[headers[i]] = cells[i] !== undefined ? cells[i].replace(/^["']|["']$/g, '').trim() : '';
    }

    rowCount++;
    await onRow(row);
  }

  return { rowCount };
}

export interface ClaimFromLoanOptions {
  source_url?: string;
  quoted_span?: string;
  retrieved?: string;
}

/**
 * Materializes a public record fact claim from a confirmed SBA loan row.
 * Never labels "Charged Off" as a criminal charge.
 */
export function materializeClaimFromLoan(
  loan: PppLoanRow,
  sourceFile: string,
  claimId?: string,
  options: ClaimFromLoanOptions = {}
): PppClaim {
  const isChargedOff = String(loan.LoanStatus).trim().toUpperCase() === 'CHARGED OFF';
  const statusDescription = isChargedOff
    ? 'Charged Off (administrative write-off of an uncollected loan balance by the SBA; an accounting disposition, not a criminal charge)'
    : String(loan.LoanStatus).trim();

  const approvalDate = loan.DateApproved ? ` approved on ${loan.DateApproved}` : '';
  const text = `SBA Loan ${loan.LoanNumber} issued to ${loan.BorrowerName} (${loan.BorrowerCity}, ${loan.BorrowerState})${approvalDate} for $${loan.CurrentApprovalAmount}. Status: ${statusDescription}.`;

  const spanHash = computeSpanHash(sourceFile, loan.LoanNumber, loan);
  const quotedSpan = options.quoted_span || canonicalRowJson(loan);
  const sourceUrl =
    options.source_url ||
    (typeof loan.source_url === 'string' && loan.source_url.trim().length > 0
      ? loan.source_url.trim()
      : undefined);
  const retrieved =
    options.retrieved ||
    (typeof loan.retrieved === 'string' && loan.retrieved.trim().length > 0
      ? loan.retrieved.trim()
      : new Date().toISOString().split('T')[0]);

  return {
    id: claimId || `PPP-CLAIM-${loan.LoanNumber}`,
    topic: 'trm-ppp',
    claim_type: 'PUBLIC_RECORD_FACT',
    verification_status: 'VERIFIED',
    text,
    subject: loan.BorrowerName,
    status_as_of: '2024-09-30',
    span_hash: spanHash,
    source_file: sourceFile,
    source_url: sourceUrl,
    quoted_span: quotedSpan,
    retrieved,
    loan_number: loan.LoanNumber,
    notes: isChargedOff ? 'Status reflects administrative write-off, not a criminal charge.' : undefined,
  };
}

/**
 * Materializes an unverified tip or social media lead.
 */
export function materializeUnverifiedLead(
  subject: string,
  leadDescription: string,
  context: {
    loan_number?: string;
    matching_amount?: string;
    source_ref?: string;
    source_url?: string;
    quoted_span?: string;
    retrieved?: string;
  },
  claimId?: string
): PppClaim {
  const today = new Date().toISOString().split('T')[0];
  const sourceUrl =
    context.source_url ||
    (context.source_ref && /^https?:\/\//i.test(context.source_ref) ? context.source_ref : undefined);

  return {
    id: claimId || `PPP-LEAD-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    topic: 'trm-ppp',
    claim_type: 'UNVERIFIED_LEAD',
    verification_status: 'UNVERIFIED',
    text: leadDescription,
    subject,
    status_as_of: today,
    span_hash: '',
    source_file: context.source_ref || 'unverified_lead',
    source_url: sourceUrl,
    quoted_span: context.quoted_span || leadDescription,
    retrieved: context.retrieved || today,
    loan_number: context.loan_number,
    notes: 'Not verified. Relies on unconfirmed tip or matching dollar amount without public record corroboration.',
  };
}

export interface NegativeSearchOptions {
  subject: string;
  source: string;
  search_scope: string;
  text?: string;
  source_url?: string;
  quoted_span?: string;
  retrieved?: string;
  status_as_of?: string;
  notes?: string;
  id?: string;
}

/**
 * Materializes a NEGATIVE_SEARCH claim representing a search of a named public
 * source that returned zero records within a defined search_scope.
 */
export function materializeNegativeSearch(options: NegativeSearchOptions): PppClaim {
  const date = options.retrieved || options.status_as_of || new Date().toISOString().split('T')[0];
  const text =
    options.text ||
    `${options.source} public search for "${options.subject}" (${options.search_scope}) returned 0 records on ${date}.`;

  return {
    id: options.id || `PPP-NEG-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    topic: 'trm-ppp',
    claim_type: 'NEGATIVE_SEARCH',
    verification_status: 'VERIFIED',
    text,
    subject: options.subject,
    status_as_of: options.status_as_of || date,
    span_hash: '',
    source_file: options.source,
    source_url: options.source_url,
    quoted_span: options.quoted_span,
    retrieved: date,
    search_scope: options.search_scope,
    notes: options.notes,
  };
}

export const buildNegativeSearchClaim = materializeNegativeSearch;
