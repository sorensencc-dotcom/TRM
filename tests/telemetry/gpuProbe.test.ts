import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseNvidiaSmiCsv,
  probeNvidiaGpu,
  probeNvidiaGpuSync,
  tokenizeCsvLine,
} from '../../src/telemetry/gpuProbe';
import {
  DEFAULT_HARDWARE_PROFILE,
  resolveHardwareProfile,
  resolveHardwareProfileSync,
} from '../../src/whichllm/evaluator';

describe('TRM GPU Hardware Telemetry & VRAM Probe', () => {
  describe('RFC 4180 CSV Tokenizer', () => {
    it('tokenizes simple comma-separated fields', () => {
      const line = 'NVIDIA GeForce RTX 4090, 24564, 22000, 2564';
      const tokens = tokenizeCsvLine(line);
      expect(tokens).toEqual(['NVIDIA GeForce RTX 4090', '24564', '22000', '2564']);
    });

    it('handles commas inside quoted GPU names', () => {
      const line = '"NVIDIA RTX 4090, Founder\'s Edition", 24564, 22000, 2564';
      const tokens = tokenizeCsvLine(line);
      expect(tokens).toEqual(["NVIDIA RTX 4090, Founder's Edition", '24564', '22000', '2564']);
    });

    it('handles escaped quotes inside quoted fields', () => {
      const line = '"NVIDIA ""Super"" Edition", 12288, 10000, 2288';
      const tokens = tokenizeCsvLine(line);
      expect(tokens).toEqual(['NVIDIA "Super" Edition', '12288', '10000', '2288']);
    });
  });

  describe('parseNvidiaSmiCsv & Aggregation Semantics', () => {
    it('parses single GPU output accurately', () => {
      const stdout = 'NVIDIA GeForce RTX 4090, 24564, 22000, 2564\n';
      const result = parseNvidiaSmiCsv(stdout);

      expect(result.available).toBe(true);
      if (result.available) {
        expect(result.gpu_count).toBe(1);
        expect(result.gpu_name).toBe('NVIDIA GeForce RTX 4090');
        expect(result.vram_gb).toBe(24);
        expect(result.vram_free_gb).toBe(21);
        expect(result.vram_used_gb).toBe(3);
        expect(result.individual_gpus?.length).toBe(1);
      }
    });

    it('aggregates multiple identical GPUs accurately', () => {
      const stdout = [
        'NVIDIA GeForce RTX 4090, 24564, 22000, 2564',
        'NVIDIA GeForce RTX 4090, 24564, 21000, 3564',
      ].join('\n');

      const result = parseNvidiaSmiCsv(stdout);
      expect(result.available).toBe(true);
      if (result.available) {
        expect(result.gpu_count).toBe(2);
        expect(result.gpu_name).toBe('NVIDIA GeForce RTX 4090');
        expect(result.vram_gb).toBe(48);
        expect(result.vram_free_gb).toBe(42);
        expect(result.vram_used_gb).toBe(6);
      }
    });

    it('aggregates multiple mixed GPUs with sorted mixed label', () => {
      const stdout = [
        'NVIDIA GeForce RTX 4090, 24564, 20000, 4564',
        'NVIDIA GeForce RTX 3090, 24564, 18000, 6564',
      ].join('\n');

      const result = parseNvidiaSmiCsv(stdout);
      expect(result.available).toBe(true);
      if (result.available) {
        expect(result.gpu_count).toBe(2);
        expect(result.gpu_name).toBe('mixed (NVIDIA GeForce RTX 3090, NVIDIA GeForce RTX 4090)');
        expect(result.vram_gb).toBe(48);
      }
    });

    it('rejects empty or whitespace output', () => {
      const result = parseNvidiaSmiCsv('   \n  \n');
      expect(result.available).toBe(false);
      if (!result.available) {
        expect(result.error).toContain('Empty output');
      }
    });

    it('rejects rows with incorrect column counts', () => {
      const result = parseNvidiaSmiCsv('NVIDIA RTX 4090, 24564, 22000'); // 3 columns
      expect(result.available).toBe(false);
      if (!result.available) {
        expect(result.error).toContain('expected 4 columns');
      }
    });

    it('rejects rows with negative or non-finite numbers', () => {
      const negResult = parseNvidiaSmiCsv('NVIDIA RTX 4090, -24564, 22000, 0');
      expect(negResult.available).toBe(false);

      const nanResult = parseNvidiaSmiCsv('NVIDIA RTX 4090, NaN, 22000, 0');
      expect(nanResult.available).toBe(false);
    });
  });

  describe('Non-blocking probeNvidiaGpu with Injected Executor', () => {
    it('resolves probe successfully with mock executor', async () => {
      const mockExecutor = async () => 'NVIDIA A100-SXM4-80GB, 81920, 75000, 6920\n';
      const result = await probeNvidiaGpu({ executor: mockExecutor, timeoutMs: 1000 });

      expect(result.available).toBe(true);
      if (result.available) {
        expect(result.gpu_name).toBe('NVIDIA A100-SXM4-80GB');
        expect(result.vram_gb).toBe(80);
      }
    });

    it('handles mock executor failure/timeout gracefully', async () => {
      const mockExecutor = async () => {
        throw new Error('Command timed out after 1500ms');
      };
      const result = await probeNvidiaGpu({ executor: mockExecutor, timeoutMs: 1500 });

      expect(result.available).toBe(false);
      if (!result.available) {
        expect(result.error).toContain('Command timed out');
      }
    });
  });

  describe('Bounded probeNvidiaGpuSync with Injected Sync Executor', () => {
    it('resolves sync probe successfully with mock executor', () => {
      const mockExecutorSync = () => 'NVIDIA RTX 4090, 24564, 20000, 4564';
      const result = probeNvidiaGpuSync({ executorSync: mockExecutorSync });

      expect(result.available).toBe(true);
      if (result.available) {
        expect(result.vram_gb).toBe(24);
      }
    });
  });

  describe('resolveHardwareProfile 4-Tier Precedence & Provenance', () => {
    it('Tier 1: Prioritizes injectedHardware override above all', async () => {
      const injected = { gpu_count: 8, gpu_name: 'H100', vram_gb: 80, ram_gb: 512 };
      const res = await resolveHardwareProfile(undefined, injected);

      expect(res.source).toBe('injected_override');
      expect(res.provenanceFlag).toBe('injected_hardware_override');
      expect(res.hardware.gpu_name).toBe('H100');
    });

    it('Tier 2: Prioritizes config file when present', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-hw-cfg-'));
      const cfgPath = path.join(tmpDir, 'config.json');
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({ hardware: { gpu_count: 2, gpu_name: 'Configured RTX 3090', vram_gb: 24, ram_gb: 128 } }),
        'utf8',
      );

      try {
        const res = await resolveHardwareProfile(cfgPath);
        expect(res.source).toBe('configured_file');
        expect(res.provenanceFlag).toBe('configured_file_hardware_profile');
        expect(res.hardware.gpu_name).toBe('Configured RTX 3090');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('Tier 2b: Resolves hardware profile referenced via profile_path', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-hw-cfg-'));
      const subProfilePath = path.join(tmpDir, 'custom_profile.json');
      fs.writeFileSync(
        subProfilePath,
        JSON.stringify({ gpu_count: 4, gpu_name: 'Cluster A100', vram_gb: 320, ram_gb: 512 }),
        'utf8',
      );
      const cfgPath = path.join(tmpDir, 'config.json');
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({ hardware: { profile_path: './custom_profile.json' } }),
        'utf8',
      );

      try {
        const res = await resolveHardwareProfile(cfgPath);
        expect(res.source).toBe('configured_file');
        expect(res.provenanceFlag).toBe('configured_file_hardware_profile');
        expect(res.hardware.gpu_name).toBe('Cluster A100');
        expect(res.hardware.vram_gb).toBe(320);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('Tier 3: Uses live GPU probe when available', async () => {
      const mockExecutor = async () => 'NVIDIA RTX 4090, 24564, 22000, 2564';
      const res = await resolveHardwareProfile(undefined, undefined, { executor: mockExecutor });

      expect(res.source).toBe('probed_gpu_and_ram_telemetry');
      expect(res.provenanceFlag).toBe('probed_gpu_telemetry');
      expect(res.hardware.gpu_name).toBe('NVIDIA RTX 4090');
      expect(res.hardware.vram_gb).toBe(24);
      expect(res.hardware.vram_free_gb).toBe(21);
      expect(res.hardware.vram_used_gb).toBe(3);
    });

    it('Tier 4: Falls back to baseline preset without fabricating NVIDIA hardware', async () => {
      const mockExecutor = async () => {
        throw new Error('nvidia-smi not found');
      };
      const res = await resolveHardwareProfile(undefined, undefined, { executor: mockExecutor });

      expect(res.source).toBe('baseline_preset_with_host_ram_probe');
      expect(res.provenanceFlag).toBe('preset_hardware_profile');
      expect(res.hardware.gpu_name).toBe('none');
      expect(res.hardware.gpu_count).toBe(0);
      expect(res.hardware.vram_gb).toBe(0);
      expect(res.hardware.ram_gb).toBeGreaterThan(0);
    });

    it('Sync helper resolveHardwareProfileSync behaves consistently', () => {
      const mockExecutorSync = () => 'NVIDIA RTX 4090, 24564, 22000, 2564';
      const res = resolveHardwareProfileSync(undefined, undefined, { executorSync: mockExecutorSync });

      expect(res.source).toBe('probed_gpu_and_ram_telemetry');
      expect(res.provenanceFlag).toBe('probed_gpu_telemetry');
      expect(res.hardware.vram_gb).toBe(24);
    });
  });
});
