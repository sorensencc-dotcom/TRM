import { PppLoanRow } from '../types';

export const CYBERSOLVE_SOURCE_FILE = 'ppp_foia_20240930_tx.csv';

export const CYBERSOLVE_LOAN_ROW: PppLoanRow = {
  LoanNumber: '4491747703',
  DateApproved: '05/11/2020',
  BorrowerName: 'CYBERSOLVE IT INC',
  BorrowerAddress: '1833 CROOKED OAK DR',
  BorrowerCity: 'CARROLLTON',
  BorrowerState: 'TX',
  BorrowerZip: '75007-1644',
  CurrentApprovalAmount: '295344',
  LoanStatus: 'Charged Off',
};

export const CYBERSOLVE_PERSON_LEAD = {
  subject: 'CYBERSOLVE IT INC',
  named_individual: 'PERSON_ON_X',
  matching_amount: '295344',
  source_context: 'Post on X alleging link to CyberSolve IT Inc solely through matching $295,344 dollar amount.',
};
