import { randomUUID } from 'node:crypto';

export interface SigilRelayClientOptions {
  baseUrl: string;
  token: string;
  requestId?: () => string;
  fetchImpl?: typeof fetch;
}

export class SigilRelayClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly requestId: () => string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SigilRelayClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.token;
    this.requestId = options.requestId ?? randomUUID;
    this.fetchImpl = options.fetchImpl ?? fetch;
    if (!this.baseUrl || !this.token) throw new Error('baseUrl and token are required');
  }

  async sendTask(envelope: unknown): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/envelopes`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        'x-sigil-request-id': this.requestId(),
      },
      body: JSON.stringify(envelope),
    });
    const text = await response.text();
    let body: any = null;
    if (text) {
      try { body = JSON.parse(text); }
      catch { body = { message: text }; }
    }
    if (!response.ok) {
      throw Object.assign(new Error(body?.message ?? `Relay request failed: ${response.status}`), {
        code: body?.code ?? 'DELIVERY_UNAVAILABLE',
        status: response.status,
        details: body?.details ?? {},
      });
    }
    return body;
  }
}
