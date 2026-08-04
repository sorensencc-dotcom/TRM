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
  /**
   * Other source paths that hashed to this same canonical entry. Only ever
   * present on the canonical (isDup: false) record. A duplicate write never
   * overwrites the canonical entry -- it appends its sourcePath here instead
   * -- so a `!isDup` filter keeps one record per unique content hash without
   * losing the other paths that content lived at.
   */
  dupPaths?: string[];
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

export interface IntakeManifestSession {
  findByHash(hash: string): IntakeEntry | null;
  isDone(hash: string): boolean;
  write(entry: IntakeEntry): void;
  flush(): void;
}

/** Load once, mutate in memory, and atomically checkpoint on demand. */
export function openIntakeManifest(root: string): IntakeManifestSession {
  const manifest = readIntakeManifest(root);
  let dirty = false;

  return {
    findByHash(hash) {
      return manifest.entries[hash] ?? null;
    },
    isDone(hash) {
      return manifest.entries[hash]?.status === 'done';
    },
    write(entry) {
      const existing = manifest.entries[entry.hash];
      if (entry.isDup && existing) {
        const dupPaths = new Set(existing.dupPaths ?? []);
        dupPaths.add(entry.sourcePath);
        manifest.entries[entry.hash] = { ...existing, dupPaths: Array.from(dupPaths) };
      } else {
        manifest.entries[entry.hash] = entry;
      }
      dirty = true;
    },
    flush() {
      if (!dirty) return;
      writeFileAtomic(intakeManifestPath(root), JSON.stringify(manifest, null, 2));
      dirty = false;
    },
  };
}

export function writeIntakeEntry(root: string, entry: IntakeEntry): void {
  const session = openIntakeManifest(root);
  session.write(entry);
  session.flush();
}

export function isIntakeDone(root: string, hash: string): boolean {
  return readIntakeManifest(root).entries[hash]?.status === 'done';
}

export function findByHash(root: string, hash: string): IntakeEntry | null {
  return readIntakeManifest(root).entries[hash] ?? null;
}
