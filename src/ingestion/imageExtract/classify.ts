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
// Whole-word (plus optional trailing "s") matching. Plain substring matching
// false-positived on labels like "Homepage" (page), "Textile" (text),
// "Notebook"/"Facebook" (book) and "Wallpaper"/"Paperback" (paper).
const DOCUMENT_LABEL_PATTERNS = DOCUMENT_LABEL_KEYWORDS.map(
  (kw) => new RegExp(`\\b${kw}s?\\b`, 'i')
);
const LABEL_CONFIDENCE_THRESHOLD = 0.5;

/**
 * Which path produced a classification, so callers can see silent degradation.
 * `confidence` is the classifier's confidence in the returned `kind`:
 *  - vision path: derived from the document-label scores (never 0 in practice).
 *  - aspect-ratio path: left undefined when real dimensions were measured, and
 *    set to exactly 0 when dimensions were unparseable (HEIC and other formats
 *    `readDimensions` cannot measure) and 'photo' is only a default, not a
 *    finding. Callers use `source === 'aspect-ratio' && confidence === 0` to
 *    detect "we genuinely do not know".
 */
export interface ClassifyResult {
  kind: ImageKind;
  source: 'vision' | 'aspect-ratio';
  confidence?: number;
}

function matchesDocumentKeyword(description: string): boolean {
  return DOCUMENT_LABEL_PATTERNS.some((re) => re.test(description));
}

/**
 * Classifies an image as a photo or a scanned/photographed text document,
 * reporting which path produced the answer.
 *
 * Primary path: one Vision-label call via ImageAnalyzer (CIC_INGESTION_URL),
 * checking for document-like labels above LABEL_CONFIDENCE_THRESHOLD. Falls
 * back to the aspect-ratio heuristic whenever CIC_INGESTION_URL is unset, the
 * vision call fails, or the vision service degraded to mock mode -- this keeps
 * the function usable offline and keeps existing callers/tests working with no
 * vision service running. The returned `source` makes that degradation visible
 * to callers instead of silent.
 */
export async function classifyImageDetailed(
  filePath: string,
  opts?: ClassifyOptions
): Promise<ClassifyResult> {
  // An explicit override is a caller assertion, not a degraded fallback, so it
  // reports as 'vision' -- it must not inflate any fallback/degradation count.
  if (opts?.kind) return { kind: opts.kind, source: 'vision' };

  const buffer = await fs.promises.readFile(filePath);

  const cicIngestionUrl = process.env.CIC_INGESTION_URL;
  if (cicIngestionUrl) {
    try {
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
      // cic-ingestion also returns a *successful* response with no error and
      // empty labels when it is running in mock mode (no Vision API key, or a
      // Vision failure that fell back to mock). visionApiUsed is the only
      // signal separating "Vision looked and found nothing" from "Vision never
      // ran". Treat the latter as a failure so we degrade to aspect ratio
      // rather than silently mis-triaging every document photo as a photo.
      if (result.metadata.visionApiUsed !== true) {
        throw new Error('vision service degraded to mock mode (visionApiUsed=false)');
      }
      const maxDocScore = result.labels.reduce(
        (max, label) => (matchesDocumentKeyword(label.description) ? Math.max(max, label.score) : max),
        0
      );
      if (maxDocScore >= LABEL_CONFIDENCE_THRESHOLD) {
        return { kind: 'text-doc', source: 'vision', confidence: maxDocScore };
      }
      return { kind: 'photo', source: 'vision', confidence: 1 - maxDocScore };
    } catch {
      // Fall through to the aspect-ratio heuristic below.
    }
  }

  const dims = readDimensions(buffer);
  if (!dims || dims.width <= 0) {
    // Dimensions unparseable (HEIC/webp/gif/corrupt). 'photo' is the historical
    // default and stays the default for classifyImage's contract, but
    // confidence 0 flags it as "unknown", not "measured as a photo".
    return { kind: 'photo', source: 'aspect-ratio', confidence: 0 };
  }

  const aspectRatio = dims.height / dims.width;
  return { kind: aspectRatio >= 1.3 ? 'text-doc' : 'photo', source: 'aspect-ratio' };
}

/**
 * Backward-compatible wrapper: same behaviour and signature as before, just the
 * `kind` from classifyImageDetailed. Existing callers (e.g. ingestDir.ts) and
 * tests are unaffected.
 */
export async function classifyImage(filePath: string, opts?: ClassifyOptions): Promise<ImageKind> {
  return (await classifyImageDetailed(filePath, opts)).kind;
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
