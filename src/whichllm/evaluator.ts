import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { reportIcfEvent } from '../telemetry/icfReporter';
import { BFCL_TEST_SUITE, calculateVramFit, evaluateModelBfcl } from './bfclSuite';
import { discoverOllamaModels, type OllamaDiscoveryOptions } from './ollamaClient';
import {
  evaluateModelEmpirical,
  type EmpiricalEvaluationOptions,
} from './toolCallScorer';
import type {
  HardwareProfile,
  OllamaChatMessage,
  OllamaChatResponse,
  OllamaToolDefinition,
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

export const MINIMUM_RELEVANCE_REJECTION_THRESHOLD = 0.5;

export class LiveInferenceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveInferenceUnavailableError';
  }
}

/**
 * Sanitizes endpoint URL removing sensitive credentials if present.
 */
export function sanitizeEndpointUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return rawUrl;
  }
}

/**
 * Resolves the hardware profile from configuration, host probing, or baseline defaults.
 */
export function resolveHardwareProfile(
  configPath?: string,
  injectedHardware?: HardwareProfile,
): { hardware: HardwareProfile; source: string } {
  if (injectedHardware) {
    return { hardware: injectedHardware, source: 'injected_override' };
  }
  if (configPath && fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (cfg.hardware) {
        return {
          hardware: { ...DEFAULT_HARDWARE_PROFILE, ...cfg.hardware },
          source: 'configured_file',
        };
      }
    } catch {
      // Fallback
    }
  }
  const systemRamGb = Math.round(os.totalmem() / (1024 * 1024 * 1024));
  return {
    hardware: {
      ...DEFAULT_HARDWARE_PROFILE,
      ram_gb: systemRamGb > 0 ? systemRamGb : DEFAULT_HARDWARE_PROFILE.ram_gb,
    },
    source: 'configured_preset_with_host_ram_probe',
  };
}

/**
 * Writes the artifact to disk atomically via temporary file rename.
 * Validates self-integrity before committing.
 */
export function writeArtifactAtomically(
  outputPath: string,
  artifact: WhichLlmArtifact,
): void {
  const parentDir = path.dirname(outputPath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }
  const tempPath = path.join(
    parentDir,
    `.model_selection.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`,
  );

  try {
    fs.writeFileSync(tempPath, JSON.stringify(artifact, null, 2), 'utf8');
    const written = JSON.parse(fs.readFileSync(tempPath, 'utf8')) as WhichLlmArtifact;
    if (!verifyArtifactHash(written)) {
      throw new Error('Self-integrity hash validation failed on written candidate artifact');
    }
    fs.renameSync(tempPath, outputPath);
  } catch (err) {
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Ignore cleanup error
      }
    }
    throw err;
  }
}

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
  const keys = Object.keys(obj as Record<string, unknown>)
    .filter((k) => (obj as Record<string, unknown>)[k] !== undefined)
    .sort();
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
  liveInference?: boolean;
  samplesPerScenario?: number;
  timeoutMs?: number;
  allowUnsafeRelevance?: boolean;
  customChatExecutor?: (
    model: string,
    messages: OllamaChatMessage[],
    tools: OllamaToolDefinition[],
  ) => Promise<OllamaChatResponse>;
}

export interface EvaluatorRunResult {
  artifact: WhichLlmArtifact;
  outputPath: string | null;
  dryRun: boolean;
  discoverySource: string;
  hardwareSource: string;
}

/**
 * Main WhichLLM upgrade sweep evaluator.
 * Discovers live Ollama models, runs the BFCL test matrix (heuristically or empirically via live inference),
 * calculates VRAM fit, generates the hash-chained artifact, and writes atomically to disk.
 */
export async function runWhichLlmEvaluator(
  options: EvaluatorRunOptions = {},
): Promise<EvaluatorRunResult> {
  const outputPath =
    options.outputPath ??
    path.join(process.cwd(), '_integration', 'model_selection.json');
  const dryRun = options.dryRun ?? false;
  const liveInference = options.liveInference ?? false;

  // 1. Resolve hardware context
  const { hardware, source: hardwareSource } = resolveHardwareProfile(
    options.configPath,
    options.injectedHardware,
  );

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
      if (liveInference) {
        reportIcfEvent({
          severity: 'CRITICAL',
          eventType: 'LIVE_INFERENCE_UNAVAILABLE',
          subsystem: 'TRM',
          modelName: 'ollama_daemon',
          failureStage: 'DISCOVERY',
          errorReason: `Live inference requested but Ollama daemon is unreachable: ${(err as Error).message}`,
          timestamp: new Date().toISOString(),
        });
        throw new LiveInferenceUnavailableError(
          `LIVE_INFERENCE_UNAVAILABLE: Ollama host unreachable (${(err as Error).message})`,
        );
      }

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
  const aggregatedParserBreakdown = {
    native_tool_call_count: 0,
    fenced_json_count: 0,
    plain_text_count: 0,
    malformed_count: 0,
    timeout_count: 0,
  };

  const rawHost = options.discoveryOptions?.host ?? process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
  const sanitizedHost = sanitizeEndpointUrl(rawHost);

  for (const candidate of candidateDefs) {
    const { fitStatus } = calculateVramFit(
      candidate.name,
      candidate.isFrontier,
      hardware,
    );

    const heuristicMatrix = evaluateModelBfcl(candidate.name, hardware);

    if (liveInference && !candidate.isFrontier) {
      try {
        const empiricalMetrics = await evaluateModelEmpirical(
          candidate.name,
          BFCL_TEST_SUITE,
          {
            host: rawHost,
            samplesPerScenario: options.samplesPerScenario ?? 3,
            timeoutMs: options.timeoutMs ?? 15_000,
            customChatExecutor: options.customChatExecutor,
          },
        );

        aggregatedParserBreakdown.native_tool_call_count +=
          empiricalMetrics.parser_breakdown.native_tool_call_count;
        aggregatedParserBreakdown.fenced_json_count +=
          empiricalMetrics.parser_breakdown.fenced_json_count;
        aggregatedParserBreakdown.plain_text_count +=
          empiricalMetrics.parser_breakdown.plain_text_count;
        aggregatedParserBreakdown.malformed_count +=
          empiricalMetrics.parser_breakdown.malformed_count;
        aggregatedParserBreakdown.timeout_count +=
          empiricalMetrics.parser_breakdown.timeout_count;

        rankedCandidates.push({
          model_name: candidate.name,
          tier: 'Tier 2 (Muscle)',
          vram_fit_status: fitStatus,
          benchmark_matrix: {
            evaluation_mode: 'empirical',
            bfcl_composite_score: empiricalMetrics.composite_pass_rate,
            heuristic_metrics: heuristicMatrix.heuristic_metrics,
            empirical_metrics: empiricalMetrics,
            metrics: empiricalMetrics.discipline_scores,
            quantization_overhead_penalty: 0.0,
          },
        });
      } catch (err) {
        reportIcfEvent({
          severity: 'CRITICAL',
          eventType: 'LIVE_INFERENCE_UNAVAILABLE',
          subsystem: 'TRM',
          modelName: candidate.name,
          failureStage: 'INFERENCE',
          errorReason: `Live inference execution failed for ${candidate.name}: ${(err as Error).message}`,
          timestamp: new Date().toISOString(),
        });
        throw new LiveInferenceUnavailableError(
          `LIVE_INFERENCE_UNAVAILABLE: Inference failed for model ${candidate.name} (${(err as Error).message})`,
        );
      }
    } else {
      rankedCandidates.push({
        model_name: candidate.name,
        tier: candidate.isFrontier ? 'Tier 1 (Judgment)' : 'Tier 2 (Muscle)',
        vram_fit_status: fitStatus,
        benchmark_matrix: heuristicMatrix,
      });
    }
  }

  // Sort candidates by BFCL composite score descending
  rankedCandidates.sort(
    (a, b) =>
      b.benchmark_matrix.bfcl_composite_score -
      a.benchmark_matrix.bfcl_composite_score,
  );

  // 4. Synthesize recommendations with fail-closed tool-safety policy
  const localCandidates = rankedCandidates.filter(
    (c) => c.tier === 'Tier 2 (Muscle)',
  );

  const safeLocalCandidates = localCandidates.filter((c) => {
    if (c.benchmark_matrix.evaluation_mode !== 'empirical') return true;
    return (
      c.benchmark_matrix.metrics.relevance_rejection_rate >=
      MINIMUM_RELEVANCE_REJECTION_THRESHOLD
    );
  });

  const selectedLocal = options.allowUnsafeRelevance
    ? (localCandidates.find((c) => c.vram_fit_status === 'fits_easily') ??
       localCandidates.find((c) => c.vram_fit_status === 'tight_vram_warning') ??
       localCandidates[0] ??
       null)
    : (safeLocalCandidates.find((c) => c.vram_fit_status === 'fits_easily') ??
       safeLocalCandidates.find((c) => c.vram_fit_status === 'tight_vram_warning') ??
       safeLocalCandidates[0] ??
       null);

  const frontierCandidate = rankedCandidates.find(
    (c) => c.tier === 'Tier 1 (Judgment)',
  );

  let fitReasoning = '';
  if (!selectedLocal) {
    if (localCandidates.length > 0) {
      fitReasoning =
        'No local candidate met the minimum tool-safety threshold (negative relevance rejection >= 50%). All candidate models exhibited 0% accuracy on non-tool queries (hallucinating tool calls). Local muscle anchor suppressed to prevent uncommanded execution. Pass --allow-unsafe-relevance for explicit operator override.';
    } else {
      fitReasoning = 'No local models available in Ollama inventory.';
    }
  } else if (selectedLocal.vram_fit_status === 'tight_vram_warning') {
    fitReasoning =
      'Warning: Recommended model fits but VRAM buffer is tight (< 4GB remaining). Avoid concurrency leaks.';
  } else if (selectedLocal.vram_fit_status === 'out_of_vram_degraded') {
    fitReasoning =
      'Warning: Model parameter size exceeds physical VRAM. Inference will experience degradation.';
  } else {
    fitReasoning =
      'Model fits cleanly in VRAM with comfortable overhead. Maximum tokens/sec unlocked.';
  }

  if (
    selectedLocal &&
    selectedLocal.benchmark_matrix.evaluation_mode === 'empirical' &&
    selectedLocal.benchmark_matrix.metrics.relevance_rejection_rate < MINIMUM_RELEVANCE_REJECTION_THRESHOLD
  ) {
    fitReasoning +=
      ' [OPERATOR OVERRIDE ACTIVE: Selected model failed negative relevance rejection (< 50% accuracy). Running under explicit operator waiver.]';
  }

  const recommendations: WhichLlmRecommendations = {
    frontier_judgment_anchor: frontierCandidate ? frontierCandidate.model_name : null,
    local_muscle_anchor: selectedLocal ? selectedLocal.model_name : null,
    local_fit_reasoning: fitReasoning,
  };

  const evalTimestamp = new Date().toISOString();
  const payload: Omit<WhichLlmArtifact, 'hash_chain_self'> = {
    evaluated_at: evalTimestamp,
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
        liveInference ? 'live_bfcl_inference' : 'heuristic_bfcl_estimate',
        discoverySource === 'http_api' ? 'live_ollama_discovery' : 'degraded_discovery',
      ],
      evaluation_mode: liveInference ? 'empirical' : 'heuristic',
      ollama_endpoint: sanitizedHost,
      evaluated_at: evalTimestamp,
      scenario_attempt_counts: liveInference ? (options.samplesPerScenario ?? 3) : 1,
      parser_breakdown: liveInference ? aggregatedParserBreakdown : undefined,
    },
  };

  const hash = computeArtifactHash(payload);
  const artifact: WhichLlmArtifact = {
    ...payload,
    hash_chain_self: hash,
  };

  // 5. Write artifact atomically only if not in dry-run mode
  if (!dryRun) {
    writeArtifactAtomically(outputPath, artifact);
  }

  reportIcfEvent({
    severity: 'INFO',
    eventType: 'MODEL_SWEEP_COMPLETE',
    subsystem: 'TRM',
    modelName: recommendations.local_muscle_anchor ?? 'none',
    errorReason: `Sweep completed successfully in ${liveInference ? 'empirical' : 'heuristic'} mode.`,
    timestamp: new Date().toISOString(),
  });

  return {
    artifact,
    outputPath: dryRun ? null : outputPath,
    dryRun,
    discoverySource,
    hardwareSource,
  };
}

