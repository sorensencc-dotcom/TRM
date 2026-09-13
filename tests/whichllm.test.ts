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
  resolveHardwareProfile,
  runWhichLlmEvaluator,
  verifyArtifactHash,
  writeArtifactAtomically,
} from '../src/whichllm/evaluator';
import { discoverOllamaModels } from '../src/whichllm/ollamaClient';
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
      expect(estimateParameterSizeB('unknown-format-model')).toBeNull();
    });

    it('classifies VRAM fit accurately against 24GB hardware profile', () => {
      const hw = { ...DEFAULT_HARDWARE_PROFILE, vram_gb: 24 };

      // Frontier models fit easily
      expect(calculateVramFit('claude-3-5-sonnet', true, hw).fitStatus).toBe('fits_easily');

      // 8B model fits easily: 8*0.7 + 4 = 9.6 GB <= 24 GB
      expect(calculateVramFit('llama3:8b-instruct-fp16', false, hw).fitStatus).toBe('fits_easily');

      // 26B model: 26*0.7 + 4 = 22.2 GB (> 20 GB, <= 24 GB) -> tight_vram_warning
      expect(calculateVramFit('gemma4:26b', false, hw).fitStatus).toBe('tight_vram_warning');

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

  describe('Ollama Client Discovery & Failure Modes', () => {
    it('fails closed when HTTP API is unreachable and CLI fallback is disabled', async () => {
      await expect(
        discoverOllamaModels({
          host: 'http://127.0.0.1:59999', // non-existent port
          timeoutMs: 500,
          allowCliFallback: false,
        }),
      ).rejects.toThrow(/Failed to discover models via Ollama HTTP endpoint/);
    });

    it('fails closed when both HTTP API and CLI fallback fail', async () => {
      await expect(
        discoverOllamaModels({
          host: 'http://127.0.0.1:59999',
          timeoutMs: 500,
          allowCliFallback: true,
        }),
      ).rejects.toThrow(/Failed to discover models via both HTTP endpoint and CLI fallback/);
    });
  });

  describe('Evaluator Core, Self-Integrity Hashing & Atomic Writes', () => {
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

    it('handles zero local models gracefully with null anchor', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-whichllm-zero-'));
      const outputPath = path.join(tmpDir, 'model_selection.json');

      try {
        const result = await runWhichLlmEvaluator({
          outputPath,
          dryRun: false,
          injectedModels: [], // 0 models installed
        });

        expect(result.artifact.recommendations.local_muscle_anchor).toBeNull();
        expect(result.artifact.recommendations.local_fit_reasoning).toBe(
          'No local models available in Ollama inventory.',
        );
        expect(result.artifact.recommendations.frontier_judgment_anchor).toBe('claude-3-5-sonnet-20241022');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('writes artifact atomically without corrupting destination', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-whichllm-atomic-'));
      const outputPath = path.join(tmpDir, 'model_selection.json');

      try {
        const testArtifact = {
          evaluated_at: new Date().toISOString(),
          hardware_profile: DEFAULT_HARDWARE_PROFILE,
          test_suite_coverage: {
            total_bfcl_scenarios: 4,
            scenarios_run: [],
          },
          recommendations: {
            frontier_judgment_anchor: 'claude-3-5-sonnet-20241022',
            local_muscle_anchor: 'qwen2.5:7b',
            local_fit_reasoning: 'Clean fit.',
          },
          ranked_candidates: [],
          lineage: {
            contract_type: 'extractor-upgrade-sweep',
            schema_version: '2.4.0',
            provenance_flags: [],
          },
          hash_chain_self: 'dummy',
        };

        writeArtifactAtomically(outputPath, testArtifact);
        expect(fs.existsSync(outputPath)).toBe(true);
        const parsed = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
        expect(parsed.recommendations.local_muscle_anchor).toBe('qwen2.5:7b');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('resolves hardware profile with RAM host probing and fallback handling', () => {
      const result = resolveHardwareProfile();
      expect(result.hardware.gpu_name).toBe('NVIDIA RTX 4090');
      expect(result.hardware.ram_gb).toBeGreaterThan(0);
      expect(result.source).toBe('configured_default_with_host_ram_probe');

      const injectedHw = { gpu_count: 2, gpu_name: 'A100', vram_gb: 80, ram_gb: 256 };
      const injectedRes = resolveHardwareProfile(undefined, injectedHw);
      expect(injectedRes.hardware.gpu_name).toBe('A100');
      expect(injectedRes.source).toBe('injected_override');
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

  describe('Automated Research Cascade Dispatcher (Multi-Tier Cloud Fallback)', () => {
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

    it('cascades through 2 cloud providers: Local -> Claude (429) -> Antigravity (Gemini)', async () => {
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

    it('cascades through 3 cloud providers: Local -> Claude (429) -> Antigravity (503) -> Codex (OpenAI)', async () => {
      const result = await dispatchWithCascade({
        prompt: 'test prompt',
        executor: async (provider) => {
          if (provider === 'local') throw new Error('Local daemon OOM');
          if (provider === 'claude') throw new Error('HTTP 429 Rate Limit Exceeded');
          if (provider === 'antigravity') throw new Error('HTTP 503 Service Unavailable');
          if (provider === 'codex') return 'OpenAI GPT-4o success';
          throw new Error('Should not reach here');
        },
      });

      expect(result.executingProvider).toBe('codex');
      expect(result.executingModel).toBe('gpt-4o');
      expect(result.fallbackCount).toBe(3);
      expect(result.attemptedProviders).toEqual(['local', 'claude', 'antigravity', 'codex']);
    });

    it('cascades through 4 cloud providers: Local -> Claude -> Antigravity -> Codex -> Grok (xAI)', async () => {
      const result = await dispatchWithCascade({
        prompt: 'test prompt',
        executor: async (provider) => {
          if (provider === 'local') throw new Error('Local offline');
          if (provider === 'claude') throw new Error('429 Claude rate limit');
          if (provider === 'antigravity') throw new Error('429 Gemini rate limit');
          if (provider === 'codex') throw new Error('429 OpenAI rate limit');
          if (provider === 'grok') return 'Grok-2 success';
          throw new Error('Should not reach here');
        },
      });

      expect(result.executingProvider).toBe('grok');
      expect(result.executingModel).toBe('grok-2');
      expect(result.fallbackCount).toBe(4);
      expect(result.attemptedProviders).toEqual(['local', 'claude', 'antigravity', 'codex', 'grok']);

      const rateLimitEvents = reporter.findEventsByType('RATE_LIMIT_ADVANCEMENT');
      expect(rateLimitEvents.length).toBe(3); // Claude -> Antigravity, Antigravity -> Codex, Codex -> Grok
    });

    it('emits CRITICAL event and throws when all 5 cascade providers are exhausted', async () => {
      await expect(
        dispatchWithCascade({
          prompt: 'test prompt',
          executor: async (provider) => {
            throw new Error(`${provider} failed completely`);
          },
        }),
      ).rejects.toThrow(/All cascade providers exhausted/);

      const criticalEvents = reporter.findEventsByType('WHICHLLM_DEGRADED_CASCADE');
      expect(criticalEvents.length).toBe(1);
      expect(criticalEvents[0].severity).toBe('CRITICAL');
      expect(criticalEvents[0].errorReason).toContain('local: local failed completely');
      expect(criticalEvents[0].errorReason).toContain('grok: grok failed completely');
    });

    it('respects custom isRateLimitError callback', async () => {
      const customRateLimitError = new Error('Custom vendor throttle code E_THROTTLED');

      const result = await dispatchWithCascade({
        prompt: 'test prompt',
        isRateLimitError: (err) => (err as Error).message.includes('E_THROTTLED'),
        executor: async (provider) => {
          if (provider === 'local') throw new Error('Local offline');
          if (provider === 'claude') throw customRateLimitError;
          if (provider === 'antigravity') return 'Gemini success';
          throw new Error('Should not reach here');
        },
      });

      expect(result.executingProvider).toBe('antigravity');
      expect(result.fallbackCount).toBe(2);
    });
  });
});
