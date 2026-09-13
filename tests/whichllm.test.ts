import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BFCL_TEST_SUITE,
  calculateVramFit,
  estimateParameterSizeB,
  evaluateModelBfcl,
} from '../src/whichllm/bfclSuite';
import {
  dispatchWithCascade,
  PROVIDER_CASCADE,
  type ProviderType,
} from '../src/whichllm/cascadeDispatcher';
import {
  canonicalJson,
  computeArtifactHash,
  DEFAULT_HARDWARE_PROFILE,
  runWhichLlmEvaluator,
  verifyArtifactHash,
} from '../src/whichllm/evaluator';
import {
  getIcfTelemetryReporter,
  InMemoryIcfReporter,
  setIcfTelemetryReporter,
} from '../src/telemetry/icfReporter';

describe('WhichLLM BFCL Evaluator & Cascade Engine', () => {
  let reporter: InMemoryIcfReporter;

  beforeEach(() => {
    reporter = new InMemoryIcfReporter();
    setIcfTelemetryReporter(reporter);
  });

  describe('BFCL Suite & VRAM Fit Calculator', () => {
    it('covers all 4 mandatory BFCL disciplines', () => {
      expect(BFCL_TEST_SUITE.length).toBe(4);
      const ids = BFCL_TEST_SUITE.map((s) => s.id);
      expect(ids).toContain('bfcl-cic-001-simple-read');
      expect(ids).toContain('bfcl-cic-002-parallel-dispatch');
      expect(ids).toContain('bfcl-cic-003-nested-resolver');
      expect(ids).toContain('bfcl-cic-004-relevance-rejection');
    });

    it('estimates parameter sizes from model names', () => {
      expect(estimateParameterSizeB('llama3:8b-instruct-fp16')).toBe(8);
      expect(estimateParameterSizeB('qwen2.5:32b-instruct-q8_0')).toBe(32);
      expect(estimateParameterSizeB('llama3.1:70b-instruct-q2_k')).toBe(70);
      expect(estimateParameterSizeB('qwen2.5:72b-instruct-q4_k_m')).toBe(72);
      expect(estimateParameterSizeB('phi-3:3.5b')).toBe(3.5);
    });

    it('classifies VRAM fit accurately against 24GB hardware profile', () => {
      const hw = { ...DEFAULT_HARDWARE_PROFILE, vram_gb: 24 };

      // Frontier models fit easily
      expect(calculateVramFit('claude-3-5-sonnet', true, hw).fitStatus).toBe('fits_easily');

      // 8B model fits easily: 8*0.7 + 4 = 9.6 GB <= 24 GB
      expect(calculateVramFit('llama3:8b-instruct-fp16', false, hw).fitStatus).toBe('fits_easily');

      // 32B model: 32*0.7 + 4 = 26.4 GB > 24 GB -> out_of_vram_degraded
      expect(calculateVramFit('qwen2.5:32b-instruct-q8_0', false, hw).fitStatus).toBe('out_of_vram_degraded');

      // 70B model: 70*0.7 + 4 = 53 GB > 24 GB -> out_of_vram_degraded
      expect(calculateVramFit('llama3.1:70b-instruct-q2_k', false, hw).fitStatus).toBe('out_of_vram_degraded');
    });

    it('scores frontier and local models with appropriate penalties', () => {
      const hw = DEFAULT_HARDWARE_PROFILE;
      const frontierScore = evaluateModelBfcl('claude-3-5-sonnet-20241022', hw);
      expect(frontierScore.bfcl_composite_score).toBeGreaterThanOrEqual(0.85);
      expect(frontierScore.quantization_overhead_penalty).toBe(0.0);

      const local8bScore = evaluateModelBfcl('llama3:8b-instruct-fp16', hw);
      expect(local8bScore.quantization_overhead_penalty).toBe(0.15);
      expect(local8bScore.bfcl_composite_score).toBeLessThan(frontierScore.bfcl_composite_score);
    });
  });

  describe('Evaluator Core & Self-Integrity Hashing', () => {
    it('produces deterministic canonical JSON stringification', () => {
      const obj1 = { b: 2, a: 1, c: { y: 'bar', x: 'foo' } };
      const obj2 = { c: { x: 'foo', y: 'bar' }, a: 1, b: 2 };
      expect(canonicalJson(obj1)).toBe(canonicalJson(obj2));
    });

    it('computes and verifies SHA-256 self-integrity hash', () => {
      const payload = {
        evaluated_at: '2026-09-13T10:00:00.000Z',
        hardware_profile: DEFAULT_HARDWARE_PROFILE,
        test_suite_coverage: {
          total_bfcl_scenarios: 4,
          scenarios_run: [{ id: 'test', name: 'Test' }],
        },
        recommendations: {
          frontier_judgment_anchor: 'claude-3-5-sonnet-20241022',
          local_muscle_anchor: 'llama3:8b-instruct-fp16',
          local_fit_reasoning: 'Clean fit.',
        },
        ranked_candidates: [],
        lineage: {
          contract_type: 'extractor-upgrade-sweep',
          schema_version: '2.4.0',
          provenance_flags: ['test'],
        },
      };

      const hash = computeArtifactHash(payload);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);

      const artifact = { ...payload, hash_chain_self: hash };
      expect(verifyArtifactHash(artifact)).toBe(true);

      // Tampered artifact fails verification
      const tampered = { ...artifact, recommendations: { ...artifact.recommendations, local_muscle_anchor: 'fake' } };
      expect(verifyArtifactHash(tampered)).toBe(false);
    });

    it('executes dry-run without writing files to disk', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-whichllm-dry-'));
      const outputPath = path.join(tmpDir, 'model_selection.json');

      try {
        const result = await runWhichLlmEvaluator({
          outputPath,
          dryRun: true,
          injectedModels: ['llama3:8b-instruct-fp16', 'qwen2.5:32b-instruct-q8_0'],
        });

        expect(result.dryRun).toBe(true);
        expect(result.outputPath).toBeNull();
        expect(fs.existsSync(outputPath)).toBe(false);
        expect(result.artifact.recommendations.local_muscle_anchor).toBe('llama3:8b-instruct-fp16');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('writes verified artifact when not in dry-run', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-whichllm-write-'));
      const outputPath = path.join(tmpDir, 'model_selection.json');

      try {
        const result = await runWhichLlmEvaluator({
          outputPath,
          dryRun: false,
          injectedModels: ['llama3:8b-instruct-fp16', 'qwen2.5:32b-instruct-q8_0'],
        });

        expect(result.dryRun).toBe(false);
        expect(fs.existsSync(outputPath)).toBe(true);

        const loaded = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
        expect(verifyArtifactHash(loaded)).toBe(true);
        expect(loaded.recommendations.local_muscle_anchor).toBe('llama3:8b-instruct-fp16');
        expect(loaded.recommendations.frontier_judgment_anchor).toBe('claude-3-5-sonnet-20241022');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('Automated Research Cascade Dispatcher', () => {
    it('executes on local provider when healthy with 0 fallbacks', async () => {
      const result = await dispatchWithCascade({
        prompt: 'test prompt',
        localModelAnchor: 'llama3:8b-instruct-fp16',
        executor: async (provider, model, prompt) => {
          return `Response from ${provider}:${model}`;
        },
      });

      expect(result.executingProvider).toBe('local');
      expect(result.executingModel).toBe('llama3:8b-instruct-fp16');
      expect(result.fallbackCount).toBe(0);
      expect(result.attemptedProviders).toEqual(['local']);
    });

    it('falls back from local to Claude on local failure and logs warning', async () => {
      const result = await dispatchWithCascade({
        prompt: 'test prompt',
        localModelAnchor: 'llama3:8b-instruct-fp16',
        executor: async (provider, model) => {
          if (provider === 'local') {
            throw new Error('Local daemon connection refused (ECONNREFUSED)');
          }
          return `Response from ${provider}:${model}`;
        },
      });

      expect(result.executingProvider).toBe('claude');
      expect(result.fallbackCount).toBe(1);
      expect(result.attemptedProviders).toEqual(['local', 'claude']);

      const localFailures = reporter.findEventsByType('LOCAL_MODEL_FAILURE');
      expect(localFailures.length).toBe(1);
      expect(localFailures[0].severity).toBe('WARN');
      expect(localFailures[0].modelName).toBe('llama3:8b-instruct-fp16');
    });

    it('cascades through rate-limited providers to reach healthy provider', async () => {
      const result = await dispatchWithCascade({
        prompt: 'test prompt',
        executor: async (provider) => {
          if (provider === 'local') throw new Error('Ollama offline');
          if (provider === 'claude') throw new Error('HTTP 429 Too Many Requests');
          if (provider === 'antigravity') return 'Gemini response success';
          throw new Error('Should not reach here');
        },
      });

      expect(result.executingProvider).toBe('antigravity');
      expect(result.fallbackCount).toBe(2);
      expect(result.attemptedProviders).toEqual(['local', 'claude', 'antigravity']);

      const rateLimitEvents = reporter.findEventsByType('RATE_LIMIT_ADVANCEMENT');
      expect(rateLimitEvents.length).toBe(1);
      expect(rateLimitEvents[0].fallbackTarget).toBe('Antigravity (Gemini)');
    });

    it('emits CRITICAL event and throws when all cascade providers are exhausted', async () => {
      await expect(
        dispatchWithCascade({
          prompt: 'test prompt',
          executor: async () => {
            throw new Error('Provider down');
          },
        }),
      ).rejects.toThrow('All cascade providers exhausted');

      const criticalEvents = reporter.findEventsByType('WHICHLLM_DEGRADED_CASCADE');
      expect(criticalEvents.length).toBe(1);
      expect(criticalEvents[0].severity).toBe('CRITICAL');
    });
  });
});
