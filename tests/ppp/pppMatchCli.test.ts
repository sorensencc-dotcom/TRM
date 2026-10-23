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
    expect(written.results).toBeUndefined();
    expect(written.matches).toBeUndefined();
  });

  it('groups matched loans by release with release metadata', async () => {
    const summary = await runPppMatch({ loans: loansCsv, exclusions: exclusionsCsv, out: outJson });
    expect(summary.releaseCount).toBe(1);
    const written = JSON.parse(fs.readFileSync(outJson, 'utf-8'));
    expect(written.releases).toHaveLength(1);
    const release = written.releases[0];
    expect(release).toMatchObject({
      defendant: 'Weldon Greer, Jr.; Jarrod Durant Wilburn',
      district: 'EDTX',
      status: 'charged',
      release_date: '2026-09-14',
      url: 'https://www.justice.gov/example',
    });
    expect(release.loans).toHaveLength(1);
    expect(release.loans[0].loanNumber).toBe('9990001112');
  });

  it('includes the full per-loan results array only with full', async () => {
    const summary = await runPppMatch({
      loans: loansCsv,
      exclusions: exclusionsCsv,
      out: outJson,
      full: true,
    });
    expect(summary.results).toHaveLength(2);
    const written = JSON.parse(fs.readFileSync(outJson, 'utf-8'));
    expect(written.results).toHaveLength(2);
  });

  it('adds per-match checks, confidence, reason and evidence', async () => {
    const summary = await runPppMatch({ loans: loansCsv, exclusions: exclusionsCsv });
    const checks = summary.releases[0].loans[0].checks;
    expect(checks.city_match).toBe(true);
    expect(checks.zip_match).toBeNull();
    expect(checks.approved_before_release).toBe(true);
    expect(checks.confidence).toBe('weak');
    expect(checks.reason).toMatch(/defendant/);
    expect(checks.evidence).toEqual({
      release_url: 'https://www.justice.gov/example',
      matched_value: 'Weldon Greer, Jr.',
      exclusion_entities: '',
      loan_number: '9990001112',
    });
  });

  it('rates entity matches on non-generic names strong and compares zip when present', async () => {
    fs.writeFileSync(
      loansCsv,
      [
        'LoanNumber,BorrowerName,BorrowerCity,BorrowerState,BorrowerZip,CurrentApprovalAmount,LoanStatus,DateApproved',
        '1,PROSPERITY BANK,Dallas,TX,75001,10,Paid in Full,2026-12-06',
      ].join('\n'),
      'utf-8'
    );
    fs.writeFileSync(
      exclusionsCsv,
      [
        'defendant,entities,city,district,status,release_date,url,zip',
        'Kaylee Ree Lunn,"First Capital Bank (employer, victim); Prosperity Bank",Wichita Falls;Dallas,NDTX,sentenced,2025-12-05,https://www.justice.gov/example2,76301;75001',
      ].join('\n'),
      'utf-8'
    );
    const summary = await runPppMatch({ loans: loansCsv, exclusions: exclusionsCsv });
    const checks = summary.releases[0].loans[0].checks;
    expect(checks.confidence).toBe('strong');
    expect(checks.city_match).toBe(true);
    expect(checks.zip_match).toBe(true);
    expect(checks.approved_before_release).toBe(false);
    expect(checks.evidence.exclusion_entities).toContain('Prosperity Bank');
    expect(checks.evidence.matched_value).toBe('Prosperity Bank');
  });

  it('writes matches.md next to the JSON output with one row per match', async () => {
    await runPppMatch({ loans: loansCsv, exclusions: exclusionsCsv, out: outJson });
    const md = fs.readFileSync(path.join(tmpDir, 'matches.md'), 'utf-8');
    const rows = md.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| ---'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Release');
    expect(rows[1]).toContain('9990001112');
    expect(rows[1]).toContain('150000');
    expect(rows[1]).toContain('Paid in Full');
    expect(rows[1]).toContain('weak');
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
