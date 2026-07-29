import * as path from 'node:path';
import { writeFileExclusive } from '../core/atomicWrite';
import { MatchResult } from './matching';

export interface TopicFactReport {
  topic: string;
  factKey: string;
  displayId: string;
  sourceId: string;
  factConfidence: number;
  text: string;
  matches: MatchResult[];
}

export interface SkippedTopic {
  topic: string;
  reason: string;
}

export interface CursorResetNote {
  topic: string;
  cursorPath: string;
  reason: string;
}

export interface ReportInput {
  scope: string;
  runId: string;
  runAt: string;
  vaultSnapshot: Record<string, string>;
  matchVersion: number;
  matchConfigVersion: number;
  cursorVersion: number;
  dryRun: boolean;
  factKeyCollisions: number;
  topicsProcessed: string[];
  topicsSkipped: SkippedTopic[];
  cursorResets: CursorResetNote[];
  newFacts: TopicFactReport[];
}

function timestampSlug(isoTimestamp: string): string {
  return isoTimestamp.replace(/[-:]/g, '').replace(/(\.\d+)?Z$/, '');
}

export function reportFileName(scope: string, runId: string, runAt: string, dryRun: boolean): string {
  const stamp = timestampSlug(runAt);
  return dryRun
    ? `TRM_SYNC_REPORT_DRYRUN_${scope}_${stamp}_${runId}.md`
    : `TRM_SYNC_REPORT_${scope}_${stamp}_${runId}.md`;
}

function indentBlock(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

function escapeInline(text: string): string {
  return text.replace(/[|`]/g, '\\$&');
}

function yamlStringList(items: string[]): string {
  return `[${items.map((i) => JSON.stringify(i)).join(', ')}]`;
}

function buildFrontmatter(input: ReportInput): string {
  const vaultSnapshotLines = Object.entries(input.vaultSnapshot)
    .map(([topic, mtime]) => `  ${JSON.stringify(topic)}: ${JSON.stringify(mtime)}`)
    .join('\n');
  const topicsSkippedList = yamlStringList(input.topicsSkipped.map((s) => s.topic));

  return [
    '---',
    `topic: ${JSON.stringify(input.scope)}`,
    `runId: ${input.runId}`,
    `runAt: ${input.runAt}`,
    'vaultSnapshot:',
    vaultSnapshotLines || '  {}',
    `matchVersion: ${input.matchVersion}`,
    `matchConfigVersion: ${input.matchConfigVersion}`,
    `cursorVersion: ${input.cursorVersion}`,
    `partialRun: ${input.topicsSkipped.length > 0}`,
    `dryRun: ${input.dryRun}`,
    `factKeyCollisions: ${input.factKeyCollisions}`,
    `topicsProcessed: ${yamlStringList(input.topicsProcessed)}`,
    `topicsSkipped: ${topicsSkippedList}`,
    '---',
    '',
  ].join('\n');
}

function buildSkippedTopicsSection(skipped: SkippedTopic[]): string {
  if (skipped.length === 0) return '';
  const lines = skipped.map((s) => `- \`${s.topic}\`: ${escapeInline(s.reason)}`);
  return ['## Skipped topics', '', ...lines, ''].join('\n');
}

function buildCursorResetSection(resets: CursorResetNote[]): string {
  if (resets.length === 0) return '';
  const lines = resets.map((r) => `- \`${r.topic}\` (\`${r.cursorPath}\`): ${escapeInline(r.reason)}`);
  return ['## Cursor resets', '', ...lines, ''].join('\n');
}

function buildFactBlock(fact: TopicFactReport, scope: string): string {
  const idLine = scope === 'all' ? `[${escapeInline(fact.topic)}] ${escapeInline(fact.displayId)}` : escapeInline(fact.displayId);
  const lines = [
    idLine,
    `Source: ${escapeInline(fact.sourceId)}`,
    `Fact confidence: ${fact.factConfidence}`,
    'Text:',
    indentBlock(fact.text),
  ];
  if (fact.matches.length === 0) {
    lines.push('Suggested matches: unmatched');
  } else {
    lines.push('Suggested matches:');
    for (const m of fact.matches) {
      lines.push(`  ${m.itemId} — match confidence: ${m.bucket} (score ${m.score})`);
    }
  }
  return lines.join('\n');
}

function buildFactSection(input: ReportInput): string {
  if (input.newFacts.length === 0) return 'No new facts detected.';
  const sorted = [...input.newFacts].sort((a, b) =>
    a.sourceId !== b.sourceId ? a.sourceId.localeCompare(b.sourceId) : a.factKey.localeCompare(b.factKey)
  );
  return sorted.map((f) => buildFactBlock(f, input.scope)).join('\n\n');
}

function buildSummarySection(input: ReportInput): string {
  const byTopic: Record<string, number> = {};
  for (const f of input.newFacts) byTopic[f.topic] = (byTopic[f.topic] ?? 0) + 1;
  const lines = Object.entries(byTopic).map(([topic, count]) => `- ${topic}: ${count} new fact(s)`);
  return ['## Summary', '', `Total new facts: ${input.newFacts.length}`, ...lines].join('\n');
}

export function buildReportMarkdown(input: ReportInput): string {
  const sections = [
    buildFrontmatter(input),
    buildSkippedTopicsSection(input.topicsSkipped),
    buildCursorResetSection(input.cursorResets),
    buildFactSection(input),
    '',
    buildSummarySection(input),
  ].filter((s) => s !== '');
  return sections.join('\n');
}

export function writeReport(narrativeTreatmentDir: string, input: ReportInput): string {
  const fileName = reportFileName(input.scope, input.runId, input.runAt, input.dryRun);
  const filePath = path.join(narrativeTreatmentDir, fileName);
  writeFileExclusive(filePath, buildReportMarkdown(input));
  return filePath;
}
