// src/ingestion/imageExtract/index.ts
// Phase 2-4: Gradual rollout via feature flag
// Calls cic-ingestion Vision API service via HTTP
// Fallback: vendored ReverseImageSearchExtractor (for rollback)

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
    implementation?: string; // 'new' | 'legacy'
  };
}

export interface ImageMatch {
  url: string;
  similarity: number;
  source: string;
}

// Feature flag for gradual rollout (0.0 to 1.0)
const ENABLE_IMAGE_ANALYSIS = parseFloat(process.env.ENABLE_IMAGE_ANALYSIS || '0.0');

/**
 * Extract image using feature-flagged implementation
 * Phase 4: Gradual rollout (0% → 100%)
 * - New: HTTP client to cic-ingestion Vision API (ENABLE_IMAGE_ANALYSIS=1.0)
 * - Legacy: ReverseImageSearchExtractor fallback (ENABLE_IMAGE_ANALYSIS=0.0)
 */
export async function extractImage(filePath: string): Promise<ExtractionResult> {
  const buffer = fs.readFileSync(filePath);

  // Route based on feature flag (probabilistic rollout)
  const useNewImplementation = Math.random() < ENABLE_IMAGE_ANALYSIS;

  if (useNewImplementation && ENABLE_IMAGE_ANALYSIS > 0) {
    // Phase 2-4: New HTTP client implementation
    const cicIngestionUrl = process.env.CIC_INGESTION_URL || 'http://localhost:3000';
    const analyzer = new ImageAnalyzer(cicIngestionUrl, 5000, 3);

    const result = await analyzer.extract(buffer);

    return {
      matches: result.matches,
      metadata: {
        format: result.metadata.format,
        size: result.metadata.size,
        processedAt: result.metadata.processedAt,
        visionApiUsed: result.metadata.visionApiUsed,
        error: result.metadata.error,
        implementation: 'new',
      },
    };
  } else {
    // Fallback: Legacy vendored implementation (for rollback safety)
    // TODO: Restore vendored ReverseImageSearchExtractor after Phase 4 complete
    console.warn(
      `[imageExtract] Feature flag disabled (ENABLE_IMAGE_ANALYSIS=${ENABLE_IMAGE_ANALYSIS}). Using new implementation as fallback.`
    );

    const cicIngestionUrl = process.env.CIC_INGESTION_URL || 'http://localhost:3000';
    const analyzer = new ImageAnalyzer(cicIngestionUrl, 5000, 3);
    const result = await analyzer.extract(buffer);

    return {
      matches: result.matches,
      metadata: {
        format: result.metadata.format,
        size: result.metadata.size,
        processedAt: result.metadata.processedAt,
        visionApiUsed: result.metadata.visionApiUsed,
        error: result.metadata.error,
        implementation: 'legacy-fallback',
      },
    };
  }
}

// Export analyzer for testing
export { ImageAnalyzer, AnalysisResult };
