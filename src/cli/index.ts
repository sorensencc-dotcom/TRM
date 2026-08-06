#!/usr/bin/env node
import { Command } from 'commander';
import { runCreate } from './commands/create';
import { runIngest } from './commands/ingest';
import { runIngestDir } from './commands/ingestDir';
import { runExtract } from './commands/extract';
import { runScore } from './commands/score';
import { runCrosslink } from './commands/crosslink';
import { runVersionBump } from './commands/versionBump';
import { runValidate } from './commands/validate';
import { runFeedbackStats } from './commands/feedbackStats';
import { runReport } from './commands/report';
import { runSyncTreatment } from './commands/syncTreatment';
import { runTriageIntake } from './commands/triageIntake';
import { runRouteIntake } from './commands/routeIntake';
import { assertSafeRoot } from '../core/rootSafety';
import { LockConflictError, LockUnrecoverableError } from '../sync/lock';

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
  .command('ingest <path> [url]')
  .requiredOption('--type <type>')
  .requiredOption('--title <title>')
  .requiredOption('--origin <origin>')
  .option('--actor <actor>')
  .option('--file <file>', 'source file: .txt, .md, .docx, .pdf, .epub, or image (.jpg, .jpeg, .png, .webp, .gif, .heic)')
  .option('--dry-run')
  .action(async (path, url, opts) => {
    const entry = await runIngest(root, path, { ...opts, url, file: opts.file, dryRun: opts.dryRun });
    console.log(entry ? JSON.stringify(entry, null, 2) : '(dry-run, nothing written)');
  });

program
  .command('ingest-dir <path>')
  .option('--actor <actor>')
  .option('--type <type>')
  .option('--title <title>')
  .option('--origin <origin>')
  .option('--dir <dir>')
  .option('--kind <kind>')
  .option('--force')
  .option('--retry-failed')
  .option('--stub')
  .action(async (path, opts) => {
    const summary = await runIngestDir(root, path, opts);
    console.log(JSON.stringify(summary, null, 2));
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
  .option('--tags <tags>', 'comma-separated', (v) => v.split(','))
  .action((path, opts) => {
    runCrosslink(root, path, {
      actor: opts.actor,
      relatedTopic: opts.relatedTopic,
      relationship: opts.relationship,
      treatmentSections: opts.treatmentSections,
      promotionReason: opts.promotionReason,
      tags: opts.tags,
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

program
  .command('feedback-stats <path>')
  .option('--recursive')
  .option('--latency-budget-ms <ms>', 'override the OCR latency budget in ms (default 90000)', (v) => Number(v))
  .action((path, opts) => {
    const stats = runFeedbackStats(root, path, { recursive: opts.recursive, latencyBudgetMs: opts.latencyBudgetMs });
    console.log(JSON.stringify(stats, null, 2));
  });

program
  .command('sync-treatment [topic]')
  .requiredOption('--narrative-root <path>', 'path to the charlie-deep-research narrative repo')
  .option('--vault-root <path>', 'defaults to the current working directory, same as every other trm command')
  .option('--dependency-map <path>', 'defaults to <narrative-root>/treatment/CIC_SOURCING_DEPENDENCY_MAP_v1.json')
  .option('--dry-run')
  .option('--force-recover-lock')
  .action((topic, opts) => {
    const vaultRoot = opts.vaultRoot ?? root;
    try {
      const result = runSyncTreatment({
        vaultRoot,
        narrativeRoot: opts.narrativeRoot,
        dependencyMapPath: opts.dependencyMap,
        topic,
        dryRun: opts.dryRun,
        forceRecoverLock: opts.forceRecoverLock,
      });
      console.log(result.reportPath);
      console.log(`new facts / skipped topics reported — see ${result.reportPath}`);
      for (const line of result.stderr) console.error(line);
      process.exitCode = result.exitCode;
    } catch (err) {
      if (err instanceof LockConflictError || err instanceof LockUnrecoverableError) {
        console.error(err.message);
        process.exitCode = 1;
      } else {
        throw err;
      }
    }
  });

program
  .command('triage-intake')
  .option('--dir <dir>', 'scope to one batch, e.g. intake/benson-ford')
  .action(async (opts) => {
    const summary = await runTriageIntake(root, opts);
    console.log(JSON.stringify(summary, null, 2));
  });

program
  .command('route-intake')
  .option('--apply', 'stage matched files into per-topic staging directories; default is a dry-run report only')
  .option('--config <path>', 'override the default config/topic-routing.json')
  .action(async (opts) => {
    try {
      const summary = await runRouteIntake(root, { apply: opts.apply, configPath: opts.config });
      console.log(JSON.stringify(summary, null, 2));
      if (summary.runStatus !== 'completed') process.exitCode = 1;
    } catch (err) {
      if (err instanceof LockConflictError || err instanceof LockUnrecoverableError) {
        console.error(err.message);
        process.exitCode = 1;
      } else {
        throw err;
      }
    }
  });

program.parse();
