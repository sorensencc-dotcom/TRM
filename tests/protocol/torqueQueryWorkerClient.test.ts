import { TorqueQueryWorkerClient } from '../../src/protocol/torqueQueryWorkerClient';

const task = {
  schema: 'research.task.v1', task_id: 'TASK-1', run_id: 'RUN-1', kind: 'research.compare',
  inputs: { source_ids: ['SRC-1'] }, output_contract: 'research.result.v1', approval_required: true,
  idempotency_key: 'idem-1',
};
const result = {
  schema: 'research.result.v1', task_id: 'TASK-1', run_id: 'RUN-1', status: 'completed',
  producer: { engine: 'torquequery', provider: 'fixture', model: 'fixture', prompt_version: 'v1' },
  payload: { target_claim_ids: [], findings: [] }, requires_approval: true,
};

describe('TorqueQueryWorkerClient', () => {
  it('posts a validated task and validates the result', async () => {
    let request: RequestInit | undefined;
    const client = new TorqueQueryWorkerClient({
      baseUrl: 'http://torque.test/',
      fetchImpl: async (_url: RequestInfo | URL, init: RequestInit | undefined) => { request = init; return new Response(JSON.stringify(result), { status: 200 }); },
      resolveSource: () => null,
    });
    await expect(client.execute(task)).resolves.toEqual(result);
    expect(request?.method).toBe('POST');
    expect(JSON.parse(String(request?.body))).toEqual(task);
  });

  it('rejects an invalid provider result', async () => {
    const client = new TorqueQueryWorkerClient({
      baseUrl: 'http://torque.test',
      fetchImpl: async () => new Response(JSON.stringify({ ...result, task_id: 'OTHER' }), { status: 200 }),
      resolveSource: () => null,
    });
    await expect(client.execute(task)).rejects.toThrow('invalid research result');
  });
});