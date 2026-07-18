#!/usr/bin/env node
import { Command } from 'commander';
import { runCreate } from './commands/create';
import { runIngest } from './commands/ingest';
import { runExtract } from './commands/extract';
import { runScore } from './commands/score';
import { runCrosslink } from './commands/crosslink';
import { runVersionBump } from './commands/versionBump';
import { runValidate } from './commands/validate';
import { runReport } from './commands/report';
import { assertSafeRoot } from '../core/rootSafety';

const root = process.cwd();
assertSafeRoot(root);
const program = new Command();
program.name('trm').version('0.1.0');

program
  .command('create <path>')
  .option('--actor <actor>')
  .option('--description <description>')
  .option('--tags <tags>', 'comma-separated', (v) => v.split(','))
  .action((path, opts) => {
    const meta = runCreate(root, path, opts);
    console.log(JSON.stringify(meta, null, 2));
  });

program
  .command('ingest <path> <url>')
  .requiredOption('--type <type>')
  .requiredOption('--title <title>')
  .requiredOption('--origin <origin>')
  .option('--actor <actor>')
  .option('--dry-run')
  .action((path, url, opts) => {
    const entry = runIngest(root, path, { ...opts, url, dryRun: opts.dryRun });
    console.log(entry ? JSON.stringify(entry, null, 2) : '(dry-run, nothing written)');
  });

program
  .command('extract <path>')
  .option('--actor <actor>')
  .option('--dry-run')
  .option('--stub')
  .action((path, opts) => {
    const result = runExtract(root, path, { ...opts, dryRun: opts.dryRun, stub: opts.stub });
    console.log(result ? `${result.facts.length} fact(s) extracted` : '(dry-run)');
  });

program
  .command('report <path>')
  .option('--theme <theme>')
  .action((path, opts) => {
    const { bundlePath, htmlPath } = runReport(root, path, { theme: opts.theme });
    console.log(bundlePath);
    console.log(htmlPath);
  });

program
  .command('score <path>')
  .option('--actor <actor>')
  .option('--dry-run')
  .option('--rollup')
  .action((path, opts) => {
    const result = runScore(root, path, opts);
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('crosslink <path>')
  .option('--actor <actor>')
  .option('--related-topic <path>')
  .option('--relationship <text>')
  .option('--treatment-sections <sections>', 'comma-separated', (v) => v.split(','))
  .option('--promotion-reason <text>')
  .action((path, opts) => {
    runCrosslink(root, path, {
      actor: opts.actor,
      relatedTopic: opts.relatedTopic,
      relationship: opts.relationship,
      treatmentSections: opts.treatmentSections,
      promotionReason: opts.promotionReason,
    });
    console.log('crosslink written');
  });

program
  .command('version-bump <path> <bump>')
  .option('--actor <actor>')
  .action((path, bump, opts) => {
    const version = runVersionBump(root, path, bump, opts);
    console.log(version);
  });

program
  .command('validate <path>')
  .option('--recursive')
  .action((path, opts) => {
    const reports = runValidate(root, path, opts);
    console.log(JSON.stringify(reports, null, 2));
    if (reports.some((r) => !r.valid)) process.exitCode = 1;
  });

program.parse();
