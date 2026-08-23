import { TorqueQueryWorkerClient } from '../../src/protocol/torqueQueryWorkerClient';
import { startLocalReferenceWorker, LocalReferenceWorkerInstance } from '../../src/protocol/localReferenceWorker';

const task = {
  schema: 'research.task.v1',
  task_id: 'TASK-1',
  run_id: 'RUN-1',
  kind: 'research.compare',
  inputs: { source_ids: ['src-doc-001'] },
  output_contract: 'research.result.v1',
  approval_required: true,
  idempotency_key: 'idem-1',
};

const result = {
  schema: 'research.result.v1',
  task_id: 'TASK-1',
  run_id: 'RUN-1',
  status: 'completed',
  producer: { engine: 'torquequery', provider: 'fixture', model: 'fixture', prompt_version: 'v1' },
  payload: { target_claim_ids: [], findings: [] },
  requires_approval: true,
};

describe('TorqueQueryWorkerClient', () => {
  it('posts a validated task and validates the result', async () => {
    let request: RequestInit | undefined;
    const client = new TorqueQueryWorkerClient({
      baseUrl: 'http://torque.test/',
      fetchImpl: async (_url: RequestInfo | URL, init: RequestInit | undefined) => {
        request = init;
        return new Response(JSON.stringify(result), { status: 200 });
      },
      resolveSource: () => null,
    });
    await expect(client.execute(task)).resolves.toEqual(result);
    expect(request?.method).toBe('POST');
    expect(JSON.parse(String(request?.body))).toEqual(task);
  });

  it('rejects an invalid task at the client boundary before sending', async () => {
    const client = new TorqueQueryWorkerClient({
      baseUrl: 'http://torque.test',
      fetchImpl: async () => new Response(JSON.stringify(result), { status: 200 }),
      resolveSource: () => null,
    });
    await expect(client.execute({ ...task, schema: 'invalid.schema' })).rejects.toThrow('unsupported task schema');
    await expect(client.execute({ ...task, task_id: '' })).rejects.toThrow('task_id is required');
  });

  it('rejects an invalid provider result with mismatched task_id or run_id', async () => {
    const client = new TorqueQueryWorkerClient({
      baseUrl: 'http://torque.test',
      fetchImpl: async () => new Response(JSON.stringify({ ...result, task_id: 'OTHER-TASK' }), { status: 200 }),
      resolveSource: () => null,
    });
    await expect(client.execute(task)).rejects.toThrow('result task/run linkage does not match request');
  });

  it('handles HTTP non-2xx errors (400, 422, 500, 502) with structured detail', async () => {
    const client400 = new TorqueQueryWorkerClient({
      baseUrl: 'http://torque.test',
      fetchImpl: async () =>
        new Response(JSON.stringify({ detail: { message: 'Invalid task input parameter' } }), { status: 400 }),
      resolveSource: () => null,
    });
    await expect(client400.execute(task)).rejects.toThrow('Invalid task input parameter');

    const client502 = new TorqueQueryWorkerClient({
      baseUrl: 'http://torque.test',
      fetchImpl: async () =>
        new Response(JSON.stringify({ detail: { message: 'PROVIDER_UNAVAILABLE: upstream worker down' } }), { status: 502 }),
      resolveSource: () => null,
    });
    await expect(client502.execute(task)).rejects.toThrow('PROVIDER_UNAVAILABLE');
  });

  it('handles malformed non-JSON responses gracefully', async () => {
    const client502 = new TorqueQueryWorkerClient({
      baseUrl: 'http://torque.test',
      fetchImpl: async () =>
        new Response('<html><body>502 Bad Gateway</body></html>', { status: 502 }),
      resolveSource: () => null,
    });
    await expect(client502.execute(task)).rejects.toThrow('502 Bad Gateway');

    const client200 = new TorqueQueryWorkerClient({
      baseUrl: 'http://torque.test',
      fetchImpl: async () =>
        new Response('not a json object', { status: 200 }),
      resolveSource: () => null,
    });
    await expect(client200.execute(task)).rejects.toThrow('invalid research result');
  });

  it('handles timeout and network disconnects', async () => {
    const clientTimeout = new TorqueQueryWorkerClient({
      baseUrl: 'http://torque.test',
      fetchImpl: async () => {
        throw new Error('fetch failed: connection timed out');
      },
      resolveSource: () => null,
    });
    await expect(clientTimeout.execute(task)).rejects.toThrow('connection timed out');
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

  it('rejects span-hash mismatch in result findings', async () => {
    const crypto = await import('node:crypto');
    const sha256 = (val: string) => `sha256:${crypto.createHash('sha256').update(val, 'utf8').digest('hex')}`;
    const doc = 'Sample text for span verification.';

    const sources: Record<string, { sourceId: string; revision: string; text: string }> = {
      'src-doc-001': {
        sourceId: 'src-doc-001',
        revision: sha256(doc),
        text: doc,
      },
    };

    const corruptedResult = {
      ...result,
      payload: {
        target_claim_ids: [],
        findings: [
          {
            type: 'observation',
            source_id: 'src-doc-001',
            source_revision: sha256(doc),
            source_span: {
              start: 0,
              end: 10,
              span_hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
            },
            confidence: 0.9,
            rationale: 'corrupted',
          },
        ],
      },
    };

    const client = new TorqueQueryWorkerClient({
      baseUrl: 'http://torque.test',
      fetchImpl: async () => new Response(JSON.stringify(corruptedResult), { status: 200 }),
      resolveSource: (id: string) => sources[id] ?? null,
    });

    await expect(client.execute(task)).rejects.toThrow('source span hash does not match stored text');
  });

  describe('Local Reference Worker Integration', () => {
    let worker: LocalReferenceWorkerInstance;
    const sampleDoc = 'Deterministic grounding text served by local reference worker fixture.';

    beforeAll(async () => {
      const crypto = await import('node:crypto');
      const sha256 = (val: string) => `sha256:${crypto.createHash('sha256').update(val, 'utf8').digest('hex')}`;
      worker = await startLocalReferenceWorker({
        sources: {
          'src-doc-001': {
            sourceId: 'src-doc-001',
            revision: sha256(sampleDoc),
            text: sampleDoc,
          },
        },
      });
    });

    afterAll(async () => {
      if (worker) await worker.close();
    });

    it('health endpoint returns local reference worker status', async () => {
      const resp = await fetch(`${worker.url}/health`);
      expect(resp.status).toBe(200);
      const data = await resp.json();
      expect(data.status).toBe('ok');
      expect(data.worker_type).toBe('local-reference-fixture');
      expect(data.production).toBe(false);
    });

    it('executes research.task.v1 against real HTTP local reference worker', async () => {
      const crypto = await import('node:crypto');
      const sha256 = (val: string) => `sha256:${crypto.createHash('sha256').update(val, 'utf8').digest('hex')}`;
      const client = new TorqueQueryWorkerClient({
        baseUrl: worker.url,
        resolveSource: (id: string) =>
          id === 'src-doc-001'
            ? {
                sourceId: 'src-doc-001',
                revision: sha256(sampleDoc),
                text: sampleDoc,
              }
            : null,
      });

      const res: any = await client.execute(task);
      expect(res.schema).toBe('research.result.v1');
      expect(res.task_id).toBe(task.task_id);
      expect(res.run_id).toBe(task.run_id);
      expect(res.status).toBe('completed');
      expect(res.producer.provider).toBe('local-reference-fixture');
      expect(res.payload.findings).toHaveLength(1);
      expect(res.payload.findings[0].source_id).toBe('src-doc-001');
      expect(res.payload.findings[0].source_span.span_hash).toBe(sha256(sampleDoc.slice(0, 64)));
    });

    it('returns 422 for invalid task schema', async () => {
      const resp = await fetch(`${worker.url}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schema: 'invalid.schema' }),
      });
      expect(resp.status).toBe(422);
      const err = await resp.json();
      expect(err.message).toBe('Invalid research.task.v1 schema');
    });
  });
});