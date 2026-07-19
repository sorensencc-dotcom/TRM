// HTTP client for cic-ingestion Vision API service
// Replaces vendored ReverseImageSearchExtractor in Phase 2

import { IExtractor } from "./IExtractor";

const log = (...args: any[]) => console.error("[trm-image-analyzer]", ...args);

export interface ImageMatch {
  url: string;
  similarity: number; // 0-100
  source: string;
}

export interface AnalysisResult {
  matches: ImageMatch[];
  metadata: {
    format: string;
    size: number;
    processedAt: string;
    visionApiUsed: boolean;
    latencyMs: number;
    apiProvider: string;
    error?: string;
  };
}

export class ImageAnalyzer extends IExtractor {
  private cicIngestionUrl: string;
  private requestTimeout: number;
  private retryAttempts: number;

  constructor(
    cicIngestionUrl?: string,
    requestTimeout: number = 5000,
    retryAttempts: number = 3
  ) {
    super();
    this.cicIngestionUrl = cicIngestionUrl || process.env.CIC_INGESTION_URL || 'http://localhost:3000';
    this.requestTimeout = requestTimeout;
    this.retryAttempts = retryAttempts;
  }

  async extract(imageBuffer: any): Promise<AnalysisResult> {
    const startTime = Date.now();
    log('ImageAnalyzer.extract() starting');

    try {
      if (!imageBuffer) {
        return this._createErrorResult('Image buffer is required');
      }

      const buffer = this._normalizeBuffer(imageBuffer);
      if (!buffer) {
        return this._createErrorResult('Invalid image buffer format');
      }

      const format = this._detectFormat(buffer);
      if (!format) {
        return this._createErrorResult('Unsupported image format');
      }

      // Call cic-ingestion service with retry logic
      const result = await this._callServiceWithRetry(buffer, format);
      const totalLatency = Date.now() - startTime;

      log(`ImageAnalyzer.extract() completed. Total latency: ${totalLatency}ms, Vision API used: ${result.metadata.visionApiUsed}`);
      return result;
    } catch (error) {
      log('ImageAnalyzer.extract() failed:', error);
      return this._createErrorResult(`Extraction failed: ${(error as Error).message}`);
    }
  }

  private async _callServiceWithRetry(buffer: Buffer, format: string): Promise<AnalysisResult> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      try {
        return await this._callService(buffer, format);
      } catch (error) {
        lastError = error as Error;
        log(`Attempt ${attempt}/${this.retryAttempts} failed: ${lastError.message}`);

        if (attempt < this.retryAttempts) {
          // Exponential backoff: 100ms, 200ms, 400ms
          const delay = Math.pow(2, attempt - 1) * 100;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError || new Error('Service call failed after all retries');
  }

  private async _callService(buffer: Buffer, format: string): Promise<AnalysisResult> {
    const base64Image = buffer.toString('base64');
    const requestId = this._generateRequestId();

    const requestBody = {
      imageBuffer: base64Image,
      format,
      requestId,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeout);

    try {
      const endpoint = `${this.cicIngestionUrl}/api/analyze/image`;
      log(`POST ${endpoint} (requestId: ${requestId})`);

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Service returned ${response.status}: ${errorText}`);
      }

      const data = await response.json() as any;
      return {
        matches: data.matches || [],
        metadata: {
          format: data.metadata?.format || format,
          size: buffer.length,
          processedAt: data.metadata?.processedAt || new Date().toISOString(),
          visionApiUsed: data.metadata?.visionApiUsed ?? false,
          latencyMs: data.metadata?.latencyMs ?? 0,
          apiProvider: data.metadata?.apiProvider || 'unknown',
        },
      };
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        throw new Error(`Service request timeout (${this.requestTimeout}ms)`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private _normalizeBuffer(input: any): Buffer | null {
    if (Buffer.isBuffer(input)) {
      return input;
    }
    if (typeof input === 'string') {
      try {
        return Buffer.from(input, 'base64');
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

    // JPEG: FF D8 FF
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return 'jpeg';
    }

    // PNG: 89 50 4E 47
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      return 'png';
    }

    // GIF: 47 49 46
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
      return 'gif';
    }

    // WebP: RIFF ... WEBP
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46) {
      if (buffer.length >= 12 && buffer.subarray(8, 12).toString() === 'WEBP') {
        return 'webp';
      }
    }

    return null;
  }

  private _generateRequestId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private _createErrorResult(error: string): AnalysisResult {
    return {
      matches: [],
      metadata: {
        format: 'unknown',
        size: 0,
        processedAt: new Date().toISOString(),
        visionApiUsed: false,
        latencyMs: 0,
        apiProvider: 'error',
        error,
      },
    };
  }
}
