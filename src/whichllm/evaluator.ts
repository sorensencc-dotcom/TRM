import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { reportIcfEvent } from '../telemetry/icfReporter';
import { BFCL_TEST_SUITE, calculateVramFit, evaluateModelBfcl } from './bfclSuite';
import { discoverOllamaModels, type OllamaDiscoveryOptions } from './ollamaClient';
import type {
  HardwareProfile,
  RankedCandidate,
  WhichLlmArtifact,
  WhichLlmRecommendations,
} from './types';

export const DEFAULT_HARDWARE_PROFILE: HardwareProfile = {
  gpu_count: 1,
  gpu_name: 'NVIDIA RTX 4090',
  vram_gb: 24,
  ram_gb: 64,
};

export const FRONTIER_ANCHORS = ['claude-3-5-sonnet-20241022'];

/**
 * Deterministic JSON stringifier to guarantee stable SHA-256 hashing.
 */
export function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const pairs = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJson((obj as Record<string, unknown>)[k])}`,
  );
  return `{${pairs.join(',')}}`;
}

/**
 * Computes the SHA-256 self-integrity hash for the artifact payload.
 */
export function computeArtifactHash(
  payload: Omit<WhichLlmArtifact, 'hash_chain_self'>,
): string {
  return crypto.createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

/**
 * Verifies the self-integrity hash of an existing WhichLLM artifact.
 */
export function verifyArtifactHash(artifact: WhichLlmArtifact): boolean {
  if (!artifact.hash_chain_self) {
    return false;
  }
  const { hash_chain_self: expectedHash, ...rest } = artifact;
  const computed = computeArtifactHash(rest);
  return computed === expectedHash;
}

export interface EvaluatorRunOptions {
  configPath?: string;
  outputPath?: string;
  dryRun?: boolean;
  discoveryOptions?: OllamaDiscoveryOptions;
  injectedModels?: string[]; // for isolated testing
  injectedHardware?: HardwareProfile;
}

export interface EvaluatorRunResult {
  artifact: WhichLlmArtifact;
  outputPath: string | null;
  dryRun: boolean;
  discoverySource: string;
}

/**
 * Main WhichLLM upgrade sweep evaluator.
 * Discovers live Ollama models, runs the BFCL test matrix, calculates VRAM fit,
 * generates the hash-chained artifact, and writes to disk.
 */
export async function runWhichLlmEvaluator(
  options: EvaluatorRunOptions = {},
): Promise<EvaluatorRunResult> {
  const outputPath =
    options.outputPath ??
    path.join(process.cwd(), '_integration', 'model_selection.json');
  const dryRun = options.dryRun ?? false;

  // 1. Resolve hardware context
  let hardware: HardwareProfile = options.injectedHardware ?? { ...DEFAULT_HARDWARE_PROFILE };
  if (options.configPath && fs.existsSync(options.configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(options.configPath, 'utf8'));
      if (cfg.hardware) {
        hardware = { ...hardware, ...cfg.hardware };
      }
    } catch {
      reportIcfEvent({
        severity: 'WARN',
        eventType: 'WHICHLLM_DEGRADED_CASCADE',
        subsystem: 'TRM',
        modelName: 'hardware_config',
        errorReason: `Unable to parse hardware config at ${options.configPath}. Using defaults.`,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // 2. Discover local models
  let localModelNames: string[] = [];
  let discoverySource = 'injected';

  if (options.injectedModels) {
    localModelNames = options.injectedModels;
  } else {
    try {
      const discovery = await discoverOllamaModels(options.discoveryOptions);
      localModelNames = discovery.models.map((m) => m.name);
      discoverySource = discovery.source;
    } catch (err) {
      reportIcfEvent({
        severity: 'WARN',
        eventType: 'LOCAL_MODEL_FAILURE',
        subsystem: 'TRM',
        modelName: 'ollama_daemon',
        failureStage: 'DISCOVERY',
        errorReason: (err as Error).message,
        timestamp: new Date().toISOString(),
      });
      throw err;
    }
  }

  // 3. Assemble candidate models (Frontier + Installed Local)
  const candidateDefs = [
    ...FRONTIER_ANCHORS.map((name) => ({ name, isFrontier: true })),
    ...localModelNames.map((name) => ({ name, isFrontier: false })),
  ];

  const rankedCandidates: RankedCandidate[] = [];

  for (const candidate of candidateDefs) {
    const benchmarkResult = evaluateModelBfcl(candidate.name, hardware);
    const { fitStatus } = calculateVramFit(
      candidate.name,
      candidate.isFrontier,
      hardware,
    );

    rankedCandidates.push({
      model_name: candidate.name,
      tier: candidate.isFrontier ? 'Tier 1 (Judgment)' : 'Tier 2 (Muscle)',
      vram_fit_status: fitStatus,
      benchmark_matrix: benchmarkResult,
    });
  }

  // Sort candidates by BFCL composite score descending
  rankedCandidates.sort(
    (a, b) =>
      b.benchmark_matrix.bfcl_composite_score -
      a.benchmark_matrix.bfcl_composite_score,
  );

  // 4. Synthesize recommendations
  const localCandidates = rankedCandidates.filter(
    (c) => c.tier === 'Tier 2 (Muscle)',
  );
  const bestFittingLocal =
    localCandidates.find((c) => c.vram_fit_status === 'fits_easily') ??
    localCandidates.find((c) => c.vram_fit_status === 'tight_vram_warning') ??
    localCandidates[0] ??
    null;

  const frontierCandidate = rankedCandidates.find(
    (c) => c.tier === 'Tier 1 (Judgment)',
  );

  const recommendations: WhichLlmRecommendations = {
    frontier_judgment_anchor: frontierCandidate ? frontierCandidate.model_name : null,
    local_muscle_anchor: bestFittingLocal ? bestFittingLocal.model_name : null,
    local_fit_reasoning: !bestFittingLocal
      ? 'No local models available in Ollama inventory.'
      : bestFittingLocal.vram_fit_status === 'tight_vram_warning'
        ? 'Warning: Recommended model fits but VRAM buffer is tight (< 4GB remaining). Avoid concurrency leaks.'
        : bestFittingLocal.vram_fit_status === 'out_of_vram_degraded'
          ? 'Warning: Model parameter size exceeds physical VRAM. Inference will experience degradation.'
          : 'Model fits cleanly in VRAM with comfortable overhead. Maximum tokens/sec unlocked.',
  };

  const payload: Omit<WhichLlmArtifact, 'hash_chain_self'> = {
    evaluated_at: new Date().toISOString(),
    hardware_profile: hardware,
    test_suite_coverage: {
      total_bfcl_scenarios: BFCL_TEST_SUITE.length,
      scenarios_run: BFCL_TEST_SUITE.map((s) => ({ id: s.id, name: s.name })),
    },
    recommendations,
    ranked_candidates: rankedCandidates,
    lineage: {
      contract_type: 'extractor-upgrade-sweep',
      schema_version: '2.4.0',
      provenance_flags: [
        'bfcl_v2_automated',
        'hardware_aware_compaction',
        discoverySource === 'http_api' ? 'live_ollama_discovery' : 'degraded_discovery',
      ],
    },
  };

  const hash = computeArtifactHash(payload);
  const artifact: WhichLlmArtifact = {
    ...payload,
    hash_chain_self: hash,
  };

  // 5. Write artifact only if not in dry-run mode
  if (!dryRun) {
    const parentDir = path.dirname(outputPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    fs.writeFileSync(outputPath, JSON.stringify(artifact, null, 2), 'utf8');
  }

  reportIcfEvent({
    severity: 'INFO',
    eventType: 'MODEL_SWEEP_COMPLETE',
    subsystem: 'TRM',
    modelName: recommendations.local_muscle_anchor ?? 'none',
    errorReason: 'Sweep completed successfully.',
    timestamp: new Date().toISOString(),
  });

  return {
    artifact,
    outputPath: dryRun ? null : outputPath,
    dryRun,
    discoverySource,
  };
}
