export interface HardwareProfile {
  gpu_count: number;
  gpu_name: string;
  vram_gb: number;
  ram_gb: number;
}

export type VramFitStatus = 'fits_easily' | 'tight_vram_warning' | 'out_of_vram_degraded';

export type ModelTier = 'Tier 1 (Judgment)' | 'Tier 2 (Muscle)';

export type EvaluationMode = 'empirical' | 'heuristic';

export type BfclDiscipline =
  | 'simple_tools'
  | 'parallel_tools'
  | 'nested_tools'
  | 'relevance_rejection';

export interface OllamaToolParameterProperty {
  type: string;
  description?: string;
  enum?: string[];
}

export interface OllamaToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, OllamaToolParameterProperty>;
      required?: string[];
    };
  };
}

export interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface OllamaChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
}

export interface OllamaChatResponse {
  model: string;
  created_at: string;
  message: OllamaChatMessage;
  done: boolean;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
  eval_duration?: number;
}

export interface BfclScenario {
  id: string;
  name: string;
  discipline: BfclDiscipline;
  available_tools: OllamaToolDefinition[];
  expected_tool?: string | null;
  expected_tools?: string[];
  expected_args?: Record<string, unknown>;
  expected_tool_sequence?: string[];
  negative_prompt?: boolean;
  prompt: string;
}

export interface BfclMetrics {
  simple_tool_call_accuracy: number;
  parallel_tool_call_accuracy: number;
  nested_tool_call_accuracy: number;
  relevance_rejection_rate: number;
}

export interface ScenarioMetricsSummary {
  scenario_id: string;
  discipline: BfclDiscipline;
  attempts_count: number;
  passed_count: number;
  pass_rate: number;
  timeouts_count: number;
  malformed_count: number;
}

export interface BfclEmpiricalMetrics {
  samples_per_scenario: number;
  total_attempts: number;
  successful_attempts: number;
  composite_pass_rate: number;
  discipline_scores: BfclMetrics;
  discipline_variances: {
    simple_tool_variance: number;
    parallel_tool_variance: number;
    nested_tool_variance: number;
    relevance_rejection_variance: number;
  };
  parser_breakdown: {
    native_tool_call_count: number;
    fenced_json_count: number;
    plain_text_count: number;
    malformed_count: number;
    timeout_count: number;
  };
  scenario_breakdown?: ScenarioMetricsSummary[];
}

export interface ModelBenchmarkMatrix {
  evaluation_mode: EvaluationMode;
  bfcl_composite_score: number;
  heuristic_metrics: BfclMetrics;
  empirical_metrics?: BfclEmpiricalMetrics;
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
  evaluation_mode: EvaluationMode;
  ollama_endpoint?: string;
  evaluated_at: string;
  scenario_attempt_counts?: number;
  parser_breakdown?: {
    native_tool_call_count: number;
    fenced_json_count: number;
    plain_text_count: number;
    malformed_count: number;
    timeout_count: number;
  };
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

