import * as fs from 'node:fs';
import * as path from 'node:path';
import { nodeDir } from './paths';
import { markActive } from './topicNode';
import { appendOperation } from '../lineage/hasher';

export interface SourceEntry {
  id: string;
  type: string;
  title: string;
  origin: string;
  url: string;
  added_at: string;
  actor: string;
}

function metadataPath(root: string, topicPath: string): string {
  return path.join(nodeDir(root, topicPath), 'sources', 'metadata.json');
}

function readMetadata(root: string, topicPath: string): { sources: SourceEntry[] } {
  const file = metadataPath(root, topicPath);
  if (!fs.existsSync(file)) return { sources: [] };
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

export function addSource(
  root: string,
  topicPath: string,
  actor: string,
  entry: Omit<SourceEntry, 'id' | 'added_at' | 'actor'>
): SourceEntry {
  const metadata = readMetadata(root, topicPath);
  const id = `SRC-${String(metadata.sources.length + 1).padStart(3, '0')}`;
  const now = new Date().toISOString();
  const fullEntry: SourceEntry = { ...entry, id, added_at: now, actor };
  metadata.sources.push(fullEntry);
  const file = metadataPath(root, topicPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(metadata, null, 2));
  appendOperation(root, topicPath, { op: 'INGEST', actor, timestamp: now, source_id: id }, { source_id: id });
  markActive(root, topicPath, actor);
  return fullEntry;
}
