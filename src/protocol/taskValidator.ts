export interface TaskValidationResult { valid: boolean; errors: string[]; }
const KINDS = new Set(['research.compare', 'research.synthesize', 'treatment.propose']);

export function validateResearchTask(candidate: unknown): TaskValidationResult {
  const errors: string[] = [];
  if (typeof candidate !== 'object' || candidate === null) return { valid: false, errors: ['task must be an object'] };
  const task = candidate as Record<string, unknown>;
  if (task.schema !== 'research.task.v1') errors.push('unsupported task schema');
  if (typeof task.task_id !== 'string' || task.task_id.length === 0) errors.push('task_id is required');
  if (typeof task.run_id !== 'string' || task.run_id.length === 0) errors.push('run_id is required');
  if (typeof task.idempotency_key !== 'string' || task.idempotency_key.length === 0) errors.push('idempotency_key is required');
  if (typeof task.kind !== 'string' || !KINDS.has(task.kind)) errors.push('unsupported task kind');
  if (task.output_contract !== 'research.result.v1') errors.push('unsupported output contract');
  return { valid: errors.length === 0, errors };
}