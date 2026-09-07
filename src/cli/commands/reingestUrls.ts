import * as fs from 'node:fs';
import * as path from 'node:path';
import pLimit from 'p-limit';
import { nodeDir } from '../../core/paths';
import { readRawEnvelope, writeRawEnvelope, RawSourceEnvelope } from '../../core/rawSource';
import { fetchUrlToText, FetchUrlOptions } from '../../ingestion/urlFetch';

export interface ReingestUrlsResult {
  topicsProcessed: number;
  urlsFound: number;
  urlsIngested: number;
  skipped: number;
  failures: { topic: string; sourceId: string; url: string; error: string }[];
}

interface TopicSourceMetadata {
  sources?: {
    id: string;
    url?: string;
    type?: string;
    title?: string;
  }[];
}

function findTopicsWithMetadata(topicsRoot: string, currentRel = ''): string[] {
  const currentDir = path.join(topicsRoot, currentRel);
  if (!fs.existsSync(currentDir)) return [];

  const found: string[] = [];
  const metaPath = path.join(currentDir, 'sources', 'metadata.json');
  if (fs.existsSync(metaPath) && currentRel.length > 0) {
    found.push(currentRel.split(path.sep).join('/'));
  }

  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name !== 'sources' && entry.name !== 'extracts' && entry.name !== 'node_modules') {
      const nextRel = currentRel ? path.join(currentRel, entry.name) : entry.name;
      found.push(...findTopicsWithMetadata(topicsRoot, nextRel));
    }
  }

  return Array.from(new Set(found));
}

export async function runReingestUrls(
  root: string,
  targetPath: string | undefined,
  cliArgs: { all?: boolean; dryRun?: boolean; force?: boolean; concurrency?: number } = {},
  fetchOptions?: FetchUrlOptions
): Promise<ReingestUrlsResult> {
  const topicsToProcess: string[] = [];
  const topicsRoot = path.join(root, 'topics');

  if (cliArgs.all || !targetPath) {
    topicsToProcess.push(...findTopicsWithMetadata(topicsRoot));
  } else {
    topicsToProcess.push(targetPath);
  }

  const result: ReingestUrlsResult = {
    topicsProcessed: 0,
    urlsFound: 0,
    urlsIngested: 0,
    skipped: 0,
    failures: [],
  };

  const limit = pLimit(cliArgs.concurrency ?? 4);

  for (const topic of topicsToProcess) {
    const dir = nodeDir(root, topic);
    const metadataPath = path.join(dir, 'sources', 'metadata.json');
    if (!fs.existsSync(metadataPath)) continue;

    result.topicsProcessed++;
    let metadata: TopicSourceMetadata;
    try {
      metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    } catch {
      continue;
    }

    const sources = metadata.sources || [];
    const tasks: Promise<void>[] = [];

    for (const source of sources) {
      if (!source.url || !/^https?:\/\//i.test(source.url)) {
        continue;
      }
      result.urlsFound++;

      const existingEnvelope = readRawEnvelope(root, topic, source.id);
      if (existingEnvelope && !cliArgs.force) {
        result.skipped++;
        continue;
      }

      if (cliArgs.dryRun) {
        result.urlsIngested++;
        continue;
      }

      tasks.push(
        limit(async () => {
          try {
            const text = await fetchUrlToText(source.url!, fetchOptions);
            const envelope: RawSourceEnvelope = {
              sourceId: source.id,
              kind: 'text',
              capturedAt: new Date().toISOString(),
              text,
            };
            writeRawEnvelope(root, topic, envelope);
            result.urlsIngested++;
          } catch (err: any) {
            result.failures.push({
              topic,
              sourceId: source.id,
              url: source.url!,
              error: err.message || String(err),
            });
          }
        })
      );
    }

    if (tasks.length > 0) {
      await Promise.all(tasks);
    }
  }

  return result;
}
