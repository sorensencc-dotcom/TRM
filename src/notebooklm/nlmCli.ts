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

export type NlmResult<T> = { ok: true; data: T } | { ok: false; error: string };

interface RawSpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

function runNlm(args: string[]): NlmResult<unknown> {
  const result = spawnSync('nlm', args, { encoding: 'utf-8' }) as unknown as RawSpawnResult;

  if (result.error) {
    return { ok: false, error: result.error.message };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    return { ok: false, error: `nlm produced non-JSON output: ${(err as Error).message}` };
  }

  if (result.status !== 0) {
    const errMessage =
      typeof parsed === 'object' && parsed !== null && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `nlm exited with status ${result.status}`;
    return { ok: false, error: errMessage };
  }

  return { ok: true, data: parsed };
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

export function queryNotebook(notebookId: string, question: string, timeoutSeconds?: number): NlmResult<string> {
  const args = ['query', 'notebook', notebookId, question, '--json'];
  if (timeoutSeconds !== undefined) args.push('--timeout', String(timeoutSeconds));
  const result = runNlm(args);
  if (!result.ok) return result;
  return { ok: true, data: (result.data as { answer: string }).answer };
}
