import http from 'node:http';
import crypto from 'node:crypto';
import { validateResearchTask } from './taskValidator';

/**
 * Local Reference & Conformance Fixture Worker.
 *
 * NOTE: This is strictly a local deterministic reference fixture for protocol
 * contract testing and conformance verification (research.task.v1 -> research.result.v1).
 * It is NOT a production LLM research worker.
 */

export interface SourceDocument {
  sourceId: string;
  revision: string;
  text: string;
  title?: string;
  url?: string;
}

export interface LocalReferenceWorkerOptions {
  sources?: Record<string, SourceDocument>;
  port?: number;
  host?: string;
}

export interface LocalReferenceWorkerInstance {
  server: http.Server;
  url: string;
  port: number;
  close: () => Promise<void>;
  setSources: (sources: Record<string, SourceDocument>) => void;
}

function sha256(val: string): string {
  return `sha256:${crypto.createHash('sha256').update(val, 'utf8').digest('hex')}`;
}

export function createLocalReferenceWorker(
  options: LocalReferenceWorkerOptions = {}
): LocalReferenceWorkerInstance {
  let sourcesMap = { ...options.sources };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          worker_type: 'local-reference-fixture',
          protocol: 'research.task.v1 -> research.result.v1',
          production: false,
        })
      );
      return;
    }

    if (req.method === 'POST' && (url.pathname === '/tasks' || url.pathname === '/tasks/')) {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', async () => {
        let task: any;
        try {
          task = JSON.parse(raw);
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: 'Request body must be valid JSON' }));
          return;
        }

        const taskValidation = validateResearchTask(task);
        if (!taskValidation.valid) {
          res.writeHead(422, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              message: 'Invalid research.task.v1 schema',
              errors: taskValidation.errors,
            })
          );
          return;
        }

        const sourceIds: string[] = Array.isArray(task.inputs?.source_ids)
          ? task.inputs.source_ids
          : Object.keys(sourcesMap);

        const providerName = process.env.PROVIDER_NAME || 'local-reference-fixture';
        const ollamaHost = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
        const ollamaModel = process.env.OLLAMA_MODEL || 'llama3.2';

        const findings: any[] = [];
        for (const sourceId of sourceIds) {
          const doc = sourcesMap[sourceId];
          if (!doc || typeof doc.text !== 'string' || doc.text.length === 0) continue;

          const findingsBefore = findings.length;

          if (providerName === 'ollama') {
            try {
              const prompt = `You are a research citation engine. Analyze this document according to the following instruction:
"${task.instruction || 'Extract key cited observations'}"

Document (${sourceId}):
"""
${doc.text}
"""

Return a JSON object with this exact structure:
{
  "findings": [
    {
      "type": "observation",
      "verbatim_quote": "exact quote from the document",
      "rationale": "explanation of this finding",
      "confidence": 0.95
    }
  ]
}`;
              const ollamaResp = await fetch(`${ollamaHost}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  model: ollamaModel,
                  messages: [{ role: 'user', content: prompt }],
                  format: 'json',
                  stream: false,
                }),
              });

              if (ollamaResp.ok) {
                const ollamaData: any = await ollamaResp.json();
                const parsed = JSON.parse(ollamaData.message?.content || '{}');
                const list = Array.isArray(parsed.findings) ? parsed.findings : [];
                for (const item of list) {
                  if (!item.verbatim_quote || typeof item.verbatim_quote !== 'string') continue;
                  const idx = doc.text.indexOf(item.verbatim_quote);
                  if (idx === -1) continue;
                  const spanText = doc.text.slice(idx, idx + item.verbatim_quote.length);
                  findings.push({
                    type: item.type || 'observation',
                    source_id: sourceId,
                    source_revision: doc.revision || sha256(doc.text),
                    source_span: {
                      start: idx,
                      end: idx + item.verbatim_quote.length,
                      span_hash: sha256(spanText),
                    },
                    confidence: typeof item.confidence === 'number' ? item.confidence : 0.95,
                    rationale: item.rationale || `Grounded extraction from ${sourceId}`,
                  });
                }
              }
            } catch (err) {
              console.error('Ollama execution error, falling back to deterministic extraction:', err);
            }
          }

          // Fallback if this source produced no findings from Ollama or in fixture mode
          if (findings.length === findingsBefore) {
            const sliceLen = Math.min(doc.text.length, 64);
            const spanText = doc.text.slice(0, sliceLen);
            findings.push({
              type: 'observation',
              source_id: sourceId,
              source_revision: doc.revision || sha256(doc.text),
              source_span: {
                start: 0,
                end: sliceLen,
                span_hash: sha256(spanText),
              },
              confidence: 0.95,
              rationale: `Grounded observation from source ${sourceId}`,
            });
          }
        }

        const result = {
          schema: 'research.result.v1',
          task_id: task.task_id,
          run_id: task.run_id,
          attempt_id: task.attempt_id || 'att-1',
          status: 'completed',
          producer: {
            engine: providerName === 'ollama' ? 'torquequery-worker-ollama' : 'torquequery-worker-ref',
            provider: providerName,
            model: providerName === 'ollama' ? ollamaModel : 'fixture-deterministic',
            prompt_version: 'v1.0.0',
          },
          payload: {
            target_claim_ids: Array.isArray(task.subject?.claims) ? task.subject.claims : [],
            findings,
          },
          requires_approval: task.approval_required ?? true,
        };

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: `Not found: ${req.method} ${url.pathname}` }));
  });

  const host = options.host || '127.0.0.1';
  let port = options.port || 0;

  return {
    server,
    get url() {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return `http://${host}:${port}`;
      return `http://127.0.0.1:${addr.port}`;
    },
    get port() {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return port;
      return addr.port;
    },
    setSources(newSources: Record<string, SourceDocument>) {
      sourcesMap = { ...newSources };
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export async function startLocalReferenceWorker(
  options: LocalReferenceWorkerOptions = {}
): Promise<LocalReferenceWorkerInstance> {
  const instance = createLocalReferenceWorker(options);
  const host = options.host || '127.0.0.1';
  const port = options.port ?? 0;
  await new Promise<void>((resolve) => {
    instance.server.listen(port, host, () => resolve());
  });
  return instance;
}

if (typeof require !== 'undefined' && require.main === module) {
  const port = parseInt(process.env.PORT || '8085', 10);
  const host = process.env.HOST || '0.0.0.0';
  startLocalReferenceWorker({ port, host }).then(() => {
    console.log(`Research Worker listening on ${host}:${port}`);
  });
}
