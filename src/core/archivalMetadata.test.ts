import { validateArchivalMetadata, stageDownloadedMedia } from './archivalMetadata';
import { ArchivalRecord } from './archivalManifest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const verified: ArchivalRecord = {
  sourceSystem: 'internet_archive',
  archiveIdentifier: '74182StoryOfWillowRun',
  canonicalUrl: 'https://archive.org/details/74182StoryOfWillowRun',
  expectedTitle: 'Story  of Willow Run',
  expectedContributor: 'Periscope Film',
  verificationStatus: 'verified',
};

describe('archival metadata admission', () => {
  test('accepts exact identifier and normalized catalog fields', () => {
    const result = validateArchivalMetadata(verified, {
      identifier: '74182StoryOfWillowRun',
      title: ' Story of Willow Run ',
      contributor: 'Periscope Film',
      raw: { metadata: { identifier: '74182StoryOfWillowRun' } },
    });
    expect(result.ok).toBe(true);
  });

  test('rejects identifier mismatch', () => {
    const result = validateArchivalMetadata(verified, {
      identifier: 'other-item',
      raw: {},
    });
    expect(result).toEqual({ ok: false, reason: 'metadata identifier mismatch' });
  });

  test('stages bytes atomically and returns content hash', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-archival-'));
    const result = stageDownloadedMedia(root, verified.archiveIdentifier, Buffer.from('fixture'));
    expect(fs.existsSync(result.filePath)).toBe(true);
    expect(result.filePath).not.toContain('.part');
    expect(result.mediaSha256).toBe(crypto.createHash('sha256').update('fixture').digest('hex'));
  });
});
