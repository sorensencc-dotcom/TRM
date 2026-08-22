import { createServer } from 'node:http';
import { SigilRelayClient } from '../../src/protocol/sigilRelayClient';

describe('SigilRelayClient', () => {
  const envelope = {
    message_type: 'task.request' as const,
    idempotency_key: 'idem-1',
    body: { task_id: 'TASK-1', instruction: '{}', success_criteria: ['valid result'] },
  };

  it('sends an envelope to Sigil with bearer auth and request id', async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const client = new SigilRelayClient({
      baseUrl: 'http://relay.test/',
      token: 'token-1',
      requestId: () => 'request-1',
      fetchImpl: async (url, init) => {
        calls.push([url, init]);
        return new Response(JSON.stringify({ accepted: true }), { status: 202 });
      },
    });

    await expect(client.sendTask(envelope)).resolves.toEqual({ accepted: true });
    expect(calls[0][0]).toBe('http://relay.test/v1/envelopes');
    expect(calls[0][1]!.method).toBe('POST');
    expect(calls[0][1]!.headers).toEqual({
      authorization: 'Bearer token-1',
      'content-type': 'application/json',
      'x-sigil-request-id': 'request-1',
    });
    expect(JSON.parse(String(calls[0][1]!.body))).toEqual(envelope);
  });

  it('preserves structured relay errors', async () => {
    const client = new SigilRelayClient({
      baseUrl: 'http://relay.test',
      token: 'token-1',
      fetchImpl: async () => new Response(JSON.stringify({ code: 'APPROVAL_REQUIRED', message: 'approval needed', details: { task: 'TASK-1' } }), { status: 403 }),
    });

    await expect(client.sendTask(envelope)).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED',
      status: 403,
      details: { task: 'TASK-1' },
    });
  });


  it('preserves HTTP failure details when relay returns non-JSON text', async () => {
    const client = new SigilRelayClient({
      baseUrl: 'http://relay.test',
      token: 'token-1',
      fetchImpl: async () => new Response('<html>bad gateway</html>', { status: 502 }),
    });

    await expect(client.sendTask(envelope)).rejects.toMatchObject({
      code: 'DELIVERY_UNAVAILABLE',
      status: 502,
    });
    await expect(client.sendTask(envelope)).rejects.toThrow('<html>bad gateway</html>');
  });

  it('sends over a real local HTTP relay fixture', async () => {
    const received: { url?: string; authorization?: string; body?: string } = {};
    const server = createServer((request, response) => {
      received.url = request.url;
      received.authorization = request.headers.authorization;
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        received.body = body;
        response.writeHead(202, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ accepted: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    try {
      const result = await new SigilRelayClient({ baseUrl: 'http://127.0.0.1:' + address.port, token: 'token-1', requestId: () => 'request-local' }).sendTask(envelope);
      expect(result).toEqual({ accepted: true });
      expect(received.url).toBe('/v1/envelopes');
      expect(received.authorization).toBe('Bearer token-1');
      expect(JSON.parse(received.body ?? '')).toEqual(envelope);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
