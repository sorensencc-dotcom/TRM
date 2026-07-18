import * as fs from 'node:fs';
import * as path from 'node:path';
import { nodeDir } from '../core/paths';

export function writeTreatmentLink(
  root: string,
  topicPath: string,
  link: { promoted_facts: string[]; promotion_reason: string; treatment_sections: string[] }
): void {
  const file = path.join(nodeDir(root, topicPath), 'crosslinks', 'treatment.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(link, null, 2));
}
