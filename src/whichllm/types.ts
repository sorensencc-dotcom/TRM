export interface HardwareProfile {
  gpu_count: number;
  gpu_name: string;
  vram_gb: number;
  ram_gb: number;
}

export type VramFitStatus = 'fits_easily' | 'tight_vram_warning' | 'out_of_vram_degraded';

export type ModelTier = 'Tier 1 (Judgment)' | 'Tier 2 (Muscle)';

export interface BfclScenario {
  id: string;
  name: string;
  expected_tool?: string | null;
  expected_tools?: string[];
  expected_args?: Record<string, unknown>;
  expected_tool_sequence?: string[];
  negative_prompt?: boolean;
  prompt?: string;
}

export interface BfclMetrics {
  simple_tool_call_accuracy: number;
  parallel_tool_call_accuracy: number;
  nested_tool_call_accuracy: number;
  relevance_rejection_rate: number;
}

export interface ModelBenchmarkMatrix {
  bfcl_composite_score: number;
  metrics: BfclMetrics;
  quantization_overhead_penalty: number;
}

export interface RankedCandidate {
  model_name: string;
  tier: ModelTier;
  vram_fit_status: VramFitStatus;
  benchmark_matrix: ModelBenchmarkMatrix;
}

export interface WhichLlmRecommendations {
  frontier_judgment_anchor: string | null;
  local_muscle_anchor: string | null;
  local_fit_reasoning: string;
}

export interface WhichLlmLineage {
  contract_type: string;
  schema_version: string;
  provenance_flags: string[];
}

export interface WhichLlmArtifact {
  evaluated_at: string;
  hardware_profile: HardwareProfile;
  test_suite_coverage: {
    total_bfcl_scenarios: number;
    scenarios_run: Array<{ id: string; name: string }>;
  };
  recommendations: WhichLlmRecommendations;
  ranked_candidates: RankedCandidate[];
  lineage: WhichLlmLineage;
  hash_chain_self?: string;
}

export interface OllamaModelTag {
  name: string;
  modified_at?: string;
  size?: number;
  digest?: string;
  details?: {
    format?: string;
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
  };
}

export interface OllamaTagsResponse {
  models: OllamaModelTag[];
}
