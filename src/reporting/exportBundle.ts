import * as fs from 'node:fs';
import * as path from 'node:path';
import { nodeDir, splitPath } from '../core/paths';
import { readTopicMeta } from '../core/topicNode';
import { Fact } from '../scoring/types';
import { SourceEntry } from '../core/sourceIngest';
import { ReportBundle } from './types';

interface SourceMetadataFile {
  sources: SourceEntry[];
}

interface ExtractFile {
  facts: Fact[];
}

function readSources(root: string, topicPath: string): SourceEntry[] {
  const file = path.join(nodeDir(root, topicPath), 'sources', 'metadata.json');
  if (!fs.existsSync(file)) return [];
  const parsed: SourceMetadataFile = JSON.parse(fs.readFileSync(file, 'utf-8'));
  return parsed.sources;
}

function readFacts(root: string, topicPath: string): Fact[] {
  const file = path.join(nodeDir(root, topicPath), 'extracts', 'extract.json');
  if (!fs.existsSync(file)) return [];
  const parsed: ExtractFile = JSON.parse(fs.readFileSync(file, 'utf-8'));
  return parsed.facts;
}

export function exportBundle(root: string, topicPath: string, theme = 'cic'): ReportBundle {
  readTopicMeta(root, topicPath); // throws ENOENT if the node doesn't exist

  const sources = readSources(root, topicPath);
  const facts = readFacts(root, topicPath);
  const topicSlug = splitPath(topicPath).join('-');

  return {
    version: '1.0.0',
    topicPath,
    topicSlug,
    generatedAt: new Date().toISOString(),
    sourceCount: sources.length,
    factCount: facts.length,
    stats: {
      sourceCount: sources.length,
      factCount: facts.length,
    },
    facts: facts.map((f) => ({
      text: f.text,
      sourceId: f.source_id,
      confidence: f.confidence,
      categories: f.categories,
    })),
    sources: sources.map((s) => ({
      id: s.id,
      type: s.type,
      title: s.title,
      origin: s.origin,
      url: s.url,
      addedAt: s.added_at,
    })),
    theme,
  };
}
