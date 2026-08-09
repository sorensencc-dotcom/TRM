import * as fs from 'node:fs';
import * as path from 'node:path';
import { nodeDir } from './paths';
import { writeFileAtomic } from './atomicWrite';
import { KeywordSource } from './videoPartialProgress';

export interface VideoFailureOptions {
  startMs?: number;
  endMs?: number;
  keywords?: string[];
  keywordSource?: KeywordSource;
}

export interface FailedEntry {
  hash: string;
  sourcePath: string;
  error: string;
  timestamp: string;
  videoOptions?: VideoFailureOptions;
}

interface FailedFile {
  entries: Record<string, FailedEntry>;
}

function extractsDir(root: string, topicPath: string): string {
  return path.join(nodeDir(root, topicPath), 'extracts');
}

function failedPath(root: string, topicPath: string): string {
  return path.join(extractsDir(root, topicPath), 'failed.json');
}

function readFailedFile(root: string, topicPath: string): FailedFile {
  const file = failedPath(root, topicPath);
  if (!fs.existsSync(file)) return { entries: {} };
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

export function appendFailure(
  root: string,
  topicPath: string,
  hash: string,
  sourcePath: string,
  error: string,
  videoOptions?: VideoFailureOptions
): void {
  const failedFile = readFailedFile(root, topicPath);
  failedFile.entries[hash] = {
    hash,
    sourcePath,
    error,
    timestamp: new Date().toISOString(),
    ...(videoOptions ? { videoOptions } : {}),
  };
  writeFileAtomic(failedPath(root, topicPath), JSON.stringify(failedFile, null, 2));
}

export function readFailed(root: string, topicPath: string): FailedEntry[] {
  return Object.values(readFailedFile(root, topicPath).entries);
}

export function clearFailure(root: string, topicPath: string, hash: string): void {
  const failedFile = readFailedFile(root, topicPath);
  if (!(hash in failedFile.entries)) return;
  delete failedFile.entries[hash];
  writeFileAtomic(failedPath(root, topicPath), JSON.stringify(failedFile, null, 2));
}
