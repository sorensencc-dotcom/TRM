// src/ingestion/imageExtract/index.ts
// Phase 2: Migrated to HTTP client (ImageAnalyzer)
// Calls cic-ingestion Vision API service via HTTP
// Fallback: vendored ReverseImageSearchExtractor (deprecated)

import * as fs from 'node:fs';
import { ImageAnalyzer, AnalysisResult } from './imageAnalyzer';

// Re-export types for backward compatibility
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

export interface ImageMatch {
  url: string;
  similarity: number;
  source: string;
}

/**
 * Extract image using cic-ingestion Vision API service
 * Phase 2 implementation: HTTP client with graceful fallback
 */
export async function extractImage(filePath: string): Promise<ExtractionResult> {
  const buffer = fs.readFileSync(filePath);

  const cicIngestionUrl = process.env.CIC_INGESTION_URL || 'http://localhost:3000';
  const analyzer = new ImageAnalyzer(cicIngestionUrl, 5000, 3);

  const result = await analyzer.extract(buffer);

  // Transform AnalysisResult to ExtractionResult (compatibility layer)
  return {
    matches: result.matches,
    metadata: {
      format: result.metadata.format,
      size: result.metadata.size,
      processedAt: result.metadata.processedAt,
      visionApiUsed: result.metadata.visionApiUsed,
      error: result.metadata.error,
    },
  };
}

// Export analyzer for testing
export { ImageAnalyzer, AnalysisResult };
