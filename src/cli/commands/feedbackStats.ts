import * as fs from 'node:fs';
import * as path from 'node:path';
import { nodeDir } from '../../core/paths';
import { readTopicMeta } from '../../core/topicNode';
import { readRawEnvelope } from '../../core/rawSource';
import { readOcrTiming } from '../../core/ocrTimingLog';
import { runValidate, ValidationIssue } from './validate';
import { Fact, ScoreResult } from '../../scoring/types';

export interface FeedbackStats {
  ocr_latency: {
    p50: number;
    p90: number;
    p99: number;
    timeout_rate: number;
    latency_budget_ms: number;
    over_budget: boolean;
  };
  extract_stats: {
    fact_count: number;
    confidence_histogram: Record<string, number>;
    category_histogram: Record<string, number>;
    fact_density: number;
  };
  score_stats: { promoted: number; rejected: number };
  validate_stats: { errors: ValidationIssue[]; warnings_count_by_type: Record<string, number> };
  completeness: { has_ocr_timing: boolean; has_extract: boolean; has_score: boolean; has_validate: boolean };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function confidenceBucket(confidence: number): string {
  if (confidence >= 0.8) return 'high';
  if (confidence >= 0.5) return 'medium';
  return 'low';
}

function collectTopicPaths(root: string, topicPath: string, recursive?: boolean): string[] {
  const meta = readTopicMeta(root, topicPath);
  const paths = [topicPath];
  if (recursive) {
    for (const child of meta.children) {
      paths.push(...collectTopicPaths(root, `${topicPath}/${child}`, true));
    }
  }
  return paths;
}

export function runFeedbackStats(
  root: string,
  topicPath: string,
  cliArgs: { recursive?: boolean; latencyBudgetMs?: number }
): FeedbackStats {
  const latencyBudgetMs = cliArgs.latencyBudgetMs ?? 90000;
  const topicPaths = collectTopicPaths(root, topicPath, cliArgs.recursive);

  let factCount = 0;
  const confidenceHistogram: Record<string, number> = { high: 0, medium: 0, low: 0 };
  const categoryHistogram: Record<string, number> = {};
  let sourceTextBytes = 0;
  let promoted = 0;
  let rejected = 0;
  const allErrors: ValidationIssue[] = [];
  const warningsCountByType: Record<string, number> = { mock_source: 0, schema_error: 0, lineage_error: 0, hand_edited: 0 };
  let hasExtract = false;
  let hasScore = false;
  let hasValidate = false;

  for (const tp of topicPaths) {
    const dir = nodeDir(root, tp);

    const extractPath = path.join(dir, 'extracts', 'extract.json');
    if (fs.existsSync(extractPath)) {
      const { facts }: { facts: Fact[] } = JSON.parse(fs.readFileSync(extractPath, 'utf-8'));
      if (facts.length > 0) hasExtract = true;
      for (const fact of facts) {
        factCount++;
        confidenceHistogram[confidenceBucket(fact.confidence)]++;
        for (const cat of fact.categories) {
          categoryHistogram[cat] = (categoryHistogram[cat] ?? 0) + 1;
        }
      }

      const metadataPath = path.join(dir, 'sources', 'metadata.json');
      if (fs.existsSync(metadataPath)) {
        const { sources }: { sources: { id: string }[] } = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
        for (const source of sources) {
          const envelope = readRawEnvelope(root, tp, source.id);
          if (envelope?.text) sourceTextBytes += Buffer.byteLength(envelope.text, 'utf-8');
        }
      }
    }

    const scorePath = path.join(dir, 'extracts', 'score.json');
    if (fs.existsSync(scorePath)) {
      hasScore = true;
      const { scores }: { scores: ScoreResult[] } = JSON.parse(fs.readFileSync(scorePath, 'utf-8'));
      for (const score of scores) {
        if (score.promoted) promoted++;
        else rejected++;
      }
    }

    hasValidate = true;
    const reports = runValidate(root, tp, {});
    for (const report of reports) {
      allErrors.push(...report.errors);
      for (const issue of [...report.errors, ...report.warnings]) {
        warningsCountByType[issue.type] = (warningsCountByType[issue.type] ?? 0) + 1;
      }
    }
  }

  const relevantTiming = readOcrTiming(root).filter((e) => topicPaths.includes(e.topic));
  const latencies = relevantTiming.map((e) => e.ms).sort((a, b) => a - b);
  const timeoutCount = relevantTiming.filter((e) => e.outcome === 'failure').length;
  const hasOcrTiming = relevantTiming.length > 0;
  const p90 = percentile(latencies, 90);
  const fact_density = sourceTextBytes > 0 ? factCount / (sourceTextBytes / 1024) : 0;

  return {
    ocr_latency: {
      p50: percentile(latencies, 50),
      p90,
      p99: percentile(latencies, 99),
      timeout_rate: relevantTiming.length > 0 ? timeoutCount / relevantTiming.length : 0,
      latency_budget_ms: latencyBudgetMs,
      over_budget: p90 > latencyBudgetMs,
    },
    extract_stats: {
      fact_count: factCount,
      confidence_histogram: confidenceHistogram,
      category_histogram: categoryHistogram,
      fact_density,
    },
    score_stats: { promoted, rejected },
    validate_stats: { errors: allErrors, warnings_count_by_type: warningsCountByType },
    completeness: {
      has_ocr_timing: hasOcrTiming,
      has_extract: hasExtract,
      has_score: hasScore,
      has_validate: hasValidate,
    },
  };
}
