// C:\dev\trm\src\cli\commands\ingest.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SourceEntry } from '../../core/sourceIngest';
import { addSource } from '../../core/sourceIngest';
import { resolveActor } from '../../registry/actorRegistry';
import { nodeDir } from '../../core/paths';
import { convertFileToText } from '../../ingestion/fileConvert';

export async function runIngest(
  root: string,
  topicPath: string,
  cliArgs: { actor?: string; type: string; title: string; origin: string; url?: string; file?: string; dryRun?: boolean }
): Promise<SourceEntry | null> {
  const actor = resolveActor(root, cliArgs.actor);
  if (cliArgs.dryRun) return null;

  const url = cliArgs.url ?? (cliArgs.file ? `local:${path.basename(cliArgs.file)}` : undefined);
  if (!url) {
    throw new Error('trm ingest: either <url> or --file must be provided');
  }

  const entry = addSource(root, topicPath, actor, { type: cliArgs.type, title: cliArgs.title, origin: cliArgs.origin, url });

  if (cliArgs.file) {
    const text = await convertFileToText(cliArgs.file);
    const rawPath = path.join(nodeDir(root, topicPath), 'sources', 'raw', `${entry.id}.txt`);
    fs.writeFileSync(rawPath, text);
  }

  return entry;
}
