import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { nodeDir } from '../../core/paths';
import { readTopicMeta } from '../../core/topicNode';
import { loadConfig } from '../../core/config';
import { Fact, ScoreResult, ScoringAdapter } from '../../scoring/types';
import { stubAdapter } from '../../scoring/adapters/stub';
import { validateAgainstSchema } from '../../schemas/validator';
import { appendOperation } from '../../lineage/hasher';
import { resolveActor } from '../../registry/actorRegistry';

function readFacts(root: string, topicPath: string): Fact[] {
  const file = path.join(nodeDir(root, topicPath), 'extracts', 'extract.json');
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf-8')).facts;
}

function readScores(root: string, topicPath: string): ScoreResult[] {
  const file = path.join(nodeDir(root, topicPath), 'extracts', 'score.json');
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf-8')).scores;
}

export function runScore(
  root: string,
  topicPath: string,
  cliArgs: { actor?: string; dryRun?: boolean; rollup?: boolean },
  adapter: ScoringAdapter = stubAdapter
): { scores: ScoreResult[]; rolledUpFrom?: string[] } | null {
  const actor = resolveActor(root, cliArgs.actor);
  const meta = readTopicMeta(root, topicPath);
  const config = loadConfig(root);

  if (cliArgs.rollup) {
    const rolledUpFrom: string[] = [];
    const scores: ScoreResult[] = [];
    const walk = (childPath: string) => {
      const childMeta = readTopicMeta(root, childPath);
      scores.push(...readScores(root, childPath));
      if (readScores(root, childPath).length > 0) rolledUpFrom.push(childPath);
      for (const child of childMeta.children) {
        walk(`${childPath}/${child}`);
      }
    };
    for (const child of meta.children) {
      walk(`${topicPath}/${child}`);
    }
    return { scores, rolledUpFrom };
  }

  const facts = readFacts(root, topicPath);
  const scores = adapter.score(facts, meta, config);

  const validation = validateAgainstSchema('score', { scores });
  if (!validation.valid) {
    throw new Error(`ScoringAdapter produced invalid score.json: ${validation.errors.join('; ')}`);
  }

  if (cliArgs.dryRun) return { scores };

  const dir = path.join(nodeDir(root, topicPath), 'extracts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'score.json'), JSON.stringify({ scores }, null, 2));

  const now = new Date().toISOString();
  const contentHash = crypto.createHash('sha256').update(JSON.stringify(scores)).digest('hex');
  appendOperation(
    root,
    topicPath,
    { op: 'SCORE', actor, timestamp: now, score_count: scores.length, content_hash: contentHash },
    { score_count: scores.length, content_hash: contentHash }
  );

  return { scores };
}
