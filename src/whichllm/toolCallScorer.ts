import type {
  BfclEmpiricalMetrics,
  BfclMetrics,
  BfclScenario,
  OllamaChatMessage,
  OllamaChatResponse,
  OllamaToolDefinition,
} from './types';
import {
  executeOllamaChat,
  parseToolInference,
  type ParsedToolInference,
} from './inferenceRunner';

export interface ScenarioAttemptResult {
  scenarioId: string;
  discipline: string;
  attemptIndex: number;
  passed: boolean;
  parserSource: 'native_tool_calls' | 'fenced_json' | 'none';
  isMalformed: boolean;
  isTimeout: boolean;
  reason?: string;
}

export interface EmpiricalEvaluationOptions {
  host?: string;
  samplesPerScenario?: number;
  timeoutMs?: number;
  customChatExecutor?: (
    model: string,
    messages: OllamaChatMessage[],
    tools: OllamaToolDefinition[],
  ) => Promise<OllamaChatResponse>;
}

/**
 * Scores a single inference attempt against the declarative scenario contract.
 */
export function scoreScenarioAttempt(
  scenario: BfclScenario,
  inference: ParsedToolInference,
): { passed: boolean; reason?: string } {
  if (inference.isMalformed) {
    return {
      passed: false,
      reason: inference.malformedReason ?? 'Malformed model output',
    };
  }

  switch (scenario.discipline) {
    case 'simple_tools': {
      if (inference.tools.length !== 1) {
        return {
          passed: false,
          reason: `Expected exactly 1 tool call, got ${inference.tools.length}`,
        };
      }
      const tool = inference.tools[0];
      if (tool.name !== scenario.expected_tool) {
        return {
          passed: false,
          reason: `Expected tool ${scenario.expected_tool}, got ${tool.name}`,
        };
      }
      if (scenario.expected_args) {
        for (const [key, expectedVal] of Object.entries(scenario.expected_args)) {
          if (tool.arguments[key] !== expectedVal) {
            return {
              passed: false,
              reason: `Argument mismatch for ${key}: expected ${String(expectedVal)}, got ${String(tool.arguments[key])}`,
            };
          }
        }
      }
      return { passed: true };
    }

    case 'parallel_tools': {
      const expectedTools = scenario.expected_tools ?? [];
      if (inference.tools.length !== expectedTools.length) {
        return {
          passed: false,
          reason: `Expected ${expectedTools.length} parallel tool calls, got ${inference.tools.length}`,
        };
      }
      const actualNames = inference.tools.map((t) => t.name).sort();
      const expectedNames = [...expectedTools].sort();
      for (let i = 0; i < expectedNames.length; i++) {
        if (actualNames[i] !== expectedNames[i]) {
          return {
            passed: false,
            reason: `Parallel tool call mismatch: expected [${expectedNames.join(', ')}], got [${actualNames.join(', ')}]`,
          };
        }
      }
      return { passed: true };
    }

    case 'nested_tools': {
      // Nested tool-call sequence proposal conformance
      const expectedSeq = scenario.expected_tool_sequence ?? [];
      if (inference.tools.length !== expectedSeq.length) {
        return {
          passed: false,
          reason: `Expected sequence length ${expectedSeq.length}, got ${inference.tools.length}`,
        };
      }
      for (let i = 0; i < expectedSeq.length; i++) {
        if (inference.tools[i].name !== expectedSeq[i]) {
          return {
            passed: false,
            reason: `Sequence proposal mismatch at index ${i}: expected ${expectedSeq[i]}, got ${inference.tools[i].name}`,
          };
        }
      }
      return { passed: true };
    }

    case 'relevance_rejection': {
      if (inference.tools.length > 0) {
        return {
          passed: false,
          reason: `Expected 0 tool calls for relevance rejection prompt, got ${inference.tools.length}`,
        };
      }
      if (!inference.rawContent || inference.rawContent.trim().length === 0) {
        return {
          passed: false,
          reason: 'Model returned empty response content for relevance rejection prompt',
        };
      }
      return { passed: true };
    }

    default:
      return { passed: false, reason: `Unknown discipline: ${scenario.discipline}` };
  }
}

/**
 * Computes population variance from binary attempt outcomes (0 for fail, 1 for pass).
 */
function computeVariance(outcomes: number[]): number {
  if (outcomes.length <= 1) return 0;
  const mean = outcomes.reduce((sum, v) => sum + v, 0) / outcomes.length;
  const sumSqDiff = outcomes.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0);
  return parseFloat((sumSqDiff / outcomes.length).toFixed(4));
}

/**
 * Runs empirical BFCL benchmark evaluation for a single model across multiple sampled attempts.
 */
export async function evaluateModelEmpirical(
  model: string,
  scenarios: BfclScenario[],
  options: EmpiricalEvaluationOptions = {},
): Promise<BfclEmpiricalMetrics> {
  const samplesPerScenario = options.samplesPerScenario ?? 3;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const chatExecutor =
    options.customChatExecutor ??
    ((m, msgs, tools) => executeOllamaChat(m, msgs, tools, { host: options.host, timeoutMs }));

  const attempts: ScenarioAttemptResult[] = [];
  let nativeToolCallCount = 0;
  let fencedJsonCount = 0;
  let plainTextCount = 0;
  let malformedCount = 0;
  let timeoutCount = 0;

  for (const scenario of scenarios) {
    for (let i = 0; i < samplesPerScenario; i++) {
      const messages: OllamaChatMessage[] = [{ role: 'user', content: scenario.prompt }];

      try {
        const response = await chatExecutor(model, messages, scenario.available_tools);
        const inference = parseToolInference(response, scenario.available_tools);

        if (inference.isMalformed) {
          malformedCount++;
        } else if (inference.source === 'native_tool_calls') {
          nativeToolCallCount++;
        } else if (inference.source === 'fenced_json') {
          fencedJsonCount++;
        } else if (inference.source === 'none') {
          plainTextCount++;
        }

        const score = scoreScenarioAttempt(scenario, inference);
        attempts.push({
          scenarioId: scenario.id,
          discipline: scenario.discipline,
          attemptIndex: i + 1,
          passed: score.passed,
          parserSource: inference.source,
          isMalformed: inference.isMalformed,
          isTimeout: false,
          reason: score.reason,
        });
      } catch (err) {
        const isTimeout = (err as Error).message.toLowerCase().includes('time');
        if (isTimeout) {
          timeoutCount++;
        } else {
          malformedCount++;
        }

        attempts.push({
          scenarioId: scenario.id,
          discipline: scenario.discipline,
          attemptIndex: i + 1,
          passed: false,
          parserSource: 'none',
          isMalformed: !isTimeout,
          isTimeout,
          reason: (err as Error).message,
        });
      }
    }
  }

  // Calculate per-discipline metrics
  const disciplineOutcomes: Record<string, number[]> = {
    simple_tools: [],
    parallel_tools: [],
    nested_tools: [],
    relevance_rejection: [],
  };

  for (const att of attempts) {
    if (disciplineOutcomes[att.discipline]) {
      disciplineOutcomes[att.discipline].push(att.passed ? 1 : 0);
    }
  }

  const calcMean = (arr: number[]) =>
    arr.length > 0
      ? parseFloat((arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(2))
      : 0.0;

  const simpleAcc = calcMean(disciplineOutcomes.simple_tools);
  const parallelAcc = calcMean(disciplineOutcomes.parallel_tools);
  const nestedAcc = calcMean(disciplineOutcomes.nested_tools);
  const rejectionAcc = calcMean(disciplineOutcomes.relevance_rejection);

  const disciplineScores: BfclMetrics = {
    simple_tool_call_accuracy: simpleAcc,
    parallel_tool_call_accuracy: parallelAcc,
    nested_tool_call_accuracy: nestedAcc,
    relevance_rejection_rate: rejectionAcc,
  };

  const disciplineVariances = {
    simple_tool_variance: computeVariance(disciplineOutcomes.simple_tools),
    parallel_tool_variance: computeVariance(disciplineOutcomes.parallel_tools),
    nested_tool_variance: computeVariance(disciplineOutcomes.nested_tools),
    relevance_rejection_variance: computeVariance(disciplineOutcomes.relevance_rejection),
  };

  const totalAttempts = attempts.length;
  const successfulAttempts = attempts.filter((a) => a.passed).length;
  const compositePassRate = parseFloat(
    ((simpleAcc + parallelAcc + nestedAcc + rejectionAcc) / 4).toFixed(3),
  );

  const scenarioBreakdown = scenarios.map((sc) => {
    const scAttempts = attempts.filter((a) => a.scenarioId === sc.id);
    const passedCount = scAttempts.filter((a) => a.passed).length;
    const timeoutsCount = scAttempts.filter((a) => a.isTimeout).length;
    const malformedCount = scAttempts.filter((a) => a.isMalformed).length;
    return {
      scenario_id: sc.id,
      discipline: sc.discipline,
      attempts_count: scAttempts.length,
      passed_count: passedCount,
      pass_rate: scAttempts.length > 0 ? parseFloat((passedCount / scAttempts.length).toFixed(2)) : 0,
      timeouts_count: timeoutsCount,
      malformed_count: malformedCount,
    };
  });

  return {
    samples_per_scenario: samplesPerScenario,
    total_attempts: totalAttempts,
    successful_attempts: successfulAttempts,
    composite_pass_rate: compositePassRate,
    discipline_scores: disciplineScores,
    discipline_variances: disciplineVariances,
    parser_breakdown: {
      native_tool_call_count: nativeToolCallCount,
      fenced_json_count: fencedJsonCount,
      plain_text_count: plainTextCount,
      malformed_count: malformedCount,
      timeout_count: timeoutCount,
    },
    scenario_breakdown: scenarioBreakdown,
  };
}

