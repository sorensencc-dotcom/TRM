import { matchExclusion } from '../../src/ppp/entityMatcher';
import {
  CYBERSOLVE_LOAN_ROW,
  CYBERSOLVE_PERSON_LEAD,
  CYBERSOLVE_SOURCE_FILE,
} from '../../src/ppp/fixtures/cybersolveFixture';
import { SAMPLE_EXCLUSION_ROWS } from '../../src/ppp/fixtures/exclusionSample';
import { PppGapRegistry } from '../../src/ppp/gapRegistry';
import {
  materializeClaimFromLoan,
  materializeUnverifiedLead,
  PppDatabase,
} from '../../src/ppp/sbaIngest';
import { verifySpanHash } from '../../src/ppp/spanHash';

describe('PPP Texas - CyberSolve IT Inc Test Case', () => {
  let db: PppDatabase;
  let gapRegistry: PppGapRegistry;

  beforeEach(() => {
    db = new PppDatabase(':memory:');
    gapRegistry = new PppGapRegistry();
  });

  afterEach(() => {
    db.close();
  });

  it('runs CyberSolve IT Inc case end-to-end with verified public fact, unverified persona lead, and open gap', () => {
    // 1. Ingest loan into SQLite
    db.insertLoan(CYBERSOLVE_LOAN_ROW, CYBERSOLVE_SOURCE_FILE);

    const storedLoan = db.findByLoanNumber('4491747703');
    expect(storedLoan).not.toBeNull();
    expect(storedLoan?.BorrowerName).toBe('CYBERSOLVE IT INC');
    expect(storedLoan?.CurrentApprovalAmount).toBe('295344');

    // 2. Materialize public record fact claim
    const factClaim = materializeClaimFromLoan(storedLoan!, CYBERSOLVE_SOURCE_FILE);

    expect(factClaim.claim_type).toBe('PUBLIC_RECORD_FACT');
    expect(factClaim.verification_status).toBe('VERIFIED');
    expect(factClaim.status_as_of).toBe('2024-09-30');
    expect(factClaim.span_hash).toMatch(/^[a-f0-9]{64}$/);

    // Verify span hash resolves directly to the source row
    const spanValid = verifySpanHash(factClaim, CYBERSOLVE_LOAN_ROW);
    expect(spanValid).toBe(true);

    // Verify SBA "Charged Off" is treated as loan write-off, not a criminal charge
    expect(factClaim.text).toContain('administrative write-off');
    expect(factClaim.text).toContain('not a criminal charge');
    expect(factClaim.notes).toBe('Status reflects administrative write-off, not a criminal charge.');

    // 3. Materialize persona lead from social media
    const personaLeadClaim = materializeUnverifiedLead(
      CYBERSOLVE_LOAN_ROW.BorrowerName,
      CYBERSOLVE_PERSON_LEAD.source_context,
      {
        loan_number: CYBERSOLVE_LOAN_ROW.LoanNumber,
        matching_amount: CYBERSOLVE_PERSON_LEAD.matching_amount,
        source_ref: 'social_media_tip',
      }
    );

    expect(personaLeadClaim.claim_type).toBe('UNVERIFIED_LEAD');
    expect(personaLeadClaim.verification_status).toBe('UNVERIFIED');
    expect(personaLeadClaim.span_hash).toBe('');
    expect(personaLeadClaim.notes).toContain('Not verified');

    // 4. Check exclusion matching
    const exclusionResult = matchExclusion(CYBERSOLVE_LOAN_ROW.BorrowerName, SAMPLE_EXCLUSION_ROWS);
    expect(exclusionResult.matched).toBe(false);

    // 5. Open gap handling: non-match does NOT clear the borrower, creates open gap
    const gap = gapRegistry.createGap(
      CYBERSOLVE_LOAN_ROW.BorrowerName,
      'No match in current 64-release exclusion list; borrower status in federal court records unverified.'
    );

    expect(gap.id).toBe('PPP-GAP-01');
    expect(gap.status).toBe('OPEN');

    // Tone and safety guardrail: forbidden terminology must not appear in any claims or output
    const allText = [
      factClaim.text,
      factClaim.notes || '',
      personaLeadClaim.text,
      personaLeadClaim.notes || '',
      gap.reason,
    ].join(' ');

    expect(allText.toLowerCase()).not.toContain('fraud');
  });
});
