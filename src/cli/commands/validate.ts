import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { nodeDir } from '../../core/paths';
import { readTopicMeta } from '../../core/topicNode';
import { readLineage, validateChain } from '../../lineage/hasher';
import { validateAgainstSchema, SchemaName } from '../../schemas/validator';

export type ValidationIssueType = 'schema_error' | 'lineage_error' | 'hand_edited' | 'mock_source';

export interface ValidationIssue {
  type: ValidationIssueType;
  message: string;
}

export interface ValidationReport {
  path: string;
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

function checkSchema(root: string, topicPath: string, file: string, schema: SchemaName, errors: ValidationIssue[]): void {
  const filePath = path.join(nodeDir(root, topicPath), file);
  if (!fs.existsSync(filePath)) return;
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const result = validateAgainstSchema(schema, data);
  if (!result.valid) {
    errors.push({ type: 'schema_error', message: `${file}: ${result.errors.join('; ')}` });
  }
}

function checkScoreNotHandEdited(root: string, topicPath: string, errors: ValidationIssue[]): void {
  const scorePath = path.join(nodeDir(root, topicPath), 'extracts', 'score.json');
  if (!fs.existsSync(scorePath)) return;
  const lineage = readLineage(root, topicPath);
  const lastScoreOp = [...lineage.operations].reverse().find((op) => op.op === 'SCORE');
  if (!lastScoreOp) {
    errors.push({ type: 'hand_edited', message: 'score.json exists but no SCORE lineage operation was recorded' });
    return;
  }
  const scoreContent = JSON.parse(fs.readFileSync(scorePath, 'utf-8'));
  const expectedHash = crypto.createHash('sha256').update(JSON.stringify(scoreContent.scores)).digest('hex');
  const recordedHash = lastScoreOp.content_hash;
  if (recordedHash && recordedHash !== expectedHash) {
    errors.push({ type: 'hand_edited', message: 'score.json contents do not match the hash recorded at the last SCORE operation — hand-edited' });
  }
}

function checkMockImageSources(root: string, topicPath: string, warnings: ValidationIssue[]): void {
  const rawDir = path.join(nodeDir(root, topicPath), 'sources', 'raw');
  if (!fs.existsSync(rawDir)) return;
  for (const file of fs.readdirSync(rawDir)) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(rawDir, file);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (data.mock === true) {
      const sourceId = path.basename(file, '.json');
      warnings.push({ type: 'mock_source', message: `${sourceId} is mock image-extraction data, not a verified fact source` });
    }
  }
}

function validateNode(root: string, topicPath: string): ValidationReport {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  readTopicMeta(root, topicPath); // throws if node missing

  checkSchema(root, topicPath, 'topic.json', 'topic', errors);
  checkSchema(root, topicPath, path.join('sources', 'metadata.json'), 'metadata', errors);
  checkSchema(root, topicPath, path.join('extracts', 'extract.json'), 'extract', errors);
  checkSchema(root, topicPath, path.join('extracts', 'score.json'), 'score', errors);
  checkSchema(root, topicPath, path.join('crosslinks', 'related_topics.json'), 'related_topics', errors);

  const chainResult = validateChain(root, topicPath);
  if (!chainResult.valid) errors.push({ type: 'lineage_error', message: `lineage: ${chainResult.error}` });

  checkScoreNotHandEdited(root, topicPath, errors);
  checkMockImageSources(root, topicPath, warnings);

  return { path: topicPath, valid: errors.length === 0, errors, warnings };
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
