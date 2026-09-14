import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomic } from '../core/atomicWrite';

export interface QuarantineEntry {
  hash: string;
  reason: string;
  first_seen_at: string;
  last_seen_at: string;
  attempts: number;
}

export interface ResearchQueueEntry {
  question_hash: string;
  question_text: string;
  question_id: string;
  gap_key: string;
  mode: 'fast' | 'deep';
  attempt_count: number;
  consecutive_dispatch_failures: number;
  last_researched_at: string | null;
  last_dispatch_error: string | null;
  status: 'PENDING' | 'EXECUTED' | 'STALLED_NEEDS_HUMAN' | 'INFRASTRUCTURE_BLOCKED';
}

export interface NotebookRegistryEntry {
  notebook_id: string;
  title: string;
  url: string;
  last_pulled_hashes: Record<string, string>;
  quarantined: Record<string, QuarantineEntry>;
  last_ingested_at: string | null;
  last_mined_at: string | null;
  last_mined_answer_keys: string[];
  research_queue?: Record<string, ResearchQueueEntry>;
}

export interface RegistryFile {
  version: 1;
  notebooks: NotebookRegistryEntry[];
}

export type ItemStatus = 'new' | 'unchanged' | 'changed' | 'quarantined-same' | 'quarantined-retry';

export function registryPath(root: string): string {
  return path.join(root, 'notebooklm-registry.json');
}

export function readRegistry(root: string): RegistryFile {
  const file = registryPath(root);
  if (!fs.existsSync(file)) return { version: 1, notebooks: [] };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as RegistryFile;
  for (const notebook of parsed.notebooks) {
    if (!notebook.research_queue) notebook.research_queue = {};
  }
  return parsed;
}

function writeRegistry(root: string, registry: RegistryFile): void {
  writeFileAtomic(registryPath(root), JSON.stringify(registry, null, 2));
}

export function findNotebook(registry: RegistryFile, notebookId: string): NotebookRegistryEntry | null {
  return registry.notebooks.find((n) => n.notebook_id === notebookId) ?? null;
}

export function sourceKey(sourceId: string): string {
  return `source:${sourceId}`;
}

export function noteKey(noteId: string): string {
  return `note:${noteId}`;
}

export function checkItem(entry: NotebookRegistryEntry, key: string, hash: string): ItemStatus {
  const quarantine = entry.quarantined[key];
  if (quarantine) {
    return quarantine.hash === hash ? 'quarantined-same' : 'quarantined-retry';
  }
  const pulled = entry.last_pulled_hashes[key];
  if (pulled === undefined) return 'new';
  return pulled === hash ? 'unchanged' : 'changed';
}

function mutateNotebook(
  root: string,
  notebookId: string,
  mutate: (entry: NotebookRegistryEntry) => void
): void {
  const registry = readRegistry(root);
  const entry = findNotebook(registry, notebookId);
  if (!entry) {
    throw new Error(
      `notebooklm-registry.json has no entry for notebook "${notebookId}" -- add it before running ingest/mine`
    );
  }
  mutate(entry);
  writeRegistry(root, registry);
}

export function flushPulledHash(root: string, notebookId: string, key: string, hash: string): void {
  mutateNotebook(root, notebookId, (entry) => {
    entry.last_pulled_hashes[key] = hash;
    delete entry.quarantined[key];
  });
}

export function flushQuarantine(
  root: string,
  notebookId: string,
  key: string,
  hash: string,
  reason: string,
  timestamp: string
): void {
  mutateNotebook(root, notebookId, (entry) => {
    const existing = entry.quarantined[key];
    entry.quarantined[key] =
      existing && existing.hash === hash
        ? { ...existing, last_seen_at: timestamp, attempts: existing.attempts + 1 }
        : { hash, reason, first_seen_at: timestamp, last_seen_at: timestamp, attempts: 1 };
  });
}

export function flushIngestedAt(root: string, notebookId: string, timestamp: string): void {
  mutateNotebook(root, notebookId, (entry) => {
    entry.last_ingested_at = timestamp;
  });
}

export function flushMinedState(root: string, notebookId: string, keys: string[], timestamp: string): void {
  mutateNotebook(root, notebookId, (entry) => {
    entry.last_mined_answer_keys = keys;
    entry.last_mined_at = timestamp;
  });
}

export function questionHash(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}

export function upsertResearchQueueEntry(
  root: string,
  notebookId: string,
  question: { id: string; text: string },
  gapKey: string,
  mode: 'fast' | 'deep'
): void {
  mutateNotebook(root, notebookId, (entry) => {
    if (!entry.research_queue) entry.research_queue = {};
    const hash = questionHash(question.text);
    if (entry.research_queue[hash]) return; // gap already queued -- never reset progress/cooldown
    entry.research_queue[hash] = {
      question_hash: hash,
      question_text: question.text,
      question_id: question.id,
      gap_key: gapKey,
      mode,
      attempt_count: 0,
      consecutive_dispatch_failures: 0,
      last_researched_at: null,
      last_dispatch_error: null,
      status: 'PENDING',
    };
  });
}

export function flushResearchQueueEntry(
  root: string,
  notebookId: string,
  questionHashValue: string,
  patch: Partial<ResearchQueueEntry>
): void {
  mutateNotebook(root, notebookId, (entry) => {
    if (!entry.research_queue) entry.research_queue = {};
    const existing = entry.research_queue[questionHashValue];
    if (!existing) {
      throw new Error(`research_queue has no entry for question_hash "${questionHashValue}" in notebook "${notebookId}"`);
    }
    entry.research_queue[questionHashValue] = { ...existing, ...patch };
  });
}
