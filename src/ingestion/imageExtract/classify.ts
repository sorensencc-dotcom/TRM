import * as fs from 'node:fs';

export type ImageKind = 'photo' | 'text-doc';

export interface ClassifyOptions {
  kind?: ImageKind;
}

interface Dimensions {
  width: number;
  height: number;
}

/**
 * Heuristic placeholder classifier: buckets images by aspect ratio read from
 * PNG/JPEG headers. Scanned text pages are reliably tall-and-narrow (US
 * Letter ~1.29, A4 ~1.41); photos skew closer to square/landscape. This is
 * cheap and imprecise on purpose -- SPEC (AC8) only requires the branch point
 * exist. A false positive just means a photo gets OCR'd needlessly, not lost
 * data. Swap the body for a real cheap-vision-call classifier in a later
 * phase without touching callers -- the signature already supports it.
 */
export async function classifyImage(filePath: string, opts?: ClassifyOptions): Promise<ImageKind> {
  if (opts?.kind) return opts.kind;

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
