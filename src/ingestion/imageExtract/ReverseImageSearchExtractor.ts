// src/ingestion/imageExtract/ReverseImageSearchExtractor.ts
// Vendored from cic-ingestion/src/extractors/ReverseImageSearchExtractor.ts.
// Mock-only stub — see
// docs/meta/specs/2026-07-18-trm-harvester-mock-wiring-design.md for the
// real-vision migration plan.

import { IExtractor } from "./IExtractor";

const log = (...args: any[]) => console.log("[trm-image-extract]", ...args);

export interface ImageMatch {
  url: string;
  similarity: number; // 0-100
  source: string;
}

export interface ExtractionResult {
  matches: ImageMatch[];
  metadata: {
    format: string;
    size: number;
    processedAt: string;
    visionApiUsed: boolean;
    error?: string;
  };
}

const VALID_FORMATS = ["jpeg", "jpg", "png", "webp", "gif"];

/**
 * ReverseImageSearchExtractor: Analyzes images and returns potential matches.
 * Uses Vision API if available, otherwise returns mock results.
 */
export class ReverseImageSearchExtractor extends IExtractor {
  private visionApiKey: string | undefined;

  constructor(apiKey?: string) {
    super();
    this.visionApiKey = apiKey || process.env.VISION_API_KEY;
  }

  async extract(imageBuffer: any): Promise<ExtractionResult> {
    const startTime = Date.now();
    log('ReverseImageSearchExtractor.extract() starting');

    try {
      if (!imageBuffer) {
        return this._createErrorResult("Image buffer is required");
      }

      const buffer = this._normalizeBuffer(imageBuffer);
      if (!buffer) {
        return this._createErrorResult("Invalid image buffer format");
      }

      const format = this._detectFormat(buffer);
      if (!format) {
        return this._createErrorResult(
          `Unsupported image format. Supported: ${VALID_FORMATS.join(", ")}`
        );
      }

      if (this.visionApiKey) {
        try {
          const apiResults = await this._callVisionApi(buffer, format);
          const extractionTime = Date.now() - startTime;
          log('ReverseImageSearchExtractor.extract() completed via Vision API. Time:', extractionTime, 'ms');
          return {
            matches: apiResults,
            metadata: {
              format,
              size: buffer.length,
              processedAt: new Date().toISOString(),
              visionApiUsed: true,
            },
          };
        } catch (apiError) {
          log("ReverseImageSearchExtractor: Vision API call failed, using mock results", apiError);
        }
      }

      const result = this._generateMockResults(buffer, format);
      const extractionTime = Date.now() - startTime;
      log('ReverseImageSearchExtractor.extract() completed with mock results. Time:', extractionTime, 'ms');
      return result;
    } catch (error) {
      log('ReverseImageSearchExtractor.extract() failed:', error);
      return this._createErrorResult(`Extraction failed: ${(error as Error).message}`);
    }
  }

  private _normalizeBuffer(input: any): Buffer | null {
    if (Buffer.isBuffer(input)) {
      return input;
    }
    if (typeof input === "string") {
      try {
        return Buffer.from(input, "base64");
      } catch {
        return null;
      }
    }
    if (input instanceof Uint8Array) {
      return Buffer.from(input);
    }
    return null;
  }

  private _detectFormat(buffer: Buffer): string | null {
    if (buffer.length < 4) return null;

    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return "jpeg";
    }

    if (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47
    ) {
      return "png";
    }

    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
      return "gif";
    }

    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46) {
      if (buffer.length >= 12 && buffer.subarray(8, 12).toString() === "WEBP") {
        return "webp";
      }
    }

    return null;
  }

  private async _callVisionApi(
    buffer: Buffer,
    format: string
  ): Promise<ImageMatch[]> {
    if (!this.visionApiKey) {
      throw new Error("Vision API key not configured");
    }

    return [
      {
        url: "https://example.com/similar-image-1",
        similarity: 95,
        source: "vision-api",
      },
      {
        url: "https://example.com/similar-image-2",
        similarity: 87,
        source: "vision-api",
      },
    ];
  }

  private _generateMockResults(buffer: Buffer, format: string): ExtractionResult {
    const hash = this._simpleHash(buffer);
    const baseMatch = 75 + (hash % 20);

    return {
      matches: [
        {
          url: `https://mock.example.com/image-${hash}`,
          similarity: baseMatch,
          source: "mock-reverse-search",
        },
        {
          url: `https://mock.example.com/similar-${hash + 1}`,
          similarity: Math.max(50, baseMatch - 15),
          source: "mock-reverse-search",
        },
      ],
      metadata: {
        format,
        size: buffer.length,
        processedAt: new Date().toISOString(),
        visionApiUsed: false,
      },
    };
  }

  private _simpleHash(buffer: Buffer): number {
    let hash = 0;
    for (let i = 0; i < Math.min(100, buffer.length); i++) {
      hash = (hash << 5) - hash + buffer[i];
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  private _createErrorResult(error: string): ExtractionResult {
    return {
      matches: [],
      metadata: {
        format: "unknown",
        size: 0,
        processedAt: new Date().toISOString(),
        visionApiUsed: false,
        error,
      },
    };
  }
}
