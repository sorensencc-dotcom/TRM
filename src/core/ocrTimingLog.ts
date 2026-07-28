import * as fs from 'node:fs';
import * as path from 'node:path';

export interface OcrTimingEntry {
  schema_version: 1;
  topic: string;
  file: string;
  source_type: string;
  ms: number;
  retries: number;
  outcome: 'success' | 'failure';
  ts: string;
}

function ocrTimingPath(root: string): string {
  return path.join(root, '.trm-ops', 'ocr-timing.jsonl');
}

export function appendOcrTiming(root: string, entry: OcrTimingEntry): void {
  const file = ocrTimingPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

export function readOcrTiming(root: string): OcrTimingEntry[] {
  const file = ocrTimingPath(root);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}
