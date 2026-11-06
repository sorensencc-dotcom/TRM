import { PppExclusionRow } from '../types';

export const SAMPLE_EXCLUSION_ROWS: PppExclusionRow[] = [
  {
    defendant: 'JOHN DOE',
    entities: 'ACME LOGISTICS LLC, APEX GLOBAL INC',
    city: 'HOUSTON',
    district: 'SDTX',
    status: 'Charged',
    release_date: '2021-04-15',
    url: 'https://www.justice.gov/usao-sdtx/pr/sample-release-1',
  },
  {
    defendant: 'JANE SMITH',
    entities: 'NORTH TEXAS HEALTHCARE PARTNERS CO',
    city: 'DALLAS',
    district: 'NDTX',
    status: 'Charged',
    release_date: '2022-08-10',
    url: 'https://www.justice.gov/usao-ndtx/pr/sample-release-2',
  },
  {
    defendant: 'CARLOS RODRIGUEZ',
    entities: 'RIO GRANDE IMPORTS DBA BORDER CARGO',
    city: 'SAN ANTONIO',
    district: 'WDTX',
    status: 'Charged',
    release_date: '2023-01-20',
    url: 'https://www.justice.gov/usao-wdtx/pr/sample-release-3',
  },
];
