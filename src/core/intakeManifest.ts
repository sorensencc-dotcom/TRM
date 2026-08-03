import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomic } from './atomicWrite';

export type IntakeKind = 'image' | 'text' | 'unknown';
export type IntakeType = 'exhibit-photo' | 'doc-photo' | 'text' | 'junk' | 'unsure';
export type IntakeStatus = 'done' | 'failed';

export interface IntakeEntry {
  hash: string;
  sourcePath: string;
  batch: string;
  ext: string;
  sizeBytes: number;
  kind: IntakeKind;
  classifiedType: IntakeType;
  confidence?: number;
  isDup: boolean;
  status: IntakeStatus;
  error?: string;
  classifiedAt: string;
}

export interface IntakeManifestFile {
  entries: Record<string, IntakeEntry>;
}

export function intakeManifestPath(root: string): string {
  return path.join(root, 'intake-manifest.json');
}

export function readIntakeManifest(root: string): IntakeManifestFile {
  const file = intakeManifestPath(root);
  if (!fs.existsSync(file)) return { entries: {} };
  const raw = fs.readFileSync(file, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Intake manifest at ${file} is not valid JSON (${(err as Error).message}). ` +
        'Fix or delete the file to continue; deleting it restarts triage from scratch.'
    );
  }
}

export function writeIntakeEntry(root: string, entry: IntakeEntry): void {
  const manifest = readIntakeManifest(root);
  manifest.entries[entry.hash] = entry;
  writeFileAtomic(intakeManifestPath(root), JSON.stringify(manifest, null, 2));
}

export function isIntakeDone(root: string, hash: string): boolean {
  return readIntakeManifest(root).entries[hash]?.status === 'done';
}

export function findByHash(root: string, hash: string): IntakeEntry | null {
  return readIntakeManifest(root).entries[hash] ?? null;
}
