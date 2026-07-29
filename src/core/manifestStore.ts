import * as fs from 'node:fs';
import * as path from 'node:path';
import { nodeDir } from './paths';
import { writeFileAtomic } from './atomicWrite';

export type ManifestStatus = 'done' | 'failed';

export interface ManifestEntry {
  hash: string;
  sourcePath: string;
  status: ManifestStatus;
  error?: string;
  timestamp: string;
}

export interface ManifestFile {
  entries: Record<string, ManifestEntry>;
}

function extractsDir(root: string, topicPath: string): string {
  return path.join(nodeDir(root, topicPath), 'extracts');
}

function manifestPath(root: string, topicPath: string): string {
  return path.join(extractsDir(root, topicPath), 'manifest.json');
}

function perHashPath(root: string, topicPath: string, hash: string): string {
  return path.join(extractsDir(root, topicPath), `${hash}.json`);
}

function readManifest(root: string, topicPath: string): ManifestFile {
  const file = manifestPath(root, topicPath);
  if (!fs.existsSync(file)) return { entries: {} };
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function writeManifestEntry(root: string, topicPath: string, entry: ManifestEntry): void {
  const manifest = readManifest(root, topicPath);
  manifest.entries[entry.hash] = entry;
  writeFileAtomic(manifestPath(root, topicPath), JSON.stringify(manifest, null, 2));
}

export function markDone(root: string, topicPath: string, hash: string, sourcePath: string): void {
  writeManifestEntry(root, topicPath, {
    hash,
    sourcePath,
    status: 'done',
    timestamp: new Date().toISOString(),
  });
}

export function markFailed(
  root: string,
  topicPath: string,
  hash: string,
  sourcePath: string,
  error: string
): void {
  writeManifestEntry(root, topicPath, {
    hash,
    sourcePath,
    status: 'failed',
    error,
    timestamp: new Date().toISOString(),
  });
}

export function isDone(root: string, topicPath: string, hash: string): boolean {
  const manifest = readManifest(root, topicPath);
  return manifest.entries[hash]?.status === 'done';
}

export function writeExtract(root: string, topicPath: string, hash: string, payload: unknown): void {
  writeFileAtomic(perHashPath(root, topicPath, hash), JSON.stringify(payload, null, 2));
}

export function readExtract<T = unknown>(root: string, topicPath: string, hash: string): T | null {
  const file = perHashPath(root, topicPath, hash);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

/** All hashes recorded in the manifest, regardless of status. Used by T10's regenerator. */
export function listEntries(root: string, topicPath: string): ManifestEntry[] {
  return Object.values(readManifest(root, topicPath).entries);
}
