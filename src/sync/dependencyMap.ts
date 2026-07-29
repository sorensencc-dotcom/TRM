import * as fs from 'node:fs';

export const SUPPORTED_MATCH_SCHEMA_VERSIONS = [1];

export interface DependencyMapItem {
  id: string;
  beat: string;
  claim: string;
  categories?: string[];
  keywords?: string[];
}

export interface DependencyMap {
  matchSchemaVersion: number;
  items: DependencyMapItem[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

export function loadDependencyMap(filePath: string): DependencyMap {
  if (!fs.existsSync(filePath)) {
    throw new Error(`dependency map not found: "${filePath}"`);
  }
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

  if (Array.isArray(raw) || typeof raw !== 'object' || raw === null) {
    throw new Error(
      `"${filePath}": expected an envelope object with a top-level "matchSchemaVersion" field, got ${
        Array.isArray(raw) ? 'a bare array' : typeof raw
      }`
    );
  }

  const { matchSchemaVersion, items } = raw as { matchSchemaVersion?: unknown; items?: unknown };

  if (typeof matchSchemaVersion !== 'number' || !SUPPORTED_MATCH_SCHEMA_VERSIONS.includes(matchSchemaVersion)) {
    throw new Error(
      `"${filePath}": matchSchemaVersion is ${JSON.stringify(matchSchemaVersion)}, ` +
        `supported: ${SUPPORTED_MATCH_SCHEMA_VERSIONS.join(', ')}`
    );
  }

  if (!Array.isArray(items)) {
    throw new Error(`"${filePath}": "items" must be an array`);
  }

  const seenIds = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Partial<DependencyMapItem>;
    const label = item?.id ?? `index ${i}`;

    if (typeof item?.id !== 'string' || item.id.length === 0) {
      throw new Error(`"${filePath}": items[${i}] has an empty or missing "id"`);
    }
    if (seenIds.has(item.id)) {
      throw new Error(`"${filePath}": duplicate item id "${item.id}"`);
    }
    seenIds.add(item.id);

    if (typeof item.beat !== 'string' || item.beat.length === 0) {
      throw new Error(`"${filePath}": item "${label}" has an empty or missing "beat"`);
    }
    if (typeof item.claim !== 'string' || item.claim.length === 0) {
      throw new Error(`"${filePath}": item "${label}" has an empty or missing "claim"`);
    }
    if (item.categories !== undefined && !isStringArray(item.categories)) {
      throw new Error(`"${filePath}": item "${label}" has a non-string-array "categories"`);
    }
    if (item.keywords !== undefined && !isStringArray(item.keywords)) {
      throw new Error(`"${filePath}": item "${label}" has a non-string-array "keywords"`);
    }
  }

  return { matchSchemaVersion, items: items as DependencyMapItem[] };
}
