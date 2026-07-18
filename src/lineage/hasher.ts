import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { nodeDir } from '../core/paths';

export interface LineageOp {
  id: string;
  op: string;
  hash: string;
  actor: string;
  timestamp: string;
  [key: string]: unknown;
}

export interface LineageFile {
  topic: string;
  hash: string;
  operations: LineageOp[];
}

const GENESIS = 'GENESIS';

function lineagePath(root: string, topicPath: string): string {
  return path.join(nodeDir(root, topicPath), 'lineage', 'lineage.json');
}

function computeHash(prevHash: string, payload: unknown): string {
  const canonical = JSON.stringify(payload, Object.keys(payload as object).sort());
  return crypto.createHash('sha256').update(prevHash + canonical).digest('hex');
}

export function readLineage(root: string, topicPath: string): LineageFile {
  const file = lineagePath(root, topicPath);
  if (!fs.existsSync(file)) {
    const leaf = topicPath.split('/').pop() ?? topicPath;
    return { topic: leaf, hash: GENESIS, operations: [] };
  }
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

export function appendOperation(
  root: string,
  topicPath: string,
  op: { op: string; actor: string; timestamp: string; [key: string]: unknown },
  payload: unknown
): LineageOp {
  const lineage = readLineage(root, topicPath);
  const opId = `OP-${String(lineage.operations.length + 1).padStart(4, '0')}`;
  const hash = computeHash(lineage.hash, payload);
  const fullOp: LineageOp = { ...op, id: opId, hash };
  lineage.operations.push(fullOp);
  lineage.hash = hash;
  const file = lineagePath(root, topicPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(lineage, null, 2));
  return fullOp;
}

export function validateChain(root: string, topicPath: string): { valid: boolean; error?: string } {
  const lineage = readLineage(root, topicPath);
  let prevHash = GENESIS;
  for (const op of lineage.operations) {
    const { id, hash, op: opName, actor, timestamp, ...payload } = op;
    const expected = computeHash(prevHash, payload);
    if (expected !== hash) {
      return { valid: false, error: `chain broken at ${id}: expected hash ${expected}, found ${hash}` };
    }
    prevHash = hash;
  }
  if (prevHash !== lineage.hash) {
    return { valid: false, error: `stored top-level hash does not match last operation hash` };
  }
  return { valid: true };
}
