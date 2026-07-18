// src/ingestion/imageExtract/index.ts
import * as fs from 'node:fs';
import { ReverseImageSearchExtractor, ExtractionResult, ImageMatch } from './ReverseImageSearchExtractor';

export { ExtractionResult, ImageMatch };

export async function extractImage(filePath: string): Promise<ExtractionResult> {
  const buffer = fs.readFileSync(filePath);
  const extractor = new ReverseImageSearchExtractor();
  return extractor.extract(buffer);
}
