import { validateResearchResult, SourceRevision } from './researchResultValidator';
import { validateResearchTask } from './taskValidator';

export interface TorqueQueryWorkerClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  resolveSource: (sourceId: string) => SourceRevision | null;
}

export class TorqueQueryWorkerClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly resolveSource: TorqueQueryWorkerClientOptions['resolveSource'];

  constructor(options: TorqueQueryWorkerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.resolveSource = options.resolveSource;
  }

  async execute(task: unknown): Promise<unknown> {
    const checkedTask = validateResearchTask(task);
    if (!checkedTask.valid) throw new Error(checkedTask.errors.join('; '));
    const response = await this.fetchImpl(`${this.baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(task),
    });
    const text = await response.text();
    let body: any = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = { message: text }; }
    }
    if (!response.ok) throw new Error(body?.detail?.message ?? body?.message ?? `TorqueQuery request failed: ${response.status}`);
    const result = validateResearchResult(body, this.resolveSource);
    const expected = task as Record<string, unknown>;
    if (body?.task_id !== expected.task_id || body?.run_id !== expected.run_id) throw new Error('invalid research result: result task/run linkage does not match request');
    if (!result.valid) throw new Error(`invalid research result: ${result.errors.join('; ')}`);
    return body;
  }
}