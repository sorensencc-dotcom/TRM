import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildReportMarkdown, reportFileName, writeReport, ReportInput } from '../../src/sync/reportWriter';

function baseInput(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    scope: 'willow-run',
    runId: 'abc-123',
    runAt: '2026-07-28T18:00:00.000Z',
    vaultSnapshot: { 'willow-run': '2026-07-28T17:00:00.000Z' },
    matchVersion: 1,
    matchConfigVersion: 1,
    cursorVersion: 1,
    dryRun: false,
    factKeyCollisions: 0,
    topicsProcessed: ['willow-run'],
    topicsSkipped: [],
    cursorResets: [],
    newFacts: [],
    ...overrides,
  };
}

describe('reportFileName', () => {
  it('embeds scope, timestamp, and runId', () => {
    const name = reportFileName('willow-run', 'abc-123', '2026-07-28T18:00:00.000Z', false);
    expect(name).toBe('TRM_SYNC_REPORT_willow-run_20260728T180000_abc-123.md');
  });

  it('adds a DRYRUN infix when dryRun is true', () => {
    const name = reportFileName('willow-run', 'abc-123', '2026-07-28T18:00:00.000Z', true);
    expect(name).toBe('TRM_SYNC_REPORT_DRYRUN_willow-run_20260728T180000_abc-123.md');
  });
});

describe('buildReportMarkdown', () => {
  it('includes frontmatter with all required fields', () => {
    const md = buildReportMarkdown(baseInput());
    expect(md).toMatch(/^---\n/);
    expect(md).toMatch(/topic: "willow-run"/);
    expect(md).toMatch(/runId: abc-123/);
    expect(md).toMatch(/matchVersion: 1/);
    expect(md).toMatch(/partialRun: false/);
  });

  it('sets partialRun true when topicsSkipped is non-empty', () => {
    const md = buildReportMarkdown(baseInput({ topicsSkipped: [{ topic: 'cuba', reason: 'missing extracts/extract.json' }] }));
    expect(md).toMatch(/partialRun: true/);
  });

  it('renders a Skipped topics section when topics were skipped', () => {
    const md = buildReportMarkdown(baseInput({ topicsSkipped: [{ topic: 'cuba', reason: 'missing extracts/extract.json' }] }));
    expect(md).toMatch(/## Skipped topics/);
    expect(md).toMatch(/cuba.*missing extracts\/extract\.json/);
  });

  it('says "No new facts detected." when there are no new facts', () => {
    const md = buildReportMarkdown(baseInput());
    expect(md).toMatch(/No new facts detected\./);
  });

  it('renders each new fact with fact confidence and match confidence clearly labeled and distinct', () => {
    const md = buildReportMarkdown(
      baseInput({
        newFacts: [
          {
            topic: 'willow-run',
            factKey: 'deadbeef',
            displayId: 'FCT-014',
            sourceId: 'SRC-001',
            factConfidence: 0.85,
            text: 'Sorensen visits Willow Run.',
            matches: [{ itemId: 'V-5.3', score: 0.72, bucket: 'high' }],
          },
        ],
      })
    );
    expect(md).toMatch(/Fact confidence: 0\.85/);
    expect(md).toMatch(/match confidence: high/);
    expect(md).toMatch(/V-5\.3/);
  });

  it('says "unmatched" when a fact has no matches', () => {
    const md = buildReportMarkdown(
      baseInput({
        newFacts: [
          {
            topic: 'willow-run',
            factKey: 'deadbeef',
            displayId: 'FCT-014',
            sourceId: 'SRC-001',
            factConfidence: 0.85,
            text: 'Some unrelated fact.',
            matches: [],
          },
        ],
      })
    );
    expect(md).toMatch(/unmatched/);
  });

  it('indents fact text 4 spaces instead of using a fence, so markdown-special characters render safely', () => {
    const md = buildReportMarkdown(
      baseInput({
        newFacts: [
          {
            topic: 'willow-run',
            factKey: 'deadbeef',
            displayId: 'FCT-014',
            sourceId: 'SRC-001',
            factConfidence: 0.85,
            text: '--- # | ` this looks like frontmatter or a table',
            matches: [],
          },
        ],
      })
    );
    const lines = md.split('\n');
    const textLine = lines.find((l) => l.includes('this looks like frontmatter'));
    expect(textLine).toMatch(/^ {4}/);
  });

  it('prefixes fact topic in an all-scope report', () => {
    const md = buildReportMarkdown(
      baseInput({
        scope: 'all',
        newFacts: [
          {
            topic: 'willow-run',
            factKey: 'deadbeef',
            displayId: 'FCT-014',
            sourceId: 'SRC-001',
            factConfidence: 0.85,
            text: 'x',
            matches: [],
          },
        ],
      })
    );
    expect(md).toMatch(/\[willow-run\] FCT-014/);
  });

  it('safely escapes colons in scope field (YAML frontmatter round-trip)', () => {
    const colonTopic = 'weird: topic';
    const md = buildReportMarkdown(baseInput({ scope: colonTopic }));
    // Check that the scope appears quoted in frontmatter (JSON.stringify escaping)
    expect(md).toMatch(/topic: "weird: topic"/);
    // Verify frontmatter block is intact (not broken by colon)
    const frontmatterMatch = md.match(/^---\n([\s\S]*?)\n---/m);
    expect(frontmatterMatch).toBeTruthy();
    // The frontmatter should be parseable YAML (no unescaped colons breaking the structure)
    expect(frontmatterMatch![0]).toContain('topic: "weird: topic"');
  });

  it('safely escapes colons in vaultSnapshot keys (YAML round-trip)', () => {
    const colonTopic = 'vault: topic';
    const md = buildReportMarkdown(
      baseInput({
        vaultSnapshot: { [colonTopic]: '2026-07-28T17:00:00.000Z' },
        topicsProcessed: [colonTopic],
      })
    );
    // Check that the vault snapshot key appears quoted in YAML
    expect(md).toMatch(/vaultSnapshot:/);
    expect(md).toMatch(/"vault: topic": "/);
    // Verify frontmatter is still valid (not broken by unescaped colons)
    const frontmatterMatch = md.match(/^---\n([\s\S]*?)\n---/m);
    expect(frontmatterMatch).toBeTruthy();
  });

  it('escapes pipe and backtick in displayId, sourceId, and fact topic when all-scope', () => {
    const md = buildReportMarkdown(
      baseInput({
        scope: 'all',
        newFacts: [
          {
            topic: 'weird|topic',
            factKey: 'deadbeef',
            displayId: 'FCT|014',
            sourceId: 'SRC`001',
            factConfidence: 0.85,
            text: 'x',
            matches: [],
          },
        ],
      })
    );
    // Expect pipes and backticks to be escaped with backslashes in the fact block
    expect(md).toMatch(/\[weird\\|topic\] FCT\\|014/);
    expect(md).toMatch(/Source: SRC\\`001/);
  });
});

describe('writeReport', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-report-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes a report file and returns its path', () => {
    const reportPath = writeReport(dir, baseInput());
    expect(fs.existsSync(reportPath)).toBe(true);
    expect(path.dirname(reportPath)).toBe(dir);
  });

  it('never overwrites an existing report (distinct runId per call)', () => {
    const first = writeReport(dir, baseInput({ runId: 'run-a' }));
    const second = writeReport(dir, baseInput({ runId: 'run-b' }));
    expect(first).not.toBe(second);
    expect(fs.existsSync(first)).toBe(true);
    expect(fs.existsSync(second)).toBe(true);
  });
});
