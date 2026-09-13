import path from 'node:path';
import { runWhichLlmEvaluator } from '../../whichllm/evaluator';

export interface EvalWhichllmCommandOptions {
  config?: string;
  output?: string;
  dryRun?: boolean;
  allowDegradedCli?: boolean;
  liveInference?: boolean;
  samples?: number;
  timeout?: number;
  allowUnsafeRelevance?: boolean;
}

export async function runEvalWhichllm(
  root: string,
  options: EvalWhichllmCommandOptions = {},
): Promise<void> {
  const configPath = options.config
    ? path.resolve(root, options.config)
    : undefined;
  const outputPath = options.output
    ? path.resolve(root, options.output)
    : path.resolve(root, '_integration', 'model_selection.json');

  console.log('\n======================================================================');
  console.log('       WHICHLLM HARDWARE-AWARE MODEL SELECTION EVALUATOR (TRM)        ');
  console.log('======================================================================\n');

  if (options.dryRun) {
    console.log('[DRY-RUN MODE] Evaluation matrix will be displayed; no files will be written.\n');
  }
  if (options.liveInference) {
    console.log('[LIVE INFERENCE MODE] Executing active BFCL tool-calling benchmarks via Ollama /api/chat.\n');
  }

  try {
    const result = await runWhichLlmEvaluator({
      configPath,
      outputPath,
      dryRun: options.dryRun,
      liveInference: options.liveInference,
      samplesPerScenario: options.samples,
      timeoutMs: options.timeout,
      allowUnsafeRelevance: options.allowUnsafeRelevance,
      discoveryOptions: {
        allowCliFallback: options.allowDegradedCli ?? false,
      },
    });

    const { artifact } = result;
    console.log(
      `Hardware Profile : GPU: ${artifact.hardware_profile.gpu_count}x ${artifact.hardware_profile.gpu_name} (${artifact.hardware_profile.vram_gb} GB VRAM) [Configured Preset] | Host RAM: ${artifact.hardware_profile.ram_gb} GB [Probed Host Telemetry]`,
    );
    console.log(`Evaluation Mode  : ${artifact.lineage.evaluation_mode.toUpperCase()}`);
    console.log(`Discovery Source : ${result.discoverySource}`);
    console.log(`Scenarios Run    : ${artifact.test_suite_coverage.total_bfcl_scenarios} disciplines evaluated (${artifact.lineage.scenario_attempt_counts ?? 1} sample(s) per scenario)`);
    if (artifact.lineage.parser_breakdown) {
      const pb = artifact.lineage.parser_breakdown;
      const totalAttempts = pb.native_tool_call_count + pb.fenced_json_count + pb.plain_text_count + pb.malformed_count + pb.timeout_count;
      console.log(`Parser Breakdown : Native: ${pb.native_tool_call_count}, Fenced JSON: ${pb.fenced_json_count}, Plain Text: ${pb.plain_text_count}, Malformed: ${pb.malformed_count}, Timeouts: ${pb.timeout_count} (Total Attempts: ${totalAttempts})`);
    }
    console.log(`Self-Hash (SHA256): ${artifact.hash_chain_self}\n`);

    console.log(`Ranked Candidates (${artifact.lineage.evaluation_mode === 'empirical' ? 'Mixed-Method Comparison: Empirical Local vs Heuristic Frontier Reference' : 'Deterministic BFCL Scoring Estimates'}):`);
    console.log('----------------------------------------------------------------------');
    for (const candidate of artifact.ranked_candidates) {
      const bm = candidate.benchmark_matrix;
      const scoreStr = bm.bfcl_composite_score.toFixed(3);
      const modeLabel =
        candidate.tier === 'Tier 1 (Judgment)'
          ? 'heuristic reference anchor — not executed locally'
          : bm.evaluation_mode === 'empirical'
            ? 'empirical live benchmark'
            : 'heuristic estimate';

      console.log(
        `• [${candidate.tier}] ${candidate.model_name.padEnd(36)} | Score: ${scoreStr} (${modeLabel}) | Fit: ${candidate.vram_fit_status}`,
      );
      if (bm.empirical_metrics) {
        const em = bm.empirical_metrics;
        console.log(
          `    Disciplines: Simple: ${(em.discipline_scores.simple_tool_call_accuracy * 100).toFixed(0)}% (var: ${em.discipline_variances.simple_tool_variance}) | Parallel: ${(em.discipline_scores.parallel_tool_call_accuracy * 100).toFixed(0)}% (var: ${em.discipline_variances.parallel_tool_variance}) | Nested: ${(em.discipline_scores.nested_tool_call_accuracy * 100).toFixed(0)}% (var: ${em.discipline_variances.nested_tool_variance}) | Rejection: ${(em.discipline_scores.relevance_rejection_rate * 100).toFixed(0)}% (var: ${em.discipline_variances.relevance_rejection_variance})`,
        );
      }
    }
    console.log('----------------------------------------------------------------------\n');

    console.log('Recommendations:');
    console.log(`  Frontier Reference Anchor (Configured) : ${artifact.recommendations.frontier_judgment_anchor ?? '(none)'}`);
    console.log(`  Local Muscle Anchor                    : ${artifact.recommendations.local_muscle_anchor ?? '(none)'}`);
    console.log(`  Fit Reasoning                          : ${artifact.recommendations.local_fit_reasoning}\n`);

    if (result.outputPath) {
      console.log(`✔ Hash-verified model selection artifact written atomically to: ${result.outputPath}\n`);
    } else {
      console.log('✔ Dry-run evaluation completed successfully (0 files written).\n');
    }
  } catch (err) {
    console.error(`\n✖ [ERROR] WhichLLM evaluation failed: ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}

