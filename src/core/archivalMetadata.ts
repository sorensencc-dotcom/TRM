import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ArchivalRecord, ArchivalProvenance, readArchivalRecord, writeArchivalRecord } from './archivalManifest';

export interface IAItemMetadata {
  identifier: string;
  title?: string;
  contributor?: string;
  raw: unknown;
}

export type MetadataValidation =
  | { ok: true; metadataSha256: string }
  | { ok: false; reason: string };

function normalize(value: string | undefined): string | undefined {
  return value?.trim().replace(/\s+/g, ' ');
}

export function validateArchivalMetadata(record: ArchivalRecord, metadata: IAItemMetadata): MetadataValidation {
  if (record.verificationStatus !== 'verified') return { ok: false, reason: 'archival record is quarantined' };
  if (metadata.identifier !== record.archiveIdentifier) return { ok: false, reason: 'metadata identifier mismatch' };
  if (record.expectedTitle && normalize(record.expectedTitle) !== normalize(metadata.title)) return { ok: false, reason: 'metadata title mismatch' };
  if (record.expectedContributor && normalize(record.expectedContributor) !== normalize(metadata.contributor)) return { ok: false, reason: 'metadata contributor mismatch' };
  const canonical = JSON.stringify(metadata.raw);
  return { ok: true, metadataSha256: crypto.createHash('sha256').update(canonical).digest('hex') };
}

export async function queryInternetArchiveMetadata(identifier: string): Promise<IAItemMetadata> {
  const response = await fetch(`https://archive.org/metadata/${encodeURIComponent(identifier)}`);
  if (!response.ok) throw new Error(`Internet Archive metadata request failed: HTTP ${response.status}`);
  const raw: unknown = await response.json();
  if (!raw || typeof raw !== 'object' || !('metadata' in raw)) throw new Error('Internet Archive metadata response is malformed');
  const metadata = (raw as { metadata?: Record<string, unknown> }).metadata;
  if (!metadata || typeof metadata.identifier !== 'string') throw new Error('Internet Archive metadata has no identifier');
  return {
    identifier: metadata.identifier,
    title: typeof metadata.title === 'string' ? metadata.title : undefined,
    contributor: typeof metadata.contributor === 'string' ? metadata.contributor : undefined,
    raw,
  };
}

export function stageDownloadedMedia(root: string, identifier: string, bytes: Uint8Array): { filePath: string; mediaSha256: string } {
  if (!identifier || identifier.includes('/') || identifier.includes('\\') || identifier.includes('..')) throw new Error(`Unsafe Internet Archive identifier: ${identifier}`);
  const directory = path.join(root, '.archival-staging', 'internet_archive', identifier);
  fs.mkdirSync(directory, { recursive: true });
  const mediaSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const temporary = path.join(directory, `${mediaSha256}.part`);
  const filePath = path.join(directory, `${mediaSha256}.media`);
  fs.writeFileSync(temporary, bytes);
  fs.renameSync(temporary, filePath);
  return { filePath, mediaSha256 };
}

export function quarantineArchivalRecord(root: string, record: ArchivalRecord, reason: string): void {
  writeArchivalRecord(root, { ...record, verificationStatus: 'quarantined', quarantineReason: reason });
}

export function buildArchivalProvenance(record: ArchivalRecord, metadataSha256: string, mediaSha256?: string): ArchivalProvenance {
  if (!record.metadataFetchedAt) throw new Error(`Missing metadataFetchedAt for ${record.archiveIdentifier}`);
  return {
    sourceSystem: 'internet_archive',
    archiveIdentifier: record.archiveIdentifier,
    canonicalUrl: record.canonicalUrl,
    verificationStatus: 'verified',
    metadataFetchedAt: record.metadataFetchedAt,
    metadataSha256,
    mediaSha256,
    claimStatus: 'catalog_only',
  };
}

export function requireVerifiedArchivalRecord(root: string, identifier: string): ArchivalRecord {
  const record = readArchivalRecord(root, identifier);
  if (!record) throw new Error(`Unknown Internet Archive identifier: ${identifier}`);
  if (record.verificationStatus !== 'verified') throw new Error(`Quarantined Internet Archive identifier: ${identifier}`);
  return record;
}
