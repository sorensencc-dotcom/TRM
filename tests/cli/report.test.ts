// C:\dev\trm\tests\cli\report.test.ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCreate } from '../../src/cli/commands/create';
import { runIngest } from '../../src/cli/commands/ingest';
import { runReport } from '../../src/cli/commands/report';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-report-cli-'));
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({ default_scoring_adapter: 'stub', promotion_threshold: 80, actor_source: 'cli-only', time_source: 'system' })
  );
  return root;
}

describe('runReport', () => {
  it('writes a bundle.json and .html file under reports/, named from the flattened slug', () => {
    const root = makeRoot();
    runCreate(root, 'charlie/cuba', { actor: 'ACTOR-001' });
    runIngest(root, 'charlie/cuba', { actor: 'ACTOR-001', type: 'pdf', title: 'Doc', origin: 'LOC', url: 'x' });

    const { bundlePath, htmlPath } = runReport(root, 'charlie/cuba', {});

    expect(fs.existsSync(bundlePath)).toBe(true);
    expect(fs.existsSync(htmlPath)).toBe(true);
    expect(path.basename(bundlePath)).toMatch(/^charlie-cuba-\d+-[0-9a-f]{4}\.json$/);
    expect(path.dirname(bundlePath)).toBe(path.join(root, 'reports'));

    const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf-8'));
    expect(bundle.topicPath).toBe('charlie/cuba');

    const html = fs.readFileSync(htmlPath, 'utf-8');
    expect(html).toContain('charlie/cuba');
  });

  it('creates the reports/ directory if it does not exist yet', () => {
    const root = makeRoot();
    runCreate(root, 'charlie/cuba', { actor: 'ACTOR-001' });
    expect(fs.existsSync(path.join(root, 'reports'))).toBe(false);
    runReport(root, 'charlie/cuba', {});
    expect(fs.existsSync(path.join(root, 'reports'))).toBe(true);
  });

  it('rejects an unsupported theme before touching the filesystem', () => {
    const root = makeRoot();
    runCreate(root, 'charlie/cuba', { actor: 'ACTOR-001' });
    expect(() => runReport(root, 'charlie/cuba', { theme: 'bogus' })).toThrow(/theme/i);
    expect(fs.existsSync(path.join(root, 'reports'))).toBe(false);
  });

  it('produces distinct filenames on two immediate successive calls', () => {
    const root = makeRoot();
    runCreate(root, 'charlie/cuba', { actor: 'ACTOR-001' });
    const first = runReport(root, 'charlie/cuba', {});
    const second = runReport(root, 'charlie/cuba', {});
    expect(first.htmlPath).not.toBe(second.htmlPath);
  });
});
