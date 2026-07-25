// scripts/migrate-raw-to-json.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RawSourceEnvelope } from '../src/core/rawSource';

function findRawDirs(topicsRoot: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(topicsRoot)) return results;

  function walk(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name === 'raw' && path.basename(dir) === 'sources') {
        results.push(full);
      } else {
        walk(full);
      }
    }
  }
  walk(topicsRoot);
  return results;
}

export function migrateRawToJson(vaultRoot: string): { migrated: string[]; skipped: string[] } {
  const migrated: string[] = [];
  const skipped: string[] = [];
  const topicsRoot = path.join(vaultRoot, 'topics');

  for (const rawDir of findRawDirs(topicsRoot)) {
    const files = fs.readdirSync(rawDir).filter((f) => f.endsWith('.txt'));
    for (const file of files) {
      const sourceId = path.basename(file, '.txt');
      const txtPath = path.join(rawDir, file);
      const jsonPath = path.join(rawDir, `${sourceId}.json`);

      if (fs.existsSync(jsonPath)) {
        skipped.push(txtPath);
        continue;
      }

      const text = fs.readFileSync(txtPath, 'utf-8');
      const stat = fs.statSync(txtPath);
      const envelope: RawSourceEnvelope = {
        sourceId,
        kind: 'text',
        capturedAt: stat.mtime.toISOString(),
        text,
      };
      fs.writeFileSync(jsonPath, JSON.stringify(envelope, null, 2));
      fs.unlinkSync(txtPath);
      migrated.push(jsonPath);
    }
  }

  return { migrated, skipped };
}

if (require.main === module) {
  const vaultRoot = process.argv[2];
  if (!vaultRoot) {
    console.error('usage: ts-node scripts/migrate-raw-to-json.ts <vaultRoot>');
    process.exit(1);
  }
  const result = migrateRawToJson(vaultRoot);
  console.log(`migrated ${result.migrated.length} file(s), skipped ${result.skipped.length} (already had .json)`);
  result.migrated.forEach((f) => console.log(`  + ${f}`));
  result.skipped.forEach((f) => console.log(`  ~ ${f} (already migrated)`));
}
