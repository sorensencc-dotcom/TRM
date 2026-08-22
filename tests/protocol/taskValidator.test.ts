import { validateResearchTask } from '../../src/protocol/taskValidator';

describe('validateResearchTask', () => {
  const task = { schema: 'research.task.v1', task_id: 'TASK-1', run_id: 'RUN-1', kind: 'research.compare', inputs: { source_ids: ['SRC-1'] }, output_contract: 'research.result.v1', approval_required: true, idempotency_key: 'idem-1' };
  it('accepts a complete supported task envelope', () => {
    expect(validateResearchTask(task)).toEqual({ valid: true, errors: [] });
  });
  it('rejects missing identity and idempotency fields', () => {
    const result = validateResearchTask({ ...task, task_id: '', idempotency_key: undefined });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining(['task_id is required', 'idempotency_key is required']));
  });
  it('rejects unsupported kinds and output contracts', () => {
    const result = validateResearchTask({ ...task, kind: 'unknown', output_contract: 'wrong' });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining(['unsupported task kind', 'unsupported output contract']));
  });
});