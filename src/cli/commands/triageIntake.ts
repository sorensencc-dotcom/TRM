import * as fs from 'node:fs';
import * as path from 'node:path';
import { hashFile } from '../../core/contentHash';
import { visionPool } from '../../core/concurrency';
import {
  IntakeEntry,
  IntakeType,
  writeIntakeEntry,
  isIntakeDone,
  findByHash,
} from '../../core/intakeManifest';
import { classifyImage } from '../../ingestion/imageExtract/classify';

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.json']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic']);

export interface TriageIntakeOptions {
  dir?: string; // relative to root, e.g. "intake/mfm"; omit to scan all of intake/
}

export interface TriageIntakeSummary {
  totalFiles: number;
  processedCount: number;
  skippedCount: number;
  dupCount: number;
  failedCount: number;
  byType: Record<string, number>;
}

function walkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) out.push(...walkFiles(full));
    else if (stat.isFile()) out.push(full);
  }
  return out;
}

function batchFor(root: string, filePath: string): string {
  const intakeDir = path.join(root, 'intake');
  const rel = path.relative(intakeDir, filePath);
  return rel.split(path.sep)[0];
}

export async function runTriageIntake(
  root: string,
  opts: TriageIntakeOptions
): Promise<TriageIntakeSummary> {
  const walkDir = opts.dir ? path.join(root, opts.dir) : path.join(root, 'intake');
  const files = walkFiles(walkDir);

  const summary: TriageIntakeSummary = {
    totalFiles: files.length,
    processedCount: 0,
    skippedCount: 0,
    dupCount: 0,
    failedCount: 0,
    byType: {},
  };

  for (const filePath of files) {
    const rel = path.relative(root, filePath).split(path.sep).join('/');
    const batch = batchFor(root, filePath);
    const ext = path.extname(filePath).toLowerCase();

    let hash: string;
    try {
      hash = await hashFile(filePath);
    } catch (err) {
      summary.failedCount++;
      continue;
    }

    if (isIntakeDone(root, hash)) {
      summary.skippedCount++;
      continue;
    }

    const existing = findByHash(root, hash);
    if (existing) {
      const entry: IntakeEntry = {
        ...existing,
        sourcePath: rel,
        batch,
        isDup: true,
        status: 'done',
        classifiedAt: new Date().toISOString(),
      };
      writeIntakeEntry(root, entry);
      summary.dupCount++;
      summary.byType[entry.classifiedType] = (summary.byType[entry.classifiedType] ?? 0) + 1;
      continue;
    }

    const sizeBytes = fs.statSync(filePath).size;
    const baseEntry = {
      hash,
      sourcePath: rel,
      batch,
      ext,
      sizeBytes,
      isDup: false,
      classifiedAt: new Date().toISOString(),
    };

    if (TEXT_EXTENSIONS.has(ext)) {
      writeIntakeEntry(root, {
        ...baseEntry,
        kind: 'text',
        classifiedType: 'text',
        status: 'done',
      });
      summary.processedCount++;
      summary.byType.text = (summary.byType.text ?? 0) + 1;
      continue;
    }

    if (IMAGE_EXTENSIONS.has(ext)) {
      try {
        const kind = await visionPool(() => classifyImage(filePath));
        const classifiedType: IntakeType = kind === 'text-doc' ? 'doc-photo' : 'exhibit-photo';
        writeIntakeEntry(root, {
          ...baseEntry,
          kind: 'image',
          classifiedType,
          status: 'done',
        });
        summary.processedCount++;
        summary.byType[classifiedType] = (summary.byType[classifiedType] ?? 0) + 1;
      } catch (err) {
        writeIntakeEntry(root, {
          ...baseEntry,
          kind: 'image',
          classifiedType: 'unsure',
          status: 'failed',
          error: (err as Error).message,
        });
        summary.failedCount++;
      }
      continue;
    }

    writeIntakeEntry(root, {
      ...baseEntry,
      kind: 'text',
      classifiedType: 'unsure',
      status: 'failed',
      error: 'unsupported extension',
    });
    summary.failedCount++;
  }

  return summary;
}
