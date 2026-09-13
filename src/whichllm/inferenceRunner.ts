import type {
  OllamaChatMessage,
  OllamaChatResponse,
  OllamaToolCall,
  OllamaToolDefinition,
} from './types';

export const MAX_CONTENT_LENGTH_BYTES = 16_384; // 16 KB strict limit

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ParsedToolInference {
  source: 'native_tool_calls' | 'fenced_json' | 'none';
  tools: ParsedToolCall[];
  rawContent: string;
  isMalformed: boolean;
  malformedReason?: string;
}

export interface OllamaChatRequestOptions {
  host?: string;
  timeoutMs?: number;
}

/**
 * Sends a chat completion request to the Ollama HTTP API endpoint (/api/chat).
 */
export async function executeOllamaChat(
  model: string,
  messages: OllamaChatMessage[],
  tools: OllamaToolDefinition[] = [],
  options: OllamaChatRequestOptions = {},
): Promise<OllamaChatResponse> {
  const host = options.host ?? process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
  const timeoutMs = options.timeoutMs ?? 15_000;
  const url = `${host.replace(/\/+$/, '')}/api/chat`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const payload: Record<string, unknown> = {
      model,
      messages,
      stream: false,
    };
    if (tools.length > 0) {
      payload.tools = tools;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Ollama chat request failed with status ${response.status} (${response.statusText})`,
      );
    }

    const data = (await response.json()) as OllamaChatResponse;
    return data;
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`Ollama chat request timed out after ${timeoutMs}ms for model ${model}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validates tool arguments against the expected parameter schema.
 */
function validateToolArguments(
  toolDef: OllamaToolDefinition,
  args: Record<string, unknown>,
): boolean {
  if (typeof args !== 'object' || args === null) {
    return false;
  }
  const required = toolDef.function.parameters.required ?? [];
  for (const reqKey of required) {
    if (!(reqKey in args) || args[reqKey] === undefined || args[reqKey] === null) {
      return false;
    }
    const propDef = toolDef.function.parameters.properties[reqKey];
    if (propDef && propDef.type) {
      if (propDef.type === 'string' && typeof args[reqKey] !== 'string') {
        return false;
      }
      if (propDef.type === 'number' && typeof args[reqKey] !== 'number') {
        return false;
      }
      if (propDef.type === 'boolean' && typeof args[reqKey] !== 'boolean') {
        return false;
      }
      if (propDef.type === 'object' && typeof args[reqKey] !== 'object') {
        return false;
      }
    }
  }
  return true;
}

/**
 * Strict parser for Ollama model tool-call responses.
 * Enforces bounded content lengths, single parseable candidate block restrictions,
 * approved tool name whitelisting, and strict schema validation.
 */
export function parseToolInference(
  response: OllamaChatResponse,
  availableTools: OllamaToolDefinition[],
): ParsedToolInference {
  const message = response.message;
  const rawContent = message?.content ?? '';
  const approvedToolNames = new Set(availableTools.map((t) => t.function.name));
  const toolDefMap = new Map(availableTools.map((t) => [t.function.name, t]));

  // 1. Check native tool_calls first
  if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
    const parsedTools: ParsedToolCall[] = [];
    for (const call of message.tool_calls) {
      const fnName = call.function?.name;
      if (!fnName || !approvedToolNames.has(fnName)) {
        return {
          source: 'native_tool_calls',
          tools: [],
          rawContent,
          isMalformed: true,
          malformedReason: `Native tool call specified unapproved tool name: ${fnName}`,
        };
      }

      let parsedArgs: Record<string, unknown> = {};
      if (typeof call.function.arguments === 'string') {
        try {
          parsedArgs = JSON.parse(call.function.arguments);
        } catch {
          return {
            source: 'native_tool_calls',
            tools: [],
            rawContent,
            isMalformed: true,
            malformedReason: `Failed to parse JSON string in native tool_calls arguments`,
          };
        }
      } else if (typeof call.function.arguments === 'object' && call.function.arguments !== null) {
        parsedArgs = call.function.arguments;
      } else {
        return {
          source: 'native_tool_calls',
          tools: [],
          rawContent,
          isMalformed: true,
          malformedReason: `Native tool call arguments are not a valid object`,
        };
      }

      const toolDef = toolDefMap.get(fnName)!;
      if (!validateToolArguments(toolDef, parsedArgs)) {
        return {
          source: 'native_tool_calls',
          tools: [],
          rawContent,
          isMalformed: true,
          malformedReason: `Native tool call arguments failed schema validation for ${fnName}`,
        };
      }

      parsedTools.push({ name: fnName, arguments: parsedArgs });
    }

    return {
      source: 'native_tool_calls',
      tools: parsedTools,
      rawContent,
      isMalformed: false,
    };
  }

  // 2. Fenced JSON fallback with strict limits
  if (rawContent.length > MAX_CONTENT_LENGTH_BYTES) {
    return {
      source: 'none',
      tools: [],
      rawContent,
      isMalformed: true,
      malformedReason: `Response content exceeded maximum limit of ${MAX_CONTENT_LENGTH_BYTES} bytes`,
    };
  }

  const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
  const matches: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = codeBlockRegex.exec(rawContent)) !== null) {
    if (match[1] && match[1].trim().length > 0) {
      matches.push(match[1].trim());
    }
  }

  // Exactly one candidate code block required if code blocks are present
  if (matches.length > 1) {
    return {
      source: 'none',
      tools: [],
      rawContent,
      isMalformed: true,
      malformedReason: `Ambiguous response: contained ${matches.length} distinct code blocks`,
    };
  }

  if (matches.length === 1) {
    const candidateBlock = matches[0];
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidateBlock);
    } catch {
      return {
        source: 'none',
        tools: [],
        rawContent,
        isMalformed: true,
        malformedReason: 'Failed to parse JSON in fenced code block',
      };
    }

    const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    const parsedTools: ParsedToolCall[] = [];

    for (const item of items) {
      if (typeof item !== 'object' || item === null) {
        return {
          source: 'none',
          tools: [],
          rawContent,
          isMalformed: true,
          malformedReason: 'Candidate JSON element is not an object',
        };
      }

      const rec = item as Record<string, unknown>;
      const toolName = (rec.name ?? rec.tool ?? rec.function) as string | undefined;
      const toolArgs = (rec.arguments ?? rec.parameters ?? rec.args ?? {}) as unknown;

      if (!toolName || typeof toolName !== 'string') {
        return {
          source: 'none',
          tools: [],
          rawContent,
          isMalformed: true,
          malformedReason: 'Candidate JSON block does not contain a tool name property',
        };
      }

      if (!approvedToolNames.has(toolName)) {
        return {
          source: 'none',
          tools: [],
          rawContent,
          isMalformed: true,
          malformedReason: `Fenced JSON specified unapproved tool name: ${toolName}`,
        };
      }

      if (typeof toolArgs !== 'object' || toolArgs === null) {
        return {
          source: 'none',
          tools: [],
          rawContent,
          isMalformed: true,
          malformedReason: `Fenced JSON tool arguments are not an object for ${toolName}`,
        };
      }

      const toolDef = toolDefMap.get(toolName)!;
      if (!validateToolArguments(toolDef, toolArgs as Record<string, unknown>)) {
        return {
          source: 'none',
          tools: [],
          rawContent,
          isMalformed: true,
          malformedReason: `Fenced JSON tool arguments failed schema validation for ${toolName}`,
        };
      }

      parsedTools.push({
        name: toolName,
        arguments: toolArgs as Record<string, unknown>,
      });
    }

    return {
      source: 'fenced_json',
      tools: parsedTools,
      rawContent,
      isMalformed: false,
    };
  }

  // 3. No tool calls emitted (pure text prose)
  return {
    source: 'none',
    tools: [],
    rawContent,
    isMalformed: false,
  };
}
