import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { nodeDir } from '../../core/paths';
import { readTopicMeta } from '../../core/topicNode';
import { readLineage, validateChain } from '../../lineage/hasher';
import { validateAgainstSchema, SchemaName } from '../../schemas/validator';

export interface ValidationReport {
  path: string;
  valid: boolean;
  errors: string[];
}

function checkSchema(root: string, topicPath: string, file: string, schema: SchemaName, errors: string[]): void {
  const filePath = path.join(nodeDir(root, topicPath), file);
  if (!fs.existsSync(filePath)) return;
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const result = validateAgainstSchema(schema, data);
  if (!result.valid) {
    errors.push(`${file}: ${result.errors.join('; ')}`);
  }
}

function checkScoreNotHandEdited(root: string, topicPath: string, errors: string[]): void {
  const scorePath = path.join(nodeDir(root, topicPath), 'extracts', 'score.json');
  if (!fs.existsSync(scorePath)) return;
  const lineage = readLineage(root, topicPath);
  const lastScoreOp = [...lineage.operations].reverse().find((op) => op.op === 'SCORE');
  if (!lastScoreOp) {
    errors.push('score.json exists but no SCORE lineage operation was recorded');
    return;
  }
  const scoreContent = JSON.parse(fs.readFileSync(scorePath, 'utf-8'));
  const expectedHash = crypto.createHash('sha256').update(JSON.stringify(scoreContent.scores)).digest('hex');
  const recordedHash = lastScoreOp.content_hash;
  if (recordedHash && recordedHash !== expectedHash) {
    errors.push('score.json contents do not match the hash recorded at the last SCORE operation — hand-edited');
  }
}

function validateNode(root: string, topicPath: string): ValidationReport {
  const errors: string[] = [];
  readTopicMeta(root, topicPath); // throws if node missing

  checkSchema(root, topicPath, 'topic.json', 'topic', errors);
  checkSchema(root, topicPath, path.join('sources', 'metadata.json'), 'metadata', errors);
  checkSchema(root, topicPath, path.join('extracts', 'extract.json'), 'extract', errors);
  checkSchema(root, topicPath, path.join('extracts', 'score.json'), 'score', errors);
  checkSchema(root, topicPath, path.join('crosslinks', 'related_topics.json'), 'related_topics', errors);

  const chainResult = validateChain(root, topicPath);
  if (!chainResult.valid) errors.push(`lineage: ${chainResult.error}`);

  checkScoreNotHandEdited(root, topicPath, errors);

  return { path: topicPath, valid: errors.length === 0, errors };
}

export function runValidate(root: string, topicPath: string, cliArgs: { recursive?: boolean }): ValidationReport[] {
  const reports: ValidationReport[] = [validateNode(root, topicPath)];
  if (cliArgs.recursive) {
    const meta = readTopicMeta(root, topicPath);
    for (const child of meta.children) {
      reports.push(...runValidate(root, `${topicPath}/${child}`, cliArgs));
    }
  }
  return reports;
}
