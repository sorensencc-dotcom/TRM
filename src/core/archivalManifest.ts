import * as fs from 'node:fs';
import * as path from 'node:path';

export type VerificationStatus = 'verified' | 'quarantined';

export interface ArchivalProvenance {
  sourceSystem: 'internet_archive';
  archiveIdentifier: string;
  canonicalUrl: string;
  verificationStatus: 'verified';
  metadataFetchedAt: string;
  metadataSha256: string;
  mediaSha256?: string;
  claimStatus: 'catalog_only' | 'frame_verified';
}

export interface ArchivalRecord {
  sourceSystem: 'internet_archive';
  archiveIdentifier: string;
  canonicalUrl: string;
  expectedTitle?: string;
  expectedContributor?: string;
  verificationStatus: VerificationStatus;
  quarantineReason?: string;
  metadataFetchedAt?: string;
  metadataSha256?: string;
  verificationBasis?: string;
}

interface ArchivalManifest {
  schemaVersion: 1;
  records: Record<string, ArchivalRecord>;
}

function manifestPath(root: string): string {
  return path.join(root, 'archival-manifest.json');
}

function emptyManifest(): ArchivalManifest {
  return { schemaVersion: 1, records: {} };
}

function assertSafeIdentifier(identifier: string): void {
  if (!identifier || identifier.includes('/') || identifier.includes('\\') || identifier.includes('..')) {
    throw new Error(`Unsafe Internet Archive identifier: ${identifier}`);
  }
}

function readManifest(root: string): ArchivalManifest {
  const file = manifestPath(root);
  if (!fs.existsSync(file)) return emptyManifest();
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as ArchivalManifest;
  if (value.schemaVersion !== 1 || !value.records || typeof value.records !== 'object') {
    throw new Error(`Invalid archival manifest: ${file}`);
  }
  return value;
}

export function readArchivalRecord(root: string, archiveIdentifier: string): ArchivalRecord | null {
  assertSafeIdentifier(archiveIdentifier);
  return readManifest(root).records[archiveIdentifier] ?? null;
}

export function writeArchivalRecord(root: string, record: ArchivalRecord): void {
  assertSafeIdentifier(record.archiveIdentifier);
  const manifest = readManifest(root);
  manifest.records[record.archiveIdentifier] = record;
  const file = manifestPath(root);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, file);
}

export function seedArchivalManifest(root: string): void {
  const records: ArchivalRecord[] = [
    { sourceSystem: 'internet_archive', archiveIdentifier: '74182StoryOfWillowRun', canonicalUrl: 'https://archive.org/details/74182StoryOfWillowRun', verificationStatus: 'verified', verificationBasis: 'catalog verification pending pinned metadata capture' },
    { sourceSystem: 'internet_archive', archiveIdentifier: 'Conquerb1943', canonicalUrl: 'https://archive.org/details/Conquerb1943', verificationStatus: 'verified', verificationBasis: 'catalog verification pending pinned metadata capture' },
    { sourceSystem: 'internet_archive', archiveIdentifier: 'xd-31051-ford-motor-company-1920s-1930s-footage-mos-vwr', canonicalUrl: 'https://archive.org/details/xd-31051-ford-motor-company-1920s-1930s-footage-mos-vwr', verificationStatus: 'quarantined', quarantineReason: 'no corroborated public catalog record' },
    { sourceSystem: 'internet_archive', archiveIdentifier: 'fc-fc-439a-c', canonicalUrl: 'https://archive.org/details/fc-fc-439a-c', verificationStatus: 'quarantined', quarantineReason: 'no corroborated public catalog record' },
    { sourceSystem: 'internet_archive', archiveIdentifier: '08144_Master_Hands', canonicalUrl: 'https://archive.org/details/08144_Master_Hands', verificationStatus: 'quarantined', quarantineReason: 'identifier string unverified' },
  ];
  for (const record of records) writeArchivalRecord(root, record);
}
