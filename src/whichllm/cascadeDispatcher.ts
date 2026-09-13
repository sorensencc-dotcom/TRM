import { reportIcfEvent } from '../telemetry/icfReporter';

export type ProviderType = 'local' | 'claude' | 'antigravity' | 'codex' | 'grok';

export interface ProviderDefinition {
  type: ProviderType;
  defaultModel: string;
  displayName: string;
}

export const PROVIDER_CASCADE: ProviderDefinition[] = [
  { type: 'local', defaultModel: 'llama3:8b-instruct-fp16', displayName: 'Local (Ollama)' },
  { type: 'claude', defaultModel: 'claude-3-5-sonnet-20241022', displayName: 'Claude (Anthropic)' },
  { type: 'antigravity', defaultModel: 'gemini-2.0-flash', displayName: 'Antigravity (Gemini)' },
  { type: 'codex', defaultModel: 'gpt-4o', displayName: 'Codex (OpenAI)' },
  { type: 'grok', defaultModel: 'grok-2', displayName: 'Grok (xAI)' },
];

export interface DispatchExecutionOptions<TRequest, TResponse> {
  prompt: string;
  localModelAnchor?: string | null;
  executor: (provider: ProviderType, model: string, prompt: string) => Promise<TResponse>;
  isRateLimitError?: (err: unknown) => boolean;
}

export interface DispatchExecutionResult<TResponse> {
  response: TResponse;
  executingProvider: ProviderType;
  executingModel: string;
  fallbackCount: number;
  attemptedProviders: ProviderType[];
}

/**
 * Executes a research inference task with automatic multi-tier cloud fallback progression.
 * Progression: Local -> Claude -> Antigravity -> Codex -> Grok.
 */
export async function dispatchWithCascade<TRequest, TResponse>(
  options: DispatchExecutionOptions<TRequest, TResponse>,
): Promise<DispatchExecutionResult<TResponse>> {
  const attemptedProviders: ProviderType[] = [];
  const errors: Array<{ provider: ProviderType; error: string }> = [];

  for (let i = 0; i < PROVIDER_CASCADE.length; i++) {
    const providerDef = PROVIDER_CASCADE[i];
    const model =
      providerDef.type === 'local' && options.localModelAnchor
        ? options.localModelAnchor
        : providerDef.defaultModel;

    attemptedProviders.push(providerDef.type);

    try {
      const response = await options.executor(providerDef.type, model, options.prompt);
      return {
        response,
        executingProvider: providerDef.type,
        executingModel: model,
        fallbackCount: i,
        attemptedProviders,
      };
    } catch (err) {
      const isRateLimit = options.isRateLimitError
        ? options.isRateLimitError(err)
        : /429|rate[- ]limit|too many requests|overloaded/i.test((err as Error).message);

      const errorMessage = (err as Error).message;
      errors.push({ provider: providerDef.type, error: errorMessage });

      // Log failure event
      if (providerDef.type === 'local') {
        reportIcfEvent({
          severity: 'WARN',
          eventType: 'LOCAL_MODEL_FAILURE',
          subsystem: 'TRM',
          modelName: model,
          failureStage: 'INFERENCE_DISPATCH',
          errorReason: errorMessage,
          fallbackTarget: PROVIDER_CASCADE[i + 1]?.displayName,
          timestamp: new Date().toISOString(),
        });
      } else {
        reportIcfEvent({
          severity: isRateLimit ? 'WARN' : 'WARN',
          eventType: 'RATE_LIMIT_ADVANCEMENT',
          subsystem: 'TRM',
          modelName: model,
          errorReason: errorMessage,
          fallbackTarget: PROVIDER_CASCADE[i + 1]?.displayName,
          timestamp: new Date().toISOString(),
        });
      }

      // If this was the last provider in the cascade, emit CRITICAL event
      if (i === PROVIDER_CASCADE.length - 1) {
        reportIcfEvent({
          severity: 'CRITICAL',
          eventType: 'WHICHLLM_DEGRADED_CASCADE',
          subsystem: 'TRM',
          modelName: model,
          errorReason: `All providers in research cascade failed: ${errors.map((e) => `${e.provider}: ${e.error}`).join('; ')}`,
          timestamp: new Date().toISOString(),
        });
        throw new Error(
          `All cascade providers exhausted. Failures: ${errors.map((e) => `[${e.provider}] ${e.error}`).join('; ')}`,
        );
      }
    }
  }

  throw new Error('Cascade execution reached unreachable state.');
}
