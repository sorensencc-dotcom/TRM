import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promoteArchivalFrameVerification } from './archivalVerification';

test('promotes catalog-only archival envelope after valid cut attestation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-verify-'));
  const rawDir = path.join(root, 'topics', 'film', 'sources', 'raw');
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(path.join(rawDir, 'SRC-001.json'), JSON.stringify({
    sourceId: 'SRC-001', kind: 'video', capturedAt: '2026-09-20T00:00:00.000Z', text: 'x',
    archival: { sourceSystem: 'internet_archive', archiveIdentifier: '74182StoryOfWillowRun', canonicalUrl: 'https://archive.org/details/74182StoryOfWillowRun', verificationStatus: 'verified', metadataFetchedAt: '2026-09-20T00:00:00.000Z', metadataSha256: 'metadata', claimStatus: 'catalog_only' },
  }));
  const result = promoteArchivalFrameVerification(root, 'film', 'SRC-001', { timecodeIn: '00:01:00', timecodeOut: '00:02:00', attestation: 'title card verified' });
  const envelope = JSON.parse(fs.readFileSync(path.join(rawDir, 'SRC-001.json'), 'utf8'));
  expect(result.attestation).toBe('title card verified');
  expect(envelope.archival.claimStatus).toBe('frame_verified');
  expect(envelope.frameVerification.timecodeIn).toBe('00:01:00');
});
