export type PppClaimType =
  | 'PUBLIC_RECORD_FACT'
  | 'OFFICIAL_ALLEGATION'
  | 'UNVERIFIED_LEAD'
  | 'NEGATIVE_SEARCH';

export type PppVerificationStatus = 'VERIFIED' | 'UNVERIFIED' | 'CONTRADICTED';

export interface PppLoanRow {
  LoanNumber: string;
  BorrowerName: string;
  BorrowerAddress?: string;
  BorrowerCity: string;
  BorrowerState: string;
  BorrowerZip: string;
  CurrentApprovalAmount: string;
  LoanStatus: string;
  DateApproved?: string;
  [key: string]: unknown;
}

export interface PppExclusionRow {
  defendant: string;
  entities: string;
  city: string;
  district: string;
  status: string;
  release_date: string;
  url: string;
}

export interface PppClaim {
  id: string;
  topic: 'trm-ppp';
  claim_type: PppClaimType;
  verification_status: PppVerificationStatus;
  text: string;
  subject: string;
  status_as_of: string;
  span_hash: string;
  source_file: string;
  source_url?: string;
  quoted_span?: string;
  retrieved?: string;
  search_scope?: string;
  loan_number?: string;
  notes?: string;
}

export interface PppGap {
  id: string;
  topic: 'trm-ppp';
  borrower_name: string;
  status: 'OPEN' | 'RESOLVED';
  reason: string;
  created_at: string;
}
