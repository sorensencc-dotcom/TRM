import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { normalizeEntityName } from './entityMatcher';
import { computeSpanHash } from './spanHash';
import { PppClaim, PppLoanRow } from './types';

export class PppDatabase {
  private db: DatabaseSync;

  constructor(dbPath: string = ':memory:') {
    this.db = new DatabaseSync(dbPath);
    this.init();
  }

  private init(): void {
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
      String(loan.LoanNumber).trim(),
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
    const stmt = this.db.prepare('SELECT * FROM ppp_loans WHERE loan_number = ?');
    const result = stmt.get(String(loanNumber).trim()) as any;
    if (!result) return null;

    const row = JSON.parse(result.raw_json) as PppLoanRow;
    return { ...row, source_file: result.source_file };
  }

  public findByNormalizedName(normName: string): (PppLoanRow & { source_file: string })[] {
    const stmt = this.db.prepare('SELECT * FROM ppp_loans WHERE borrower_name_norm = ?');
    const results = stmt.all(normName) as any[];
    return results.map((r) => ({
      ...(JSON.parse(r.raw_json) as PppLoanRow),
      source_file: r.source_file,
    }));
  }

  public close(): void {
    this.db.close();
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

/**
 * Materializes a public record fact claim from a confirmed SBA loan row.
 * Never labels "Charged Off" as a criminal charge.
 */
export function materializeClaimFromLoan(
  loan: PppLoanRow,
  sourceFile: string,
  claimId?: string
): PppClaim {
  const isChargedOff = String(loan.LoanStatus).trim().toUpperCase() === 'CHARGED OFF';
  const statusDescription = isChargedOff
    ? 'Charged Off (administrative write-off of an uncollected loan balance by the SBA; an accounting disposition, not a criminal charge)'
    : String(loan.LoanStatus).trim();

  const approvalDate = loan.DateApproved ? ` approved on ${loan.DateApproved}` : '';
  const text = `SBA Loan ${loan.LoanNumber} issued to ${loan.BorrowerName} (${loan.BorrowerCity}, ${loan.BorrowerState})${approvalDate} for $${loan.CurrentApprovalAmount}. Status: ${statusDescription}.`;

  const spanHash = computeSpanHash(sourceFile, loan.LoanNumber, loan);

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
  context: { loan_number?: string; matching_amount?: string; source_ref?: string },
  claimId?: string
): PppClaim {
  return {
    id: claimId || `PPP-LEAD-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    topic: 'trm-ppp',
    claim_type: 'UNVERIFIED_LEAD',
    verification_status: 'UNVERIFIED',
    text: leadDescription,
    subject,
    status_as_of: new Date().toISOString().split('T')[0],
    span_hash: '',
    source_file: context.source_ref || 'unverified_lead',
    loan_number: context.loan_number,
    notes: 'Not verified. Relies on unconfirmed tip or matching dollar amount without public record corroboration.',
  };
}
