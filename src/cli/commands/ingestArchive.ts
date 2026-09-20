import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runIngestDir } from './ingestDir';
import { queryInternetArchiveMetadata, validateArchivalMetadata, requireVerifiedArchivalRecord } from '../../core/archivalMetadata';
import { ArchivalProvenance } from '../../core/archivalManifest';
import { hashFile } from '../../core/contentHash';

export async function runIngestArchive(
  root: string,
  topicPath: string,
  identifier: string,
  filePath: string,
  options: { actor?: string; stub?: boolean } = {}
) {
  const record = requireVerifiedArchivalRecord(root, identifier);
  const metadata = await queryInternetArchiveMetadata(identifier);
  const validation = validateArchivalMetadata(record, metadata);
  if (!validation.ok) throw new Error(`Archival admission rejected: ${validation.reason}`);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error(`Media file does not exist: ${filePath}`);

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-archival-'));
  const stagedPath = path.join(staging, path.basename(filePath));
  fs.copyFileSync(filePath, stagedPath);
  const mediaSha256 = await hashFile(stagedPath);
  try {
    return await runIngestDir(root, topicPath, {
      actor: options.actor,
      dir: staging,
      origin: record.canonicalUrl,
      url: record.canonicalUrl,
      title: metadata.title ?? identifier,
      type: 'archival-film',
      stub: options.stub,
      archival: {
        sourceSystem: 'internet_archive',
        archiveIdentifier: identifier,
        canonicalUrl: record.canonicalUrl,
        verificationStatus: 'verified',
        metadataFetchedAt: new Date().toISOString(),
        metadataSha256: validation.metadataSha256,
        mediaSha256,
        claimStatus: 'catalog_only',
      } satisfies ArchivalProvenance,
    });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
