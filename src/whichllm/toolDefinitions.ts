import type { OllamaToolDefinition } from './types';

export const TOOL_READ_SHARED_CONTEXT: OllamaToolDefinition = {
  type: 'function',
  function: {
    name: 'sigil.core/read_shared_context',
    description: 'Read the shared context from a markdown documentation or research path.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative or absolute file path to the shared context file.',
        },
      },
      required: ['path'],
    },
  },
};

export const TOOL_SIGIL_SEND_TASK: OllamaToolDefinition = {
  type: 'function',
  function: {
    name: 'sigil_send_task',
    description: 'Dispatch an operational task to a target conversation context.',
    parameters: {
      type: 'object',
      properties: {
        conversation_id: {
          type: 'string',
          description: 'Target conversation identifier.',
        },
        task: {
          type: 'string',
          description: 'Task instructions or message to execute.',
        },
      },
      required: ['conversation_id'],
    },
  },
};

export const TOOL_FETCH_FINDINGS: OllamaToolDefinition = {
  type: 'function',
  function: {
    name: 'trm_fetch_findings',
    description: 'Fetch extracted findings and statements for a topic.',
    parameters: {
      type: 'object',
      properties: {
        topic_id: {
          type: 'string',
          description: 'Unique topic slug or identifier.',
        },
      },
      required: ['topic_id'],
    },
  },
};

export const TOOL_SOURCE_RESOLVER: OllamaToolDefinition = {
  type: 'function',
  function: {
    name: 'trm_source_resolver',
    description: 'Resolve upstream source details for a given finding source ID.',
    parameters: {
      type: 'object',
      properties: {
        source_id: {
          type: 'string',
          description: 'Unique source ID to resolve.',
        },
      },
      required: ['source_id'],
    },
  },
};

export const CANONICAL_BFCL_TOOLS: OllamaToolDefinition[] = [
  TOOL_READ_SHARED_CONTEXT,
  TOOL_SIGIL_SEND_TASK,
  TOOL_FETCH_FINDINGS,
  TOOL_SOURCE_RESOLVER,
];
