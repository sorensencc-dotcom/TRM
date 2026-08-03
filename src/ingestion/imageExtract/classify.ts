import * as fs from 'node:fs';
import { ImageAnalyzer } from './imageAnalyzer';

export type ImageKind = 'photo' | 'text-doc';

export interface ClassifyOptions {
  kind?: ImageKind;
}

interface Dimensions {
  width: number;
  height: number;
}

const DOCUMENT_LABEL_KEYWORDS = [
  'document', 'text', 'paper', 'letter', 'receipt', 'book', 'newspaper', 'page', 'handwriting',
];
const LABEL_CONFIDENCE_THRESHOLD = 0.5;

/**
 * Classifies an image as a photo or a scanned/photographed text document.
 * Primary path: one Vision-label call via ImageAnalyzer (CIC_INGESTION_URL),
 * checking for document-like labels above LABEL_CONFIDENCE_THRESHOLD. Falls
 * back to the aspect-ratio heuristic below whenever CIC_INGESTION_URL is
 * unset or the vision call fails -- this keeps the function usable offline
 * and keeps existing callers/tests working with no vision service running.
 */
export async function classifyImage(filePath: string, opts?: ClassifyOptions): Promise<ImageKind> {
  if (opts?.kind) return opts.kind;

  const cicIngestionUrl = process.env.CIC_INGESTION_URL;
  if (cicIngestionUrl) {
    try {
      const buffer = await fs.promises.readFile(filePath);
      const analyzer = new ImageAnalyzer(cicIngestionUrl, 5000, 1);
      const result = await analyzer.extract(buffer);
      // ImageAnalyzer.extract() swallows network/service errors internally and
      // returns an error-result object (empty labels, metadata.error set)
      // rather than rejecting. Surface that as a throw so it's caught below
      // and falls through to the aspect-ratio heuristic, same as any other
      // vision-call failure -- otherwise an empty labels array would be
      // silently read as "no document signal" and misclassified as photo.
      if (result.metadata.error) {
        throw new Error(result.metadata.error);
      }
      const hasDocumentLabel = result.labels.some(
        (label) =>
          label.score >= LABEL_CONFIDENCE_THRESHOLD &&
          DOCUMENT_LABEL_KEYWORDS.some((kw) => label.description.toLowerCase().includes(kw))
      );
      return hasDocumentLabel ? 'text-doc' : 'photo';
    } catch {
      // Fall through to the aspect-ratio heuristic below.
    }
  }

  const buffer = await fs.promises.readFile(filePath);
  const dims = readDimensions(buffer);
  if (!dims || dims.width <= 0) return 'photo';

  const aspectRatio = dims.height / dims.width;
  return aspectRatio >= 1.3 ? 'text-doc' : 'photo';
}

function readDimensions(buffer: Buffer): Dimensions | null {
  if (isPng(buffer)) return readPngDimensions(buffer);
  if (isJpeg(buffer)) return readJpegDimensions(buffer);
  return null;
}

function isPng(buffer: Buffer): boolean {
  return (
    buffer.length >= 24 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
  );
}

function readPngDimensions(buffer: Buffer): Dimensions | null {
  // 8-byte signature, 4-byte chunk length, 4-byte "IHDR", then width(4)/height(4) big-endian.
  if (buffer.length < 24) return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height };
}

function isJpeg(buffer: Buffer): boolean {
  return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

function readJpegDimensions(buffer: Buffer): Dimensions | null {
  // Walk markers looking for an SOF marker (0xC0-0xCF, excluding DHT/JPG/DAC),
  // which encodes height/width right after a 2-byte segment length + 1-byte precision.
  let offset = 2;
  while (offset < buffer.length - 9) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return width && height ? { width, height } : null;
    }
    const segmentLength = buffer.readUInt16BE(offset + 2);
    offset += 2 + segmentLength;
  }
  return null;
}
