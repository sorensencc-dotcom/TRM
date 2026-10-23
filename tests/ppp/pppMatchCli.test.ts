import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runPppMatch } from '../../src/cli/commands/pppMatch';

describe('trm ppp-match CLI and runner', () => {
  let tmpDir: string;
  let loansCsv: string;
  let exclusionsCsv: string;
  let outJson: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-ppp-match-'));
    loansCsv = path.join(tmpDir, 'loans.csv');
    exclusionsCsv = path.join(tmpDir, 'exclusions.csv');
    outJson = path.join(tmpDir, 'results.json');

    fs.writeFileSync(
      loansCsv,
      [
        'LoanNumber,BorrowerName,BorrowerCity,BorrowerState,BorrowerZip,CurrentApprovalAmount,LoanStatus,DateApproved',
        '4491747703,CYBERSOLVE IT INC,CARROLLTON,TX,75006,295344,Charged Off,05/01/2020',
        '9990001112,WELDON GREER JR,HOUSTON,TX,77001,150000,Paid in Full,04/15/2020',
      ].join('\n'),
      'utf-8'
    );

    fs.writeFileSync(
      exclusionsCsv,
      [
        'defendant,entities,city,district,status,release_date,url',
        '"Weldon Greer, Jr.; Jarrod Durant Wilburn",,Houston,EDTX,charged,2026-09-14,https://www.justice.gov/example',
        'Kaylee Ree Lunn,"First Capital Bank (employer, victim); Prosperity Bank",Wichita Falls,NDTX,sentenced,2025-12-05,https://www.justice.gov/example2',
      ].join('\n'),
      'utf-8'
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs ingest and entity matching via runPppMatch and writes JSON output', async () => {
    const summary = await runPppMatch({
      loans: loansCsv,
      exclusions: exclusionsCsv,
      out: outJson,
    });

    expect(summary.loanCount).toBe(2);
    expect(summary.exclusionCount).toBe(2);
    expect(summary.matchCount).toBe(1);
    expect(summary.matches[0].borrowerName).toBe('WELDON GREER JR');
    expect(summary.matches[0].match.matchedOn).toBe('defendant');

    expect(fs.existsSync(outJson)).toBe(true);
    const written = JSON.parse(fs.readFileSync(outJson, 'utf-8'));
    expect(written.matchCount).toBe(1);
    expect(written.results).toHaveLength(2);
  });

  it('invokes trm ppp-match via commander CLI entrypoint', () => {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'npx.cmd' : 'npx';
    const stdout = execFileSync(
      cmd,
      [
        'ts-node',
        'src/cli/index.ts',
        'ppp-match',
        '--loans',
        loansCsv,
        '--exclusions',
        exclusionsCsv,
        '--out',
        outJson,
      ],
      {
        cwd: path.resolve(__dirname, '..', '..'),
        encoding: 'utf-8',
        shell: true,
      }
    );

    const parsed = JSON.parse(stdout);
    expect(parsed.loanCount).toBe(2);
    expect(parsed.matchCount).toBe(1);
    expect(fs.existsSync(outJson)).toBe(true);
  });
});
