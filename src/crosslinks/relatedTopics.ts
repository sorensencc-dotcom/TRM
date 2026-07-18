import * as fs from 'node:fs';
import * as path from 'node:path';
import { nodeDir } from '../core/paths';

export function computeTagOverlapStrength(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter((t) => setB.has(t)).length;
  const union = new Set([...setA, ...setB]).size;
  return intersection / union;
}

export function writeRelatedTopic(
  root: string,
  topicPath: string,
  related: { topic: string; relationship: string; strength: number }
): void {
  const file = path.join(nodeDir(root, topicPath), 'crosslinks', 'related_topics.json');
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : { related: [] };
  existing.related.push(related);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(existing, null, 2));
}
