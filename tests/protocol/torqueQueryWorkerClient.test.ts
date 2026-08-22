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

  it('validates canonical conformance harness result with real resolveSource', async () => {
    const crypto = await import('node:crypto');
    const sha256 = (val: string) => `sha256:${crypto.createHash('sha256').update(val, 'utf8').digest('hex')}`;

    const doc1 = 'Memory drift rate within allowable tolerance (<0.10) verified by CIC.';
    const doc2 = 'Direct verification of provider fail-closed behavior across all endpoints.';

    const sources: Record<string, { sourceId: string; revision: string; text: string }> = {
      'src-doc-001': {
        sourceId: 'src-doc-001',
        revision: sha256(doc1),
        text: doc1,
      },
      'src-doc-002': {
        sourceId: 'src-doc-002',
        revision: sha256(doc2),
        text: doc2,
      },
    };

    const canonicalResult = {
      schema: 'research.result.v1',
      task_id: 'TASK-1',
      run_id: 'RUN-1',
      attempt_id: 'att-conformance-1',
      status: 'completed',
      producer: {
        engine: 'torquequery-worker',
        provider: 'conformance-worker-ref',
        model: 'conformance-eval-v1',
        prompt_version: 'v1.0.0',
      },
      payload: {
        target_claim_ids: ['claim-drift-001', 'claim-drift-002'],
        findings: [
          {
            type: 'observation',
            source_id: 'src-doc-001',
            source_revision: sha256(doc1),
            source_span: {
              start: 0,
              end: 45,
              span_hash: sha256(doc1.slice(0, 45)),
            },
            confidence: 0.92,
            rationale: 'Memory drift rate within allowable tolerance (<0.10).',
          },
          {
            type: 'observation',
            source_id: 'src-doc-002',
            source_revision: sha256(doc2),
            source_span: {
              start: 0,
              end: 53,
              span_hash: sha256(doc2.slice(0, 53)),
            },
            confidence: 0.89,
            rationale: 'Direct verification of provider fail-closed behavior.',
          },
        ],
      },
      requires_approval: true,
    };

    const client = new TorqueQueryWorkerClient({
      baseUrl: 'http://torque.test',
      fetchImpl: async () => new Response(JSON.stringify(canonicalResult), { status: 200 }),
      resolveSource: (id: string) => sources[id] ?? null,
    });

    const validated = await client.execute(task);
    expect(validated).toEqual(canonicalResult);
  });
});