import * as fs from 'node:fs';
import * as path from 'node:path';
import { matchExclusion, MatchExclusionResult } from '../../ppp/entityMatcher';
import {
  evaluateMatch,
  groupByRelease,
  renderMatchesMarkdown,
  ReviewMatch,
  ReviewRelease,
} from '../../ppp/matchReview';
import { materializeClaimFromLoan, PppDatabase, streamSbaCsv } from '../../ppp/sbaIngest';
import { PppClaim, PppExclusionRow, PppLoanRow } from '../../ppp/types';

export interface PppMatchCliOptions {
  loans: string;
  exclusions: string;
  out?: string;
  full?: boolean;
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
  releaseCount: number;
  releases: ReviewRelease[];
  matches: PppMatchItemResult[];
  results?: PppMatchItemResult[];
}

/** Output shape for JSON/stdout: matches grouped by release, flat list only with --full. */
export function toOutput(summary: PppMatchSummary): Omit<PppMatchSummary, 'matches'> {
  const { matches: _matches, ...output } = summary;
  return output;
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
      ...(row.zip ? { zip: row.zip } : {}),
    });
  });

  const db = new PppDatabase(':memory:');
  const results: PppMatchItemResult[] = [];
  const matches: PppMatchItemResult[] = [];
  const reviewItems: Array<{ exclusion: PppExclusionRow; loan: ReviewMatch }> = [];
  let loanCount = 0;

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

      loanCount++;
      db.insertLoan(loan, options.loans);
      const claim = materializeClaimFromLoan(loan, options.loans);
      const match = matchExclusion(loan.BorrowerName, exclusions);
      const item: PppMatchItemResult = {
        loanNumber: loan.LoanNumber,
        borrowerName: loan.BorrowerName,
        claim,
        match,
      };
      if (options.full) results.push(item);
      if (match.matched && match.exclusion && match.matchedValue !== undefined) {
        matches.push(item);
        reviewItems.push({
          exclusion: match.exclusion,
          loan: {
            loanNumber: loan.LoanNumber,
            borrowerName: loan.BorrowerName,
            borrowerCity: loan.BorrowerCity,
            amount: loan.CurrentApprovalAmount,
            loanStatus: loan.LoanStatus,
            dateApproved: loan.DateApproved,
            matchedOn: match.matchedOn!,
            matchType: match.matchType!,
            checks: evaluateMatch(loan, {
              ...match,
              exclusion: match.exclusion,
              matchedValue: match.matchedValue,
            }),
          },
        });
      }
    });
  } finally {
    db.close();
  }

  const releases = groupByRelease(reviewItems);
  const summary: PppMatchSummary = {
    loanCount,
    exclusionCount: exclusions.length,
    matchCount: matches.length,
    releaseCount: releases.length,
    releases,
    matches,
    ...(options.full ? { results } : {}),
  };

  if (options.out) {
    const outPath = path.resolve(options.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(toOutput(summary), null, 2), 'utf-8');
    fs.writeFileSync(
      path.join(path.dirname(outPath), 'matches.md'),
      renderMatchesMarkdown(releases),
      'utf-8'
    );
  }

  return summary;
}
