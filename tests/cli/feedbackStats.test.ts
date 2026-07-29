import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCreate } from '../../src/cli/commands/create';
import { runScore } from '../../src/cli/commands/score';
import { runFeedbackStats } from '../../src/cli/commands/feedbackStats';
import { appendOcrTiming } from '../../src/core/ocrTimingLog';
import { writeRawEnvelope } from '../../src/core/rawSource';
import { addSource } from '../../src/core/sourceIngest';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-feedbackstats-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ default_scoring_adapter: 'stub', promotion_threshold: 80, actor_source: 'cli-only', time_source: 'system' }));
  return root;
}

function writeExtract(root: string, topicPath: string, facts: any[]) {
  const dir = path.join(root, 'topics', ...topicPath.split('/'), 'extracts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'extract.json'), JSON.stringify({ facts }, null, 2));
}

describe('runFeedbackStats', () => {
  it('reports zeroed-out ocr_latency and has_ocr_timing: false when no timing log exists', () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    writeExtract(root, 'cuba', [{ id: 'FCT-001', text: 'x', source_id: 'SRC-001', confidence: 0.9, categories: [] }]);

    const stats = runFeedbackStats(root, 'cuba', {});
    expect(stats.completeness.has_ocr_timing).toBe(false);
    expect(stats.ocr_latency.p50).toBe(0);
    expect(stats.ocr_latency.timeout_rate).toBe(0);
  });

  it('computes latency percentiles and over_budget against a custom budget', () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    for (const ms of [1000, 2000, 3000, 95000]) {
      appendOcrTiming(root, { schema_version: 1, topic: 'cuba', file: `f-${ms}.jpg`, source_type: 'jpg', ms, retries: 0, outcome: 'success', ts: new Date().toISOString() });
    }

    const stats = runFeedbackStats(root, 'cuba', { latencyBudgetMs: 90000 });
    expect(stats.completeness.has_ocr_timing).toBe(true);
    expect(stats.ocr_latency.p50).toBeGreaterThan(0);
    expect(stats.ocr_latency.over_budget).toBe(true);
    expect(stats.ocr_latency.latency_budget_ms).toBe(90000);
  });

  it('computes timeout_rate from failure-outcome entries', () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    appendOcrTiming(root, { schema_version: 1, topic: 'cuba', file: 'a.jpg', source_type: 'jpg', ms: 1000, retries: 0, outcome: 'success', ts: new Date().toISOString() });
    appendOcrTiming(root, { schema_version: 1, topic: 'cuba', file: 'b.jpg', source_type: 'jpg', ms: 90000, retries: 2, outcome: 'failure', ts: new Date().toISOString() });

    const stats = runFeedbackStats(root, 'cuba', {});
    expect(stats.ocr_latency.timeout_rate).toBeCloseTo(0.5);
  });

  it('excludes failed OCR calls from latency percentiles so a high-ms failure does not flip over_budget', () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    appendOcrTiming(root, { schema_version: 1, topic: 'cuba', file: 'a.jpg', source_type: 'jpg', ms: 1000, retries: 0, outcome: 'success', ts: new Date().toISOString() });
    appendOcrTiming(root, { schema_version: 1, topic: 'cuba', file: 'b.jpg', source_type: 'jpg', ms: 95000, retries: 2, outcome: 'failure', ts: new Date().toISOString() });

    const stats = runFeedbackStats(root, 'cuba', { latencyBudgetMs: 90000 });
    expect(stats.ocr_latency.p50).toBe(1000);
    expect(stats.ocr_latency.over_budget).toBe(false);
    expect(stats.ocr_latency.timeout_rate).toBeCloseTo(0.5);
  });

  it('computes fact_density from source text length, excluding image-only sources with no text', () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    const actor = 'ACTOR-001';
    const textEntry = addSource(root, 'cuba', actor, { type: 'document', title: 't', origin: 'local', url: 'local:t', contentHash: 'h1' });
    writeRawEnvelope(root, 'cuba', { sourceId: textEntry.id, kind: 'text', capturedAt: new Date().toISOString(), text: 'a'.repeat(1024) });
    const photoEntry = addSource(root, 'cuba', actor, { type: 'image', title: 'p', origin: 'local', url: 'local:p', contentHash: 'h2' });
    writeRawEnvelope(root, 'cuba', { sourceId: photoEntry.id, kind: 'image', capturedAt: new Date().toISOString(), image: { matches: [], metadata: { format: 'jpg', size: 1, processedAt: '', visionApiUsed: true }, mock: false } });

    writeExtract(root, 'cuba', [
      { id: 'FCT-001', text: 'x', source_id: textEntry.id, confidence: 0.9, categories: [] },
      { id: 'FCT-002', text: 'y', source_id: textEntry.id, confidence: 0.9, categories: [] },
    ]);

    const stats = runFeedbackStats(root, 'cuba', {});
    // 2 facts / 1KB of source text (the photo source contributes 0 bytes, not counted as zero-in-numerator noise)
    expect(stats.extract_stats.fact_density).toBeCloseTo(2);
  });

  it('rolls up score promoted/rejected counts and surfaces validate errors/warnings by type', () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    writeExtract(root, 'cuba', [{ id: 'FCT-001', text: 'x', source_id: 'SRC-001', confidence: 0.9, categories: [] }]);
    runScore(root, 'cuba', { actor: 'ACTOR-001' });

    const rawDir = path.join(root, 'topics', 'cuba', 'sources', 'raw');
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(path.join(rawDir, 'SRC-001.json'), JSON.stringify({ mock: true, matches: [], metadata: { visionApiUsed: false } }));

    const stats = runFeedbackStats(root, 'cuba', {});
    expect(stats.score_stats.promoted + stats.score_stats.rejected).toBeGreaterThan(0);
    expect(stats.validate_stats.warnings_count_by_type.mock_source).toBe(1);
  });

  it('--recursive rolls up across descendant topics', () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    runCreate(root, 'cuba/industry', { actor: 'ACTOR-001' });
    writeExtract(root, 'cuba/industry', [{ id: 'FCT-001', text: 'x', source_id: 'SRC-001', confidence: 0.9, categories: [] }]);

    const stats = runFeedbackStats(root, 'cuba', { recursive: true });
    expect(stats.extract_stats.fact_count).toBe(1);
  });
});
