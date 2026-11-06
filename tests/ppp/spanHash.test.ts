import { canonicalRowJson, computeSpanHash, verifySpanHash } from '../../src/ppp/spanHash';

describe('PPP Texas - Span Hash Canonicalization', () => {
  it('generates deterministic JSON with sorted keys and trimmed values', () => {
    const rowA = {
      CurrentApprovalAmount: '295344',
      BorrowerName: '  CYBERSOLVE IT INC  ',
      LoanNumber: '4491747703',
      LoanStatus: 'Charged Off',
    };

    const rowB = {
      LoanNumber: '4491747703',
      LoanStatus: 'Charged Off',
      BorrowerName: 'CYBERSOLVE IT INC',
      CurrentApprovalAmount: '295344',
    };

    const jsonA = canonicalRowJson(rowA);
    const jsonB = canonicalRowJson(rowB);

    expect(jsonA).toBe(jsonB);
    expect(jsonA).toBe('{"BorrowerName":"CYBERSOLVE IT INC","CurrentApprovalAmount":"295344","LoanNumber":"4491747703","LoanStatus":"Charged Off"}');
  });

  it('preserves raw amount strings without floating point modification', () => {
    const row = {
      CurrentApprovalAmount: '295344.00',
      LoanNumber: '12345',
    };
    const json = canonicalRowJson(row);
    expect(json).toContain('"CurrentApprovalAmount":"295344.00"');
  });

  it('computes portable span hash independent of machine absolute paths', () => {
    const row = {
      BorrowerName: 'CYBERSOLVE IT INC',
      LoanNumber: '4491747703',
      CurrentApprovalAmount: '295344',
    };

    const winPath = 'C:\\dev\\data\\ppp_foia_20240930_tx.csv';
    const linuxPath = '/workspace/data/ppp_foia_20240930_tx.csv';

    const hashWin = computeSpanHash(winPath, '4491747703', row);
    const hashLinux = computeSpanHash(linuxPath, '4491747703', row);

    expect(hashWin).toBe(hashLinux);
    expect(hashWin).toMatch(/^[a-f0-9]{64}$/);
  });

  it('verifies valid span hash and rejects mutated row', () => {
    const row = {
      BorrowerName: 'CYBERSOLVE IT INC',
      LoanNumber: '4491747703',
      CurrentApprovalAmount: '295344',
    };
    const sourceFile = 'ppp_foia_20240930_tx.csv';
    const spanHash = computeSpanHash(sourceFile, '4491747703', row);

    const validClaim = {
      span_hash: spanHash,
      source_file: sourceFile,
      loan_number: '4491747703',
    };

    expect(verifySpanHash(validClaim, row)).toBe(true);

    const mutatedRow = { ...row, CurrentApprovalAmount: '295345' };
    expect(verifySpanHash(validClaim, mutatedRow)).toBe(false);
  });

  it('produces identical hash for the same row across two different source file names', () => {
    const row = {
      BorrowerName: 'CYBERSOLVE IT INC',
      LoanNumber: '4491747703',
      CurrentApprovalAmount: '295344',
      LoanStatus: 'Charged Off',
    };

    const hashExtract = computeSpanHash('source-sba-loan-4491747703.csv', '4491747703', row);
    const hashBulk = computeSpanHash('public_150k_plus_240930.csv', '4491747703', row);
    const hashTwoArg = computeSpanHash('4491747703', row);

    expect(hashExtract).toBe(hashBulk);
    expect(hashExtract).toBe(hashTwoArg);
    expect(
      verifySpanHash(
        {
          span_hash: hashExtract,
          source_file: 'public_150k_plus_240930.csv',
          loan_number: '4491747703',
        },
        row
      )
    ).toBe(true);
    expect(verifySpanHash({ span_hash: hashExtract, loan_number: '4491747703' }, row)).toBe(true);
  });
});
