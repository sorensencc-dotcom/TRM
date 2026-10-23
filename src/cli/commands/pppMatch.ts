import * as fs from 'node:fs';
import * as path from 'node:path';
import { matchExclusion, MatchExclusionResult } from '../../ppp/entityMatcher';
import { materializeClaimFromLoan, PppDatabase, streamSbaCsv } from '../../ppp/sbaIngest';
import { PppClaim, PppExclusionRow, PppLoanRow } from '../../ppp/types';

export interface PppMatchCliOptions {
  loans: string;
  exclusions: string;
  out?: string;
}

export interface PppMatchItemResult {
  loanNumber: string;
  borrowerName: string;
  claim: PppClaim;
  match: MatchExclusionResult;
}

export interface PppMatchSummary {
  loanCount: number;
  exclusionCount: number;
  matchCount: number;
  matches: PppMatchItemResult[];
  results: PppMatchItemResult[];
}

export async function runPppMatch(options: PppMatchCliOptions): Promise<PppMatchSummary> {
  const exclusions: PppExclusionRow[] = [];
  await streamSbaCsv(options.exclusions, (row) => {
    exclusions.push({
      defendant: row.defendant || '',
      entities: row.entities || '',
      city: row.city || '',
      district: row.district || '',
      status: row.status || '',
      release_date: row.release_date || '',
      url: row.url || '',
    });
  });

  const db = new PppDatabase(':memory:');
  const results: PppMatchItemResult[] = [];
  const matches: PppMatchItemResult[] = [];

  try {
    await streamSbaCsv(options.loans, (rawRow) => {
      const loan: PppLoanRow = {
        ...rawRow,
        LoanNumber: rawRow.LoanNumber || '',
        BorrowerName: rawRow.BorrowerName || '',
        BorrowerAddress: rawRow.BorrowerAddress,
        BorrowerCity: rawRow.BorrowerCity || '',
        BorrowerState: rawRow.BorrowerState || '',
        BorrowerZip: rawRow.BorrowerZip || '',
        CurrentApprovalAmount: rawRow.CurrentApprovalAmount || '',
        LoanStatus: rawRow.LoanStatus || '',
        DateApproved: rawRow.DateApproved,
      };

      db.insertLoan(loan, options.loans);
      const claim = materializeClaimFromLoan(loan, options.loans);
      const match = matchExclusion(loan.BorrowerName, exclusions);
      const item: PppMatchItemResult = {
        loanNumber: loan.LoanNumber,
        borrowerName: loan.BorrowerName,
        claim,
        match,
      };
      results.push(item);
      if (match.matched) {
        matches.push(item);
      }
    });
  } finally {
    db.close();
  }

  const summary: PppMatchSummary = {
    loanCount: results.length,
    exclusionCount: exclusions.length,
    matchCount: matches.length,
    matches,
    results,
  };

  if (options.out) {
    const outPath = path.resolve(options.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf-8');
  }

  return summary;
}
