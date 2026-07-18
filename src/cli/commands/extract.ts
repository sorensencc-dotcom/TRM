import * as fs from 'node:fs';
import * as path from 'node:path';
import { nodeDir } from '../../core/paths';
import { readTopicMeta } from '../../core/topicNode';
import { Fact } from '../../scoring/types';
import { ExtractionRunner } from '../../extraction/types';
import { stubRunner } from '../../extraction/stubRunner';
import { claudeCodeRunner } from '../../extraction/claudeCodeRunner';
import { resolveActor } from '../../registry/actorRegistry';
import { appendOperation } from '../../lineage/hasher';

interface SourceMetadata {
  sources: { id: string }[];
}

export function runExtract(
  root: string,
  topicPath: string,
  cliArgs: { actor?: string; dryRun?: boolean; stub?: boolean },
  runnerOverride?: ExtractionRunner
): { facts: Fact[]; summary: string } | null {
  const runner = runnerOverride ?? (cliArgs.stub ? stubRunner : claudeCodeRunner);
  const actor = resolveActor(root, cliArgs.actor);
  readTopicMeta(root, topicPath); // throws if node doesn't exist
  const dir = nodeDir(root, topicPath);
  const metadataPath = path.join(dir, 'sources', 'metadata.json');
  const metadata: SourceMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));

  const collectedFacts: Fact[] = [];
  const summaries: string[] = [];
  for (const source of metadata.sources) {
    const rawFile = path.join(dir, 'sources', 'raw', `${source.id}.txt`);
    if (!fs.existsSync(rawFile)) continue;
    const rawText = fs.readFileSync(rawFile, 'utf-8');
    const sourceMeta = JSON.parse(fs.readFileSync(metadataPath, 'utf-8')).sources.find((s: any) => s.id === source.id);
    const { facts, summary } = runner.run(sourceMeta, rawText);
    collectedFacts.push(...facts);
    summaries.push(summary);
  }

  // Each runner numbers facts FCT-001.. independently per source (it has no
  // visibility into other sources in this pass), so ids collide once concatenated
  // across sources. Renumber globally, sequentially, in source order.
  const allFacts: Fact[] = collectedFacts.map((fact, i) => ({
    ...fact,
    id: `FCT-${String(i + 1).padStart(3, '0')}`,
  }));

  if (cliArgs.dryRun) return null;

  const extractsDir = path.join(dir, 'extracts');
  fs.mkdirSync(extractsDir, { recursive: true });
  fs.writeFileSync(path.join(extractsDir, 'extract.json'), JSON.stringify({ facts: allFacts }, null, 2));
  fs.writeFileSync(path.join(extractsDir, 'summary.md'), summaries.join('\n\n'));

  const now = new Date().toISOString();
  appendOperation(
    root,
    topicPath,
    { op: 'EXTRACT', actor, timestamp: now, fact_count: allFacts.length },
    { fact_count: allFacts.length }
  );

  return { facts: allFacts, summary: summaries.join('\n\n') };
}
