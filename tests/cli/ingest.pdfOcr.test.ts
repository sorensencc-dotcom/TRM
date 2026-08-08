import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCreate } from '../../src/cli/commands/create';
import { runIngest } from '../../src/cli/commands/ingest';

// pdf-parse's bundled pdfjs-dist uses a dynamic import() that Jest's
// sandbox can't execute (Jest-only; real Node usage is unaffected). This
// test is about the OCR fallback, not pdf-parse itself, so stub it to
// force the fallback deterministically -- same pattern already used in
// tests/ingestion/fileConvert.test.ts. Everything downstream
// (getPdfPageCount/renderPdfPage/ocrPage) stays real/uninjected.
const mockGetText = jest.fn().mockResolvedValue({ text: '' });
const mockDestroy = jest.fn().mockResolvedValue(undefined);

jest.mock('pdf-parse', () => ({
  PDFParse: jest.fn().mockImplementation(() => ({
    getText: mockGetText,
    destroy: mockDestroy,
  })),
}));

const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'scanned-sample.pdf');

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-ingest-pdf-ocr-'));
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({ default_scoring_adapter: 'stub', promotion_threshold: 80, actor_source: 'cli-only', time_source: 'system' })
  );
  return root;
}

describe('runIngest: scanned PDF end-to-end', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('scanned PDF with no text layer OCRs via the mocked Vision endpoint and writes non-empty extracted text', async () => {
    global.fetch = jest.fn().mockImplementation((url: string) => {
      if (String(url).endsWith('/api/analyze/ocr')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            text: 'End-to-end mocked OCR text',
            metadata: { format: 'png', processedAt: new Date().toISOString(), latencyMs: 5 },
          }),
        });
      }
      return Promise.reject(new Error(`unexpected fetch to ${url}`));
    }) as unknown as typeof global.fetch;

    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });

    const entry = await runIngest(root, 'cuba', {
      actor: 'ACTOR-001',
      type: 'pdf',
      title: 'Vessel Register',
      origin: 'LOC',
      file: FIXTURE_PATH,
    });

    expect(entry?.id).toBe('SRC-001');
    const rawPath = path.join(root, 'topics', 'cuba', 'sources', 'raw', 'SRC-001.json');
    expect(fs.existsSync(rawPath)).toBe(true);
    const envelope = JSON.parse(fs.readFileSync(rawPath, 'utf-8'));
    expect(envelope.kind).toBe('text');
    expect(envelope.text).toBe(
      'End-to-end mocked OCR text\n\n--- page 2 ---\n\nEnd-to-end mocked OCR text'
    );
  }, 30000);
});
