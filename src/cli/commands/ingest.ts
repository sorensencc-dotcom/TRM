// C:\dev\trm\src\cli\commands\ingest.ts
import * as path from 'node:path';
import { SourceEntry } from '../../core/sourceIngest';
import { addSource } from '../../core/sourceIngest';
import { resolveActor } from '../../registry/actorRegistry';
import { convertFileToText } from '../../ingestion/fileConvert';
import { extractImage } from '../../ingestion/imageExtract';
import { writeRawEnvelope, RawSourceEnvelope } from '../../core/rawSource';

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
  let imageResult: Awaited<ReturnType<typeof extractImage>> | undefined;

  if (cliArgs.file && isImage) {
    imageResult = await extractImage(cliArgs.file);
  } else if (cliArgs.file) {
    text = await convertFileToText(cliArgs.file);
  }

  const entry = addSource(root, topicPath, actor, { type: cliArgs.type, title: cliArgs.title, origin: cliArgs.origin, url });

  if (imageResult !== undefined) {
    const envelope: RawSourceEnvelope = {
      sourceId: entry.id,
      kind: 'image',
      capturedAt: new Date().toISOString(),
      image: { ...imageResult, mock: !imageResult.metadata.visionApiUsed },
    };
    writeRawEnvelope(root, topicPath, envelope);
  } else if (text !== undefined) {
    const envelope: RawSourceEnvelope = {
      sourceId: entry.id,
      kind: 'text',
      capturedAt: new Date().toISOString(),
      text,
    };
    writeRawEnvelope(root, topicPath, envelope);
  }

  return entry;
}
