import { execSync } from 'node:child_process';
import type { OllamaModelTag, OllamaTagsResponse } from './types';

export interface OllamaDiscoveryOptions {
  host?: string;
  timeoutMs?: number;
  allowCliFallback?: boolean;
  execFn?: (command: string, options: any) => string;
}

export interface OllamaDiscoveryResult {
  models: OllamaModelTag[];
  source: 'http_api' | 'cli_degraded';
}

/**
 * Discovers locally installed models by querying the Ollama HTTP API endpoint (/api/tags).
 * Falls back to parsing `ollama list` CLI output only when explicitly enabled.
 */
export async function discoverOllamaModels(
  options: OllamaDiscoveryOptions = {},
): Promise<OllamaDiscoveryResult> {
  const host = options.host ?? process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
  const timeoutMs = options.timeoutMs ?? 3_000;
  const url = `${host.replace(/\/+$/, '')}/api/tags`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Ollama HTTP API returned status ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as OllamaTagsResponse;
    const models = Array.isArray(data.models) ? data.models : [];
    return { models, source: 'http_api' };
  } catch (httpError) {
    if (!options.allowCliFallback) {
      throw new Error(
        `Failed to discover models via Ollama HTTP endpoint (${url}): ${(httpError as Error).message}`,
      );
    }

    // Degraded CLI fallback mode
    try {
      const exec = options.execFn ?? execSync;
      const stdout = String(
        exec('ollama list', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: timeoutMs,
        }),
      );

      const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
      // Skip header line (NAME ID SIZE MODIFIED)
      const models: OllamaModelTag[] = [];
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].trim().split(/\s+/);
        if (parts.length > 0 && parts[0]) {
          models.push({ name: parts[0] });
        }
      }

      return { models, source: 'cli_degraded' };
    } catch (cliError) {
      throw new Error(
        `Failed to discover models via both HTTP endpoint and CLI fallback. HTTP error: ${(httpError as Error).message}. CLI error: ${(cliError as Error).message}`,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}
