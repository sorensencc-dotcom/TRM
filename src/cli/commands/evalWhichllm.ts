import path from 'node:path';
import { runWhichLlmEvaluator } from '../../whichllm/evaluator';

export interface EvalWhichllmCommandOptions {
  config?: string;
  output?: string;
  dryRun?: boolean;
  allowDegradedCli?: boolean;
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

  try {
    const result = await runWhichLlmEvaluator({
      configPath,
      outputPath,
      dryRun: options.dryRun,
      discoveryOptions: {
        allowCliFallback: options.allowDegradedCli ?? false,
      },
    });

    const { artifact } = result;
    console.log(
      `Hardware Profile : ${artifact.hardware_profile.gpu_count}x ${artifact.hardware_profile.gpu_name} (${artifact.hardware_profile.vram_gb} GB VRAM, ${artifact.hardware_profile.ram_gb} GB RAM)`,
    );
    console.log(`Discovery Source : ${result.discoverySource}`);
    console.log(`Scenarios Run    : ${artifact.test_suite_coverage.total_bfcl_scenarios} BFCL disciplines`);
    console.log(`Self-Hash        : ${artifact.hash_chain_self}\n`);

    console.log('Ranked Candidates:');
    console.log('----------------------------------------------------------------------');
    for (const candidate of artifact.ranked_candidates) {
      console.log(
        `• [${candidate.tier}] ${candidate.model_name.padEnd(36)} | BFCL: ${candidate.benchmark_matrix.bfcl_composite_score.toFixed(3)} | Fit: ${candidate.vram_fit_status}`,
      );
    }
    console.log('----------------------------------------------------------------------\n');

    console.log('Recommendations:');
    console.log(`  Frontier Judgment Anchor : ${artifact.recommendations.frontier_judgment_anchor ?? '(none)'}`);
    console.log(`  Local Muscle Anchor      : ${artifact.recommendations.local_muscle_anchor ?? '(none)'}`);
    console.log(`  Fit Reasoning            : ${artifact.recommendations.local_fit_reasoning}\n`);

    if (result.outputPath) {
      console.log(`✔ Model selection artifact written to: ${result.outputPath}\n`);
    } else {
      console.log('✔ Dry-run evaluation completed successfully (0 files written).\n');
    }
  } catch (err) {
    console.error(`\n✖ [ERROR] WhichLLM evaluation failed: ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}
