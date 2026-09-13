import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BFCL_TEST_SUITE,
} from '../src/whichllm/bfclSuite';
import {
  CANONICAL_BFCL_TOOLS,
  TOOL_READ_SHARED_CONTEXT,
  TOOL_SIGIL_SEND_TASK,
} from '../src/whichllm/toolDefinitions';
import {
  MAX_CONTENT_LENGTH_BYTES,
  parseToolInference,
} from '../src/whichllm/inferenceRunner';
import {
  evaluateModelEmpirical,
  scoreScenarioAttempt,
} from '../src/whichllm/toolCallScorer';
import {
  LiveInferenceUnavailableError,
  runWhichLlmEvaluator,
  verifyArtifactHash,
  writeArtifactAtomically,
} from '../src/whichllm/evaluator';
import {
  InMemoryIcfReporter,
  setIcfTelemetryReporter,
} from '../src/telemetry/icfReporter';
import type {
  OllamaChatMessage,
  OllamaChatResponse,
  WhichLlmArtifact,
} from '../src/whichllm/types';

describe('WhichLLM Live Inference, Tool-Call Parser & Empirical Scorer', () => {
  let reporter: InMemoryIcfReporter;

  beforeEach(() => {
    reporter = new InMemoryIcfReporter();
    setIcfTelemetryReporter(reporter);
  });

  describe('Tool-Call Parser (Native & Strict Fenced JSON)', () => {
    it('parses structured native tool_calls accurately', () => {
      const response: OllamaChatResponse = {
        model: 'llama3:8b',
        created_at: new Date().toISOString(),
        done: true,
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              function: {
                name: 'sigil.core/read_shared_context',
                arguments: {
                  path: 'wiki/research/mobile-websocket-heartbeats.md',
                },
              },
            },
          ],
        },
      };

      const parsed = parseToolInference(response, CANONICAL_BFCL_TOOLS);
      expect(parsed.source).toBe('native_tool_calls');
      expect(parsed.isMalformed).toBe(false);
      expect(parsed.tools.length).toBe(1);
      expect(parsed.tools[0].name).toBe('sigil.core/read_shared_context');
      expect(parsed.tools[0].arguments.path).toBe('wiki/research/mobile-websocket-heartbeats.md');
    });

    it('rejects native tool calls with unapproved tool names', () => {
      const response: OllamaChatResponse = {
        model: 'llama3:8b',
        created_at: new Date().toISOString(),
        done: true,
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              function: {
                name: 'unauthorized_dangerous_exec',
                arguments: { cmd: 'rm -rf /' },
              },
            },
          ],
        },
      };

      const parsed = parseToolInference(response, CANONICAL_BFCL_TOOLS);
      expect(parsed.isMalformed).toBe(true);
      expect(parsed.malformedReason).toContain('unapproved tool name');
    });

    it('parses valid single fenced JSON code block', () => {
      const response: OllamaChatResponse = {
        model: 'llama3:8b',
        created_at: new Date().toISOString(),
        done: true,
        message: {
          role: 'assistant',
          content: 'Here is the requested tool call:\n```json\n{\n  "name": "sigil.core/read_shared_context",\n  "arguments": {\n    "path": "wiki/research/test.md"\n  }\n}\n```\n',
        },
      };

      const parsed = parseToolInference(response, CANONICAL_BFCL_TOOLS);
      expect(parsed.source).toBe('fenced_json');
      expect(parsed.isMalformed).toBe(false);
      expect(parsed.tools.length).toBe(1);
      expect(parsed.tools[0].name).toBe('sigil.core/read_shared_context');
      expect(parsed.tools[0].arguments.path).toBe('wiki/research/test.md');
    });

    it('parses fenced JSON array of multiple parallel tool calls', () => {
      const response: OllamaChatResponse = {
        model: 'llama3:8b',
        created_at: new Date().toISOString(),
        done: true,
        message: {
          role: 'assistant',
          content: '```json\n[\n  {"name": "sigil_send_task", "arguments": {"conversation_id": "conv_1"}},\n  {"name": "sigil_send_task", "arguments": {"conversation_id": "conv_2"}}\n]\n```',
        },
      };

      const parsed = parseToolInference(response, CANONICAL_BFCL_TOOLS);
      expect(parsed.source).toBe('fenced_json');
      expect(parsed.isMalformed).toBe(false);
      expect(parsed.tools.length).toBe(2);
      expect(parsed.tools[0].name).toBe('sigil_send_task');
      expect(parsed.tools[1].name).toBe('sigil_send_task');
    });

    it('rejects response exceeding 16KB content limit', () => {
      const hugeContent = 'a'.repeat(MAX_CONTENT_LENGTH_BYTES + 50);
      const response: OllamaChatResponse = {
        model: 'llama3:8b',
        created_at: new Date().toISOString(),
        done: true,
        message: {
          role: 'assistant',
          content: hugeContent,
        },
      };

      const parsed = parseToolInference(response, CANONICAL_BFCL_TOOLS);
      expect(parsed.isMalformed).toBe(true);
      expect(parsed.malformedReason).toContain('exceeded maximum limit');
    });

    it('rejects responses with multiple ambiguous code blocks', () => {
      const response: OllamaChatResponse = {
        model: 'llama3:8b',
        created_at: new Date().toISOString(),
        done: true,
        message: {
          role: 'assistant',
          content: 'Option 1:\n```json\n{"name": "sigil_send_task", "arguments": {"conversation_id": "1"}}\n```\nOption 2:\n```json\n{"name": "sigil_send_task", "arguments": {"conversation_id": "2"}}\n```',
        },
      };

      const parsed = parseToolInference(response, CANONICAL_BFCL_TOOLS);
      expect(parsed.isMalformed).toBe(true);
      expect(parsed.malformedReason).toContain('Ambiguous response: contained 2 distinct code blocks');
    });

    it('does not count conversational prose mentioning tool names as tool calls', () => {
      const response: OllamaChatResponse = {
        model: 'llama3:8b',
        created_at: new Date().toISOString(),
        done: true,
        message: {
          role: 'assistant',
          content: 'You should use sigil.core/read_shared_context to read the file, but I cannot execute it.',
        },
      };

      const parsed = parseToolInference(response, CANONICAL_BFCL_TOOLS);
      expect(parsed.source).toBe('none');
      expect(parsed.isMalformed).toBe(false);
      expect(parsed.tools.length).toBe(0);
    });

    it('rejects fenced JSON failing argument schema requirements', () => {
      const response: OllamaChatResponse = {
        model: 'llama3:8b',
        created_at: new Date().toISOString(),
        done: true,
        message: {
          role: 'assistant',
          content: '```json\n{\n  "name": "sigil.core/read_shared_context",\n  "arguments": {\n    "wrong_key": 123\n  }\n}\n```',
        },
      };

      const parsed = parseToolInference(response, CANONICAL_BFCL_TOOLS);
      expect(parsed.isMalformed).toBe(true);
      expect(parsed.malformedReason).toContain('failed schema validation');
    });
  });

  describe('Scenario Scoring & Discipline Evaluation', () => {
    it('scores simple tool call passing on matching name and arguments', () => {
      const scenario = BFCL_TEST_SUITE[0]; // simple read
      const inference = {
        source: 'native_tool_calls' as const,
        tools: [
          {
            name: 'sigil.core/read_shared_context',
            arguments: { path: 'wiki/research/mobile-websocket-heartbeats.md' },
          },
        ],
        rawContent: '',
        isMalformed: false,
      };

      const score = scoreScenarioAttempt(scenario, inference);
      expect(score.passed).toBe(true);
    });

    it('fails simple tool call scenario when extra unrequested tool calls are present', () => {
      const scenario = BFCL_TEST_SUITE[0];
      const inference = {
        source: 'native_tool_calls' as const,
        tools: [
          {
            name: 'sigil.core/read_shared_context',
            arguments: { path: 'wiki/research/mobile-websocket-heartbeats.md' },
          },
          {
            name: 'sigil_send_task',
            arguments: { conversation_id: 'conv_1' },
          },
        ],
        rawContent: '',
        isMalformed: false,
      };

      const score = scoreScenarioAttempt(scenario, inference);
      expect(score.passed).toBe(false);
      expect(score.reason).toContain('Expected exactly 1 tool call, got 2');
    });

    it('scores parallel tool call multiset match accurately', () => {
      const scenario = BFCL_TEST_SUITE[1]; // parallel dispatch
      const inference = {
        source: 'native_tool_calls' as const,
        tools: [
          { name: 'sigil_send_task', arguments: { conversation_id: 'conv_1' } },
          { name: 'sigil_send_task', arguments: { conversation_id: 'conv_2' } },
        ],
        rawContent: '',
        isMalformed: false,
      };

      const score = scoreScenarioAttempt(scenario, inference);
      expect(score.passed).toBe(true);
    });

    it('scores nested tool-call sequence proposal conformance in exact order', () => {
      const scenario = BFCL_TEST_SUITE[2]; // nested resolver
      const inference = {
        source: 'native_tool_calls' as const,
        tools: [
          { name: 'trm_fetch_findings', arguments: { topic_id: 'top_1' } },
          { name: 'trm_source_resolver', arguments: { source_id: 'src_1' } },
        ],
        rawContent: '',
        isMalformed: false,
      };

      const score = scoreScenarioAttempt(scenario, inference);
      expect(score.passed).toBe(true);

      // Fails if proposed out of order
      const reversedInference = {
        ...inference,
        tools: [
          { name: 'trm_source_resolver', arguments: { source_id: 'src_1' } },
          { name: 'trm_fetch_findings', arguments: { topic_id: 'top_1' } },
        ],
      };
      const badScore = scoreScenarioAttempt(scenario, reversedInference);
      expect(badScore.passed).toBe(false);
      expect(badScore.reason).toContain('Sequence proposal mismatch');
    });

    it('scores relevance rejection passing only when 0 tools called and prose returned', () => {
      const scenario = BFCL_TEST_SUITE[3]; // relevance rejection
      const passingInference = {
        source: 'none' as const,
        tools: [],
        rawContent: 'The Willow Run plant was built in 1941 by Henry Ford.',
        isMalformed: false,
      };

      expect(scoreScenarioAttempt(scenario, passingInference).passed).toBe(true);

      const failingInference = {
        source: 'native_tool_calls' as const,
        tools: [{ name: 'sigil.core/read_shared_context', arguments: { path: 'wiki' } }],
        rawContent: '',
        isMalformed: false,
      };

      const failScore = scoreScenarioAttempt(scenario, failingInference);
      expect(failScore.passed).toBe(false);
      expect(failScore.reason).toContain('Expected 0 tool calls for relevance rejection');
    });
  });

  describe('Empirical Multi-Sample Evaluator & Variance Computation', () => {
    it('executes sampled attempts and computes discipline accuracies and variances', async () => {
      // Mock chat executor simulating 100% pass on simple & parallel, 66% on nested, 100% on rejection
      let callCount = 0;
      const customExecutor = async (
        model: string,
        messages: OllamaChatMessage[],
      ): Promise<OllamaChatResponse> => {
        callCount++;
        const prompt = messages[0]?.content ?? '';

        if (prompt.includes('read_shared_context')) {
          return {
            model,
            created_at: new Date().toISOString(),
            done: true,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  function: {
                    name: 'sigil.core/read_shared_context',
                    arguments: { path: 'wiki/research/mobile-websocket-heartbeats.md' },
                  },
                },
              ],
            },
          };
        }

        if (prompt.includes('conv_willow_run')) {
          return {
            model,
            created_at: new Date().toISOString(),
            done: true,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                { function: { name: 'sigil_send_task', arguments: { conversation_id: 'conv_1' } } },
                { function: { name: 'sigil_send_task', arguments: { conversation_id: 'conv_2' } } },
              ],
            },
          };
        }

        if (prompt.includes('resolve the corresponding upstream source ID')) {
          // Flake 1 out of 3 times
          if (callCount % 3 === 0) {
            return {
              model,
              created_at: new Date().toISOString(),
              done: true,
              message: {
                role: 'assistant',
                content: '```json\n{"wrong": 123}\n```',
              },
            };
          }
          return {
            model,
            created_at: new Date().toISOString(),
            done: true,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                { function: { name: 'trm_fetch_findings', arguments: { topic_id: 't1' } } },
                { function: { name: 'trm_source_resolver', arguments: { source_id: 's1' } } },
              ],
            },
          };
        }

        // Relevance rejection
        return {
          model,
          created_at: new Date().toISOString(),
          done: true,
          message: {
            role: 'assistant',
            content: 'Historical timeline synthesized directly from knowledge base.',
          },
        };
      };

      const metrics = await evaluateModelEmpirical('test-model:8b', BFCL_TEST_SUITE, {
        samplesPerScenario: 3,
        customChatExecutor: customExecutor,
      });

      expect(metrics.samples_per_scenario).toBe(3);
      expect(metrics.total_attempts).toBe(12); // 4 scenarios * 3 samples
      expect(metrics.discipline_scores.simple_tool_call_accuracy).toBe(1.0);
      expect(metrics.discipline_scores.parallel_tool_call_accuracy).toBe(1.0);
      expect(metrics.discipline_scores.nested_tool_call_accuracy).toBeCloseTo(0.67, 1);
      expect(metrics.discipline_scores.relevance_rejection_rate).toBe(1.0);
      expect(metrics.composite_pass_rate).toBeGreaterThan(0.85);
      expect(metrics.discipline_variances.nested_tool_variance).toBeGreaterThan(0);
    });
  });

  describe('Live Inference Fail-Closed Semantics & Artifact Protection', () => {
    it('fails closed with LiveInferenceUnavailableError when Ollama daemon is unreachable in live mode', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-live-unavail-'));
      const outputPath = path.join(tmpDir, 'model_selection.json');

      try {
        // Pre-create a valid existing artifact
        const preExisting = {
          evaluated_at: '2026-09-01T00:00:00.000Z',
          hardware_profile: { gpu_count: 1, gpu_name: 'RTX 4090', vram_gb: 24, ram_gb: 64 },
          test_suite_coverage: { total_bfcl_scenarios: 4, scenarios_run: [] },
          recommendations: {
            frontier_judgment_anchor: 'claude-3-5-sonnet-20241022',
            local_muscle_anchor: 'previous-valid-model',
            local_fit_reasoning: 'Fit well.',
          },
          ranked_candidates: [],
          lineage: { contract_type: 'extractor-upgrade-sweep', schema_version: '2.4.0', provenance_flags: [], evaluation_mode: 'heuristic' as const, evaluated_at: '2026-09-01T00:00:00.000Z' },
          hash_chain_self: 'valid_hash',
        };
        fs.writeFileSync(outputPath, JSON.stringify(preExisting), 'utf8');

        // Execute evaluator with liveInference: true pointing to non-existent port
        await expect(
          runWhichLlmEvaluator({
            outputPath,
            liveInference: true,
            discoveryOptions: { host: 'http://127.0.0.1:59998', timeoutMs: 300 },
          }),
        ).rejects.toThrow(LiveInferenceUnavailableError);

        // Verify the pre-existing artifact was NOT touched or overwritten
        expect(fs.existsSync(outputPath)).toBe(true);
        const onDisk = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
        expect(onDisk.recommendations.local_muscle_anchor).toBe('previous-valid-model');

        // Verify ICF CRITICAL telemetry event
        const critEvents = reporter.findEventsByType('LIVE_INFERENCE_UNAVAILABLE');
        expect(critEvents.length).toBe(1);
        expect(critEvents[0].severity).toBe('CRITICAL');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('executes empirical evaluation and updates artifact atomically when live inference passes', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-live-pass-'));
      const outputPath = path.join(tmpDir, 'model_selection.json');

      try {
        const mockExecutor = async (model: string): Promise<OllamaChatResponse> => ({
          model,
          created_at: new Date().toISOString(),
          done: true,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                function: {
                  name: 'sigil.core/read_shared_context',
                  arguments: { path: 'wiki/research/mobile-websocket-heartbeats.md' },
                },
              },
            ],
          },
        });

        const result = await runWhichLlmEvaluator({
          outputPath,
          liveInference: true,
          injectedModels: ['llama3:8b-instruct-fp16'],
          samplesPerScenario: 2,
          customChatExecutor: mockExecutor,
        });

        expect(result.artifact.lineage.evaluation_mode).toBe('empirical');
        expect(result.artifact.lineage.provenance_flags).toContain('live_bfcl_inference');
        const localCand = result.artifact.ranked_candidates.find((c) => c.tier === 'Tier 2 (Muscle)');
        expect(localCand).toBeDefined();
        expect(localCand!.benchmark_matrix.evaluation_mode).toBe('empirical');
        expect(localCand!.benchmark_matrix.empirical_metrics).toBeDefined();
        expect(localCand!.benchmark_matrix.empirical_metrics?.scenario_breakdown?.length).toBe(4);
        expect(verifyArtifactHash(result.artifact)).toBe(true);

        // Since mockExecutor returns tool_calls for all scenarios including relevance rejection,
        // relevance rejection accuracy is 0%, which triggers fail-closed anchor suppression (null)
        expect(result.artifact.recommendations.local_muscle_anchor).toBeNull();
        expect(result.artifact.recommendations.local_fit_reasoning).toContain('minimum tool-safety threshold');

        // Ensure written to disk cleanly
        expect(fs.existsSync(outputPath)).toBe(true);
        const saved = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
        expect(verifyArtifactHash(saved)).toBe(true);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('allows selecting local anchor when explicit allowUnsafeRelevance override is provided', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-live-override-'));
      const outputPath = path.join(tmpDir, 'model_selection.json');

      try {
        const mockExecutor = async (model: string): Promise<OllamaChatResponse> => ({
          model,
          created_at: new Date().toISOString(),
          done: true,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                function: {
                  name: 'sigil.core/read_shared_context',
                  arguments: { path: 'wiki/research/mobile-websocket-heartbeats.md' },
                },
              },
            ],
          },
        });

        const result = await runWhichLlmEvaluator({
          outputPath,
          liveInference: true,
          injectedModels: ['llama3:8b-instruct-fp16'],
          samplesPerScenario: 2,
          allowUnsafeRelevance: true,
          customChatExecutor: mockExecutor,
        });

        expect(result.artifact.recommendations.local_muscle_anchor).toBe('llama3:8b-instruct-fp16');
        expect(result.artifact.recommendations.local_fit_reasoning).toContain('OPERATOR OVERRIDE ACTIVE');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});

