import * as fs from 'node:fs';
import * as path from 'node:path';

function tempPathFor(file: string): string {
  return `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function writeFileAtomic(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tempPathFor(file);
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

export function writeFileExclusive(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tempPathFor(file);
  fs.writeFileSync(tmp, contents);
  try {
    fs.linkSync(tmp, file);
  } finally {
    fs.unlinkSync(tmp);
  }
}
