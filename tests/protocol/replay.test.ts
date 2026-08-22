import { validateTaskReplay, TaskExecution } from '../../src/protocol/replay';

const base: TaskExecution = {
  task_id: 'TASK-1', run_id: 'RUN-1', idempotency_key: 'idem-1', execution_fingerprint: 'sha256:a'
};

describe('validateTaskReplay', () => {
  it('accepts an identical replay without re-execution', () => {
    expect(validateTaskReplay(base, { ...base })).toEqual({ valid: true, replay: true, errors: [] });
  });
  it('rejects parameter drift under the same run and idempotency key', () => {
    const result = validateTaskReplay(base, { ...base, execution_fingerprint: 'sha256:b' });
    expect(result.valid).toBe(false);
    expect(result.replay).toBe(false);
    expect(result.errors).toContain('execution inputs changed without a new run_id');
  });
  it('accepts changed execution inputs when Sigil creates a new run', () => {
    expect(validateTaskReplay(base, { ...base, run_id: 'RUN-2', execution_fingerprint: 'sha256:b' })).toEqual({ valid: true, replay: false, errors: [] });
  });
  it('rejects a task or idempotency-key mismatch as a different logical task', () => {
    const result = validateTaskReplay(base, { ...base, task_id: 'TASK-2' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('task identity does not match existing execution');
  });
});