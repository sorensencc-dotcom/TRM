import * as fs from 'node:fs';
import * as path from 'node:path';
import { nodeDir } from './paths';

export interface RawImagePayload {
  matches: { url: string; similarity: number; source: string }[];
  metadata: {
    format: string;
    size: number;
    processedAt: string;
    visionApiUsed: boolean;
    error?: string;
    implementation?: string;
  };
  mock: boolean;
}

export interface RawSourceEnvelope {
  sourceId: string;
  kind: 'text' | 'image';
  capturedAt: string;
  text?: string;
  image?: RawImagePayload;
}

export function rawSourcePath(root: string, topicPath: string, sourceId: string): string {
  return path.join(nodeDir(root, topicPath), 'sources', 'raw', `${sourceId}.json`);
}

export function writeRawEnvelope(root: string, topicPath: string, envelope: RawSourceEnvelope): void {
  const filePath = rawSourcePath(root, topicPath, envelope.sourceId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(envelope, null, 2));
}

export function readRawEnvelope(root: string, topicPath: string, sourceId: string): RawSourceEnvelope | null {
  const filePath = rawSourcePath(root, topicPath, sourceId);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}
