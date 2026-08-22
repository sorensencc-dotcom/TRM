import { validateResearchTask } from './taskValidator';

export interface SigilTaskEnvelope { message_type: 'task.request'; idempotency_key: string; body: { task_id: string; instruction: string; success_criteria: string[] }; }
export interface SigilTaskTransport { sendTask: (envelope: SigilTaskEnvelope) => Promise<unknown>; }

export async function dispatchResearchTask(task: unknown, transport: SigilTaskTransport): Promise<unknown> {
  const checked = validateResearchTask(task);
  if (!checked.valid) throw new Error(checked.errors.join('; '));
  const value = task as Record<string, any>;
  const envelope: SigilTaskEnvelope = {
    message_type: 'task.request',
    idempotency_key: value.idempotency_key,
    body: {
      task_id: value.task_id,
      instruction: JSON.stringify(value),
      success_criteria: ['Return a research.result.v1 payload with verifiable source citations.'],
    },
  };
  return transport.sendTask(envelope);
}