import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  materializeClaimFromLoan,
  materializeUnverifiedLead,
  PppDatabase,
  streamSbaCsv,
} from '../../src/ppp/sbaIngest';
import { PppLoanRow } from '../../src/ppp/types';

describe('PPP Texas - SBA Ingestion and Storage', () => {
  let db: PppDatabase;

  beforeEach(() => {
    db = new PppDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('inserts and retrieves loan rows with normalized names and indexed lookups', () => {
    const loan: PppLoanRow = {
      LoanNumber: '4491747703',
      BorrowerName: 'CYBERSOLVE IT INC',
      BorrowerCity: 'CARROLLTON',
      BorrowerState: 'TX',
      BorrowerZip: '75007-1644',
      CurrentApprovalAmount: '295344',
      LoanStatus: 'Charged Off',
      DateApproved: '05/11/2020',
    };

    db.insertLoan(loan, 'ppp_foia_tx.csv');

    const byNumber = db.findByLoanNumber('4491747703');
    expect(byNumber).not.toBeNull();
    expect(byNumber?.BorrowerName).toBe('CYBERSOLVE IT INC');
    expect(byNumber?.source_file).toBe('ppp_foia_tx.csv');

    const byName = db.findByNormalizedName('CYBERSOLVE IT');
    expect(byName).toHaveLength(1);
    expect(byName[0].LoanNumber).toBe('4491747703');
  });

  it('streams CSV containing Latin-1 encoded non-UTF-8 bytes without crashing', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-latin1-'));
    const tempCsv = path.join(tempDir, 'test_latin1.csv');

    // Create a CSV with non-UTF-8 Latin-1 bytes (e.g., 0xE9 for é, 0xF1 for ñ)
    const header = 'LoanNumber,BorrowerName,CurrentApprovalAmount,LoanStatus\n';
    const row1 = '1001,CAFE VALPARAISO,50000,Paid in Full\n';
    const row2Buffer = Buffer.from([
      ...Buffer.from('1002,HACIENDA PE'),
      0xf1, // ñ in latin-1 (ISO-8859-1)
      ...Buffer.from('A,75000,Paid in Full\n'),
    ]);

    const fullBuffer = Buffer.concat([Buffer.from(header, 'latin1'), Buffer.from(row1, 'latin1'), row2Buffer]);
    fs.writeFileSync(tempCsv, fullBuffer);

    const rows: Record<string, string>[] = [];
    const result = await streamSbaCsv(tempCsv, (r) => {
      rows.push(r);
    });

    expect(result.rowCount).toBe(2);
    expect(rows).toHaveLength(2);
    expect(rows[0].LoanNumber).toBe('1001');
    expect(rows[1].LoanNumber).toBe('1002');
    expect(rows[1].BorrowerName).toContain('HACIENDA PE');

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('materializes confirmed SBA loan as a PUBLIC_RECORD_FACT with neutral accounting wording', () => {
    const loan: PppLoanRow = {
      LoanNumber: '4491747703',
      BorrowerName: 'CYBERSOLVE IT INC',
      BorrowerCity: 'CARROLLTON',
      BorrowerState: 'TX',
      BorrowerZip: '75007-1644',
      CurrentApprovalAmount: '295344',
      LoanStatus: 'Charged Off',
      DateApproved: '05/11/2020',
    };

    const claim = materializeClaimFromLoan(loan, 'ppp_foia_tx.csv');

    expect(claim.claim_type).toBe('PUBLIC_RECORD_FACT');
    expect(claim.verification_status).toBe('VERIFIED');
    expect(claim.status_as_of).toBe('2024-09-30');
    expect(claim.span_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(claim.text).toContain('administrative write-off of an uncollected loan balance');
    expect(claim.text).toContain('not a criminal charge');
    expect(claim.text.toLowerCase()).not.toContain('fraud');
    expect(claim.notes).toContain('administrative write-off, not a criminal charge');
  });

  it('materializes unverified tip as UNVERIFIED_LEAD with UNVERIFIED status', () => {
    const lead = materializeUnverifiedLead(
      'CYBERSOLVE IT INC',
      'Individual on X claimed connection based on matching $295,344 loan amount.',
      { loan_number: '4491747703', matching_amount: '295344', source_ref: 'social_media_tip' }
    );

    expect(lead.claim_type).toBe('UNVERIFIED_LEAD');
    expect(lead.verification_status).toBe('UNVERIFIED');
    expect(lead.span_hash).toBe('');
    expect(lead.notes).toContain('Not verified');
    expect(lead.text.toLowerCase()).not.toContain('fraud');
  });
});
