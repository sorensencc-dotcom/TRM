import { dispatchResearchTask } from '../../src/protocol/sigilTaskAdapter';

describe('dispatchResearchTask', () => {
  const task = { schema: 'research.task.v1', task_id: 'TASK-1', run_id: 'RUN-1', kind: 'research.compare', inputs: { source_ids: ['SRC-1'] }, output_contract: 'research.result.v1', approval_required: true, idempotency_key: 'idem-1' };
  it('maps a validated research task to Sigil task.request and preserves idempotency', async () => {
    let sent: any;
    const result = await dispatchResearchTask(task, { sendTask: async (envelope: any) => { sent = envelope; return { accepted: true }; } });
    expect(result).toEqual({ accepted: true });
    expect(sent.message_type).toBe('task.request');
    expect(sent.idempotency_key).toBe('idem-1');
    expect(JSON.parse(sent.body.instruction)).toEqual(task);
  });
  it('does not call transport for invalid research tasks', async () => {
    let calls = 0;
    await expect(dispatchResearchTask({ ...task, kind: 'bad' }, { sendTask: async () => { calls++; } })).rejects.toThrow('unsupported task kind');
    expect(calls).toBe(0);
  });
});