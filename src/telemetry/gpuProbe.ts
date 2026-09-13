import { execFile, execFileSync } from 'node:child_process';

export interface GpuProbeSuccess {
  available: true;
  gpu_count: number;
  gpu_name: string;
  vram_gb: number;
  vram_free_gb: number;
  vram_used_gb: number;
  individual_gpus?: Array<{
    name: string;
    vram_total_mb: number;
    vram_free_mb: number;
    vram_used_mb: number;
  }>;
}

export interface GpuProbeFailure {
  available: false;
  gpu_count: 0;
  gpu_name: string;
  vram_gb: 0;
  vram_free_gb: 0;
  vram_used_gb: 0;
  error: string;
}

export type GpuProbeResult = GpuProbeSuccess | GpuProbeFailure;

export interface GpuProbeOptions {
  timeoutMs?: number;
  executor?: (
    cmd: string,
    args: string[],
    options: { timeoutMs: number; signal?: AbortSignal },
  ) => Promise<string>;
}

export interface GpuProbeOptionsSync {
  timeoutMs?: number;
  executorSync?: (
    cmd: string,
    args: string[],
    options: { timeoutMs: number },
  ) => string;
}

/**
 * Tokenizes a single CSV line with RFC 4180 quote awareness.
 * Correctly handles commas inside quoted fields.
 */
export function tokenizeCsvLine(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++; // Skip escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      tokens.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  tokens.push(current.trim());
  return tokens.map((t) => t.replace(/^"+|"+$/g, '').trim());
}

/**
 * Parses `nvidia-smi` CSV output formatted with:
 * --query-gpu=name,memory.total,memory.free,memory.used --format=csv,noheader,nounits
 */
export function parseNvidiaSmiCsv(stdout: string): GpuProbeResult {
  if (!stdout || stdout.trim().length === 0) {
    return {
      available: false,
      gpu_count: 0,
      gpu_name: 'None',
      vram_gb: 0,
      vram_free_gb: 0,
      vram_used_gb: 0,
      error: 'Empty output received from nvidia-smi probe',
    };
  }

  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) {
    return {
      available: false,
      gpu_count: 0,
      gpu_name: 'None',
      vram_gb: 0,
      vram_free_gb: 0,
      vram_used_gb: 0,
      error: 'No valid records found in nvidia-smi output',
    };
  }

  const parsedGpus: Array<{
    name: string;
    vram_total_mb: number;
    vram_free_mb: number;
    vram_used_mb: number;
  }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const tokens = tokenizeCsvLine(line);

    if (tokens.length !== 4) {
      return {
        available: false,
        gpu_count: 0,
        gpu_name: 'None',
        vram_gb: 0,
        vram_free_gb: 0,
        vram_used_gb: 0,
        error: `Invalid CSV column count on line ${i + 1}: expected 4 columns, got ${tokens.length}`,
      };
    }

    const [name, totalStr, freeStr, usedStr] = tokens;
    if (!name) {
      return {
        available: false,
        gpu_count: 0,
        gpu_name: 'None',
        vram_gb: 0,
        vram_free_gb: 0,
        vram_used_gb: 0,
        error: `Missing GPU name on line ${i + 1}`,
      };
    }

    const totalMb = Number.parseFloat(totalStr);
    const freeMb = Number.parseFloat(freeStr);
    const usedMb = Number.parseFloat(usedStr);

    if (
      !Number.isFinite(totalMb) ||
      !Number.isFinite(freeMb) ||
      !Number.isFinite(usedMb) ||
      totalMb < 0 ||
      freeMb < 0 ||
      usedMb < 0
    ) {
      return {
        available: false,
        gpu_count: 0,
        gpu_name: 'None',
        vram_gb: 0,
        vram_free_gb: 0,
        vram_used_gb: 0,
        error: `Invalid non-finite or negative VRAM value on line ${i + 1}: [total=${totalStr}, free=${freeStr}, used=${usedStr}]`,
      };
    }

    parsedGpus.push({
      name,
      vram_total_mb: totalMb,
      vram_free_mb: freeMb,
      vram_used_mb: usedMb,
    });
  }

  const gpu_count = parsedGpus.length;
  const uniqueNames = Array.from(new Set(parsedGpus.map((g) => g.name))).sort();
  const gpu_name =
    uniqueNames.length === 1
      ? uniqueNames[0]
      : `mixed (${uniqueNames.join(', ')})`;

  const totalMbSum = parsedGpus.reduce((acc, g) => acc + g.vram_total_mb, 0);
  const freeMbSum = parsedGpus.reduce((acc, g) => acc + g.vram_free_mb, 0);
  const usedMbSum = parsedGpus.reduce((acc, g) => acc + g.vram_used_mb, 0);

  const vram_gb = Math.round(totalMbSum / 1024);
  const vram_free_gb = Math.round(freeMbSum / 1024);
  const vram_used_gb = Math.round(usedMbSum / 1024);

  return {
    available: true,
    gpu_count,
    gpu_name,
    vram_gb,
    vram_free_gb,
    vram_used_gb,
    individual_gpus: parsedGpus,
  };
}

const DEFAULT_QUERY_ARGS = [
  '--query-gpu=name,memory.total,memory.free,memory.used',
  '--format=csv,noheader,nounits',
];

/**
 * Executes an asynchronous, non-blocking probe against nvidia-smi with a strict timeout.
 */
export async function probeNvidiaGpu(
  options: GpuProbeOptions = {},
): Promise<GpuProbeResult> {
  const timeoutMs = options.timeoutMs ?? 1500;

  if (options.executor) {
    try {
      const stdout = await options.executor('nvidia-smi', DEFAULT_QUERY_ARGS, {
        timeoutMs,
      });
      return parseNvidiaSmiCsv(stdout);
    } catch (err) {
      return {
        available: false,
        gpu_count: 0,
        gpu_name: 'None',
        vram_gb: 0,
        vram_free_gb: 0,
        vram_used_gb: 0,
        error: (err as Error).message,
      };
    }
  }

  return new Promise<GpuProbeResult>((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    execFile(
      'nvidia-smi',
      DEFAULT_QUERY_ARGS,
      {
        signal: controller.signal,
        timeout: timeoutMs,
        encoding: 'utf8',
      },
      (error: Error | null, stdout: string) => {
        clearTimeout(timer);
        if (error) {
          resolve({
            available: false,
            gpu_count: 0,
            gpu_name: 'None',
            vram_gb: 0,
            vram_free_gb: 0,
            vram_used_gb: 0,
            error: error.message,
          });
          return;
        }
        resolve(parseNvidiaSmiCsv(stdout));
      },
    );
  });
}

/**
 * Bounded synchronous execution probe against nvidia-smi with strict timeout.
 */
export function probeNvidiaGpuSync(
  options: GpuProbeOptionsSync = {},
): GpuProbeResult {
  const timeoutMs = options.timeoutMs ?? 1500;

  if (options.executorSync) {
    try {
      const stdout = options.executorSync('nvidia-smi', DEFAULT_QUERY_ARGS, {
        timeoutMs,
      });
      return parseNvidiaSmiCsv(stdout);
    } catch (err) {
      return {
        available: false,
        gpu_count: 0,
        gpu_name: 'None',
        vram_gb: 0,
        vram_free_gb: 0,
        vram_used_gb: 0,
        error: (err as Error).message,
      };
    }
  }

  try {
    const stdout = execFileSync('nvidia-smi', DEFAULT_QUERY_ARGS, {
      timeout: timeoutMs,
      encoding: 'utf8',
    });
    return parseNvidiaSmiCsv(stdout);
  } catch (error) {
    return {
      available: false,
      gpu_count: 0,
      gpu_name: 'None',
      vram_gb: 0,
      vram_free_gb: 0,
      vram_used_gb: 0,
      error: (error as Error).message,
    };
  }
}
