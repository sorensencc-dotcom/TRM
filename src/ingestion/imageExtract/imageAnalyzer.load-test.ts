// Load test for imageAnalyzer HTTP client
// Tests concurrent requests and validates SLA (p99 <500ms)
// Run via: npm run test:load

import { ImageAnalyzer, AnalysisResult } from './imageAnalyzer';
import { readFileSync } from 'fs';
import { join } from 'path';

interface LoadTestResult {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  latencies: number[];
  percentile50: number;
  percentile95: number;
  percentile99: number;
  errorRate: number;
  passed: boolean;
}

async function runLoadTest(
  concurrency: number = 50,
  imageFixture: string = 'photo-large.jpg'
): Promise<LoadTestResult> {
  console.log(`[load-test] Starting load test: ${concurrency} concurrent requests`);

  const analyzer = new ImageAnalyzer(
    process.env.CIC_INGESTION_URL || 'http://localhost:3000',
    5000,
    1
  );

  // Load fixture
  const fixturesDir = join(__dirname, 'fixtures');
  const imagePath = join(fixturesDir, imageFixture);

  let imageBuffer: Buffer;
  try {
    imageBuffer = readFileSync(imagePath);
    console.log(`[load-test] Loaded fixture: ${imageFixture} (${imageBuffer.length} bytes)`);
  } catch (error) {
    console.error(`[load-test] Failed to load fixture ${imagePath}:`, error);
    // Fallback to minimal PNG for testing
    imageBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    console.log('[load-test] Using fallback PNG (4 bytes)');
  }

  const latencies: number[] = [];
  let successCount = 0;
  let failureCount = 0;

  // Run concurrent requests
  const batchSize = concurrency;
  const batchStartTime = Date.now();

  const promises = Array.from({ length: batchSize }).map(async (_, idx) => {
    const requestStartTime = Date.now();

    try {
      const result: AnalysisResult = await analyzer.extract(imageBuffer);
      const requestLatency = Date.now() - requestStartTime;

      latencies.push(requestLatency);

      if (result.metadata.error) {
        failureCount++;
        console.log(`[load-test] Request ${idx + 1}/${batchSize}: FAILED (${requestLatency}ms) - ${result.metadata.error}`);
      } else {
        successCount++;
        if (idx < 5 || idx % 10 === 0) {
          // Log first 5 and every 10th request
          console.log(
            `[load-test] Request ${idx + 1}/${batchSize}: OK (${requestLatency}ms, Vision API: ${result.metadata.visionApiUsed})`
          );
        }
      }
    } catch (error) {
      const requestLatency = Date.now() - requestStartTime;
      latencies.push(requestLatency);
      failureCount++;
      console.error(`[load-test] Request ${idx + 1}/${batchSize}: ERROR (${requestLatency}ms)`, error);
    }
  });

  await Promise.all(promises);

  const totalTime = Date.now() - batchStartTime;

  // Calculate percentiles
  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const p99 = sorted[Math.floor(sorted.length * 0.99)];
  const errorRate = (failureCount / batchSize) * 100;

  const result: LoadTestResult = {
    totalRequests: batchSize,
    successfulRequests: successCount,
    failedRequests: failureCount,
    latencies,
    percentile50: p50,
    percentile95: p95,
    percentile99: p99,
    errorRate,
    passed: p99 < 500 && errorRate < 5, // SLA: p99 <500ms, error rate <5%
  };

  // Print results
  console.log('\n[load-test] ========== Results ==========');
  console.log(`Total time: ${totalTime}ms`);
  console.log(`Successful: ${successCount}/${batchSize}`);
  console.log(`Failed: ${failureCount}/${batchSize}`);
  console.log(`Error rate: ${errorRate.toFixed(2)}%`);
  console.log('\nLatency percentiles:');
  console.log(`  p50: ${p50}ms`);
  console.log(`  p95: ${p95}ms`);
  console.log(`  p99: ${p99}ms (SLA: <500ms)`);
  console.log(`\nSLA Status: ${result.passed ? '✓ PASS' : '✗ FAIL'}`);
  console.log('[load-test] ================================\n');

  return result;
}

// Main
(async () => {
  try {
    const result = await runLoadTest(50, 'photo-large.jpg');
    process.exit(result.passed ? 0 : 1);
  } catch (error) {
    console.error('[load-test] Unhandled error:', error);
    process.exit(1);
  }
})();
