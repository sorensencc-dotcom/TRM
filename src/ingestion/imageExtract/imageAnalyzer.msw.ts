// MSW handlers for mocking cic-ingestion Vision API service
// Used in TRM client tests (Phase 2) to test imageAnalyzer without real service

import { http, HttpResponse } from 'msw';

export interface MockImageAnalysisConfig {
  baseUrl?: string;
  visionApiUsed?: boolean;
  simulateError?: boolean;
  simulateTimeout?: boolean;
  responseLatencyMs?: number;
}

export const createImageAnalysisHandlers = (config: MockImageAnalysisConfig = {}) => {
  const baseUrl = config.baseUrl || 'http://localhost:3000';
  const visionApiUsed = config.visionApiUsed ?? false;
  const simulateError = config.simulateError ?? false;
  const simulateTimeout = config.simulateTimeout ?? false;
  const responseLatencyMs = config.responseLatencyMs ?? 100;

  return [
    http.post(`${baseUrl}/api/analyze/image`, async (req) => {
      // Simulate timeout
      if (simulateTimeout) {
        await new Promise(resolve => setTimeout(resolve, 10000)); // 10s to trigger client timeout
      }

      // Simulate error
      if (simulateError) {
        return HttpResponse.json(
          { error: 'Simulated service error' },
          { status: 500 }
        );
      }

      // Parse request
      let requestBody: any;
      try {
        requestBody = await req.json();
      } catch {
        return HttpResponse.json(
          { error: 'Invalid request body' },
          { status: 400 }
        );
      }

      const { imageBuffer, format, requestId } = requestBody;

      // Validate imageBuffer
      if (!imageBuffer || typeof imageBuffer !== 'string') {
        return HttpResponse.json(
          { error: 'imageBuffer is required (base64 string)' },
          { status: 400 }
        );
      }

      // Simulate network latency
      if (responseLatencyMs > 0) {
        await new Promise(resolve => setTimeout(resolve, responseLatencyMs));
      }

      // Generate mock response
      const mockMatches = [
        {
          url: `https://mock.example.com/image-${requestId}`,
          similarity: 85,
          source: visionApiUsed ? 'google_vision' : 'mock',
        },
        {
          url: `https://mock.example.com/similar-${requestId}`,
          similarity: 72,
          source: visionApiUsed ? 'google_vision' : 'mock',
        },
      ];

      return HttpResponse.json({
        matches: mockMatches,
        metadata: {
          format: format || 'png',
          size: Buffer.byteLength(imageBuffer, 'base64'),
          processedAt: new Date().toISOString(),
          visionApiUsed,
          latencyMs: Math.random() * 200 + 50,
          apiProvider: visionApiUsed ? 'google_vision' : 'mock',
        },
      });
    }),
  ];
};

/**
 * Fixture: success scenario (mock results, no real Vision API)
 */
export const successMockHandlers = createImageAnalysisHandlers({
  visionApiUsed: false,
  responseLatencyMs: 50,
});

/**
 * Fixture: real Vision API scenario (would be used after GCP setup)
 */
export const realVisionApiHandlers = createImageAnalysisHandlers({
  visionApiUsed: true,
  responseLatencyMs: 300, // Vision API is slower
});

/**
 * Fixture: service error scenario
 */
export const errorScenarioHandlers = createImageAnalysisHandlers({
  simulateError: true,
  responseLatencyMs: 10,
});

/**
 * Fixture: timeout scenario
 */
export const timeoutScenarioHandlers = createImageAnalysisHandlers({
  simulateTimeout: true,
});
