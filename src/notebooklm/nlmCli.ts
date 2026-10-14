import { spawnSync } from 'node:child_process';

export interface NlmSource {
  id: string;
  title: string;
  type: string;
  url: string | null;
}

export interface NlmNote {
  id: string;
  title: string;
  content: string;
}

export interface NlmNotebook {
  id: string;
  title: string;
  source_count?: number;
  updated_at?: string;
}

export interface ChatTurn {
  turn: number;
  query: string;
  answer: string;
}

export interface ChatSession {
  conversation_id: string;
  turn_count: number;
  preview?: string;
  is_active?: boolean;
  transcript?: ChatTurn[];
}

export interface ListChatsResponse {
  notebook_id: string;
  notebook_title?: string;
  sessions: ChatSession[];
}

export type NlmResult<T> = { ok: true; data: T } | { ok: false; error: string };

interface RawSpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

// Bounds every nlm invocation in this file so a wedged `nlm` process
// cannot hang dispatch indefinitely.
const DEFAULT_CALL_TIMEOUT_MS = 180_000;

function runNlm(args: string[], rawText = false, timeoutMs?: number): NlmResult<unknown> {
  const result = spawnSync('nlm', args, {
    encoding: 'utf-8',
    timeout: timeoutMs || DEFAULT_CALL_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as unknown as RawSpawnResult;

  if (result.error) {
    return { ok: false, error: result.error.message };
  }

  if (result.status !== 0) {
    let errMessage = `nlm exited with status ${result.status}`;
    try {
      const parsed = JSON.parse(result.stdout);
      if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
        errMessage = String((parsed as { error: unknown }).error);
      }
    } catch (_) {
      if (result.stderr && result.stderr.trim()) errMessage = result.stderr.trim();
      else if (result.stdout && result.stdout.trim()) errMessage = result.stdout.trim();
    }
    return { ok: false, error: errMessage };
  }

  if (rawText) {
    return { ok: true, data: result.stdout };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    return { ok: false, error: `nlm produced non-JSON output: ${(err as Error).message}` };
  }

  return { ok: true, data: parsed };
}

export function listNotebooks(): NlmResult<NlmNotebook[]> {
  const result = runNlm(['notebook', 'list', '--json']);
  if (!result.ok) return result;
  return { ok: true, data: result.data as NlmNotebook[] };
}

export function listSources(notebookId: string): NlmResult<NlmSource[]> {
  const result = runNlm(['source', 'list', notebookId, '--json', '--skip-freshness']);
  if (!result.ok) return result;
  return { ok: true, data: result.data as NlmSource[] };
}

export function getSourceContent(sourceId: string): NlmResult<string> {
  const result = runNlm(['source', 'content', sourceId, '--json']);
  if (!result.ok) return result;
  return { ok: true, data: (result.data as { content: string }).content };
}

export function listNotes(notebookId: string): NlmResult<NlmNote[]> {
  const result = runNlm(['note', 'list', notebookId, '--json']);
  if (!result.ok) return result;
  return { ok: true, data: (result.data as { notes: NlmNote[] }).notes };
}

export interface QueryNotebookOptions {
  timeoutSeconds?: number;
  sourceIds?: string[];
  newConversation?: boolean;
}

export function queryNotebook(
  notebookId: string,
  question: string,
  options?: QueryNotebookOptions | number
): NlmResult<string> {
  const result = queryNotebookDetailed(notebookId, question, options);
  if (!result.ok) return result;
  return { ok: true, data: result.data.answer };
}

export function queryNotebookDetailed(
  notebookId: string,
  question: string,
  options?: QueryNotebookOptions | number
): NlmResult<{ answer: string; [key: string]: unknown }> {
  const opts: QueryNotebookOptions = typeof options === 'number' ? { timeoutSeconds: options } : (options || {});
  const args = ['query', 'notebook', notebookId, question, '--json'];
  if (opts.sourceIds && opts.sourceIds.length > 0) {
    args.push('--source-ids', opts.sourceIds.join(','));
  }
  const timeoutSec = opts.timeoutSeconds !== undefined ? opts.timeoutSeconds : 120;
  args.push('--timeout', String(timeoutSec));
  if (opts.newConversation) {
    args.push('--new-conversation');
  }
  const callTimeoutMs = (timeoutSec + 30) * 1000;
  const result = runNlm(args, false, callTimeoutMs);
  if (!result.ok) return result;
  if (!result.data || typeof result.data !== 'object' ||
      typeof (result.data as { answer?: unknown }).answer !== 'string' ||
      !(result.data as { answer: string }).answer.trim()) {
    return { ok: false, error: 'nlm query produced an empty or invalid answer' };
  }
  return { ok: true, data: result.data as { answer: string; [key: string]: unknown } };
}

export function addSource(notebookId: string, filePath: string, title: string): NlmResult<undefined> {
  const result = runNlm(['source', 'add', notebookId, '--file', filePath, '--title', title, '--wait', '--json']);
  if (!result.ok) return result;
  return { ok: true, data: undefined };
}

export function listChats(notebookId: string): NlmResult<ListChatsResponse> {
  const result = runNlm(['chats', 'list', notebookId, '--json']);
  if (!result.ok) return result;
  return { ok: true, data: result.data as ListChatsResponse };
}

export function getChatTranscript(notebookId: string, conversationId: string): NlmResult<ChatSession> {
  const result = runNlm(['chats', 'get', notebookId, conversationId, '--json']);
  if (!result.ok) return result;
  return { ok: true, data: result.data as ChatSession };
}

export function createNote(notebookId: string, title: string, content: string): NlmResult<{ noteId?: string }> {
  const result = runNlm(['note', 'create', notebookId, '--title', title, '--content', content], true);
  if (!result.ok) return result;
  const stdout = String(result.data);
  const match = stdout.match(/Note created:\s*([a-f0-9-]+)/i);
  return { ok: true, data: { noteId: match ? match[1] : undefined } };
}

export function deleteNote(notebookId: string, noteId: string): NlmResult<undefined> {
  const result = runNlm(['note', 'delete', notebookId, noteId, '--confirm'], true);
  if (!result.ok) return result;
  return { ok: true, data: undefined };
}
