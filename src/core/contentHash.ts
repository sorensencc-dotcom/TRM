import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

export type ManifestMap = Record<string, unknown> | Map<string, unknown> | Set<string>;

/**
 * Computes SHA-256 hash of a file's byte contents.
 */
export async function hashFile(filePath: string): Promise<string> {
  const buffer = await fs.promises.readFile(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Checks if a given content hash exists in the manifest map.
 */
export function isKnownHash(hash: string, manifest: ManifestMap): boolean {
  if (!hash || !manifest) return false;
  if (manifest instanceof Map || manifest instanceof Set) {
    return manifest.has(hash);
  }
  return Object.prototype.hasOwnProperty.call(manifest, hash);
}
