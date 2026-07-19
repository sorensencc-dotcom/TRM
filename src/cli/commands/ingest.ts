// C:\dev\trm\src\cli\commands\ingest.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SourceEntry } from '../../core/sourceIngest';
import { addSource } from '../../core/sourceIngest';
import { resolveActor } from '../../registry/actorRegistry';
import { nodeDir } from '../../core/paths';
import { convertFileToText } from '../../ingestion/fileConvert';
import { extractImage } from '../../ingestion/imageExtract';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

export async function runIngest(
  root: string,
  topicPath: string,
  cliArgs: { actor?: string; type: string; title: string; origin: string; url?: string; file?: string; dryRun?: boolean }
): Promise<SourceEntry | null> {
  const actor = resolveActor(root, cliArgs.actor);
  if (cliArgs.dryRun) return null;

  const url = cliArgs.url || (cliArgs.file ? `local:${path.basename(cliArgs.file)}` : undefined);
  if (!url) {
    throw new Error('trm ingest: either <url> or --file must be provided');
  }

  const isImage = cliArgs.file ? IMAGE_EXTENSIONS.has(path.extname(cliArgs.file).toLowerCase()) : false;

  let text: string | undefined;
  let imageJson: string | undefined;

  if (cliArgs.file && isImage) {
    const result = await extractImage(cliArgs.file);
    const wrapped = { ...result, mock: !result.metadata.visionApiUsed };
    imageJson = JSON.stringify(wrapped, null, 2);
  } else if (cliArgs.file) {
    text = await convertFileToText(cliArgs.file);
  }

  const entry = addSource(root, topicPath, actor, { type: cliArgs.type, title: cliArgs.title, origin: cliArgs.origin, url });

  if (imageJson !== undefined) {
    const rawPath = path.join(nodeDir(root, topicPath), 'sources', 'raw', `${entry.id}.json`);
    fs.writeFileSync(rawPath, imageJson);
  } else if (text !== undefined) {
    const rawPath = path.join(nodeDir(root, topicPath), 'sources', 'raw', `${entry.id}.txt`);
    fs.writeFileSync(rawPath, text);
  }

  return entry;
}
