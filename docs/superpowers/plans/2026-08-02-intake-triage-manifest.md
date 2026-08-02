# Intake Triage Manifest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the TRM ingest pipeline a resumable pre-scan step that hashes, dedups, and classifies a raw file dump (`trm/intake/<batch>/**`) into a manifest — so files can be routed by type/batch to the right downstream pipeline instead of being triaged one-by-one by hand.

**Architecture:** Reuses existing infra rather than building parallel plumbing: `contentHash.ts` for hashing, the `writeFileAtomic`/manifest-entry pattern from `manifestStore.ts` (new sibling module since this manifest is global/pre-topic, not per-topic), and — the key discovery from file-structure mapping — `classify.ts`'s `classifyImage()` already has a documented, signature-stable extension point ("swap the body for a real cheap-vision-call classifier... without touching callers") that was left as an aspect-ratio placeholder. This plan fills that placeholder in with a real Google-Vision-label-based classification, gated behind the existing `CIC_INGESTION_URL` HTTP pattern (`imageAnalyzer.ts` → `cic-ingestion` service), with the placeholder heuristic kept as an automatic fallback when vision is unavailable or unconfigured. No new service, no new dependency, no new vision-call pathway — `cic-ingestion` already computes Google Vision labels via `LABEL_DETECTION` on every `/api/analyze/image` call, it just currently discards them before responding.

**Tech Stack:** TypeScript, Jest, existing `p-limit`-based concurrency pools, Express (cic-ingestion side), Google Cloud Vision client (already a cic-ingestion dependency).

## Global Constraints

- Manifest is resumable: rerunning after a crash/interrupt must not reprocess hashes already marked `done`, and must retry hashes marked `failed`.
- Files under `intake/` are never moved, renamed, or copied by this work.
- Exact-duplicate detection only (SHA-256 content hash), no perceptual/near-dup matching.
- `classifyImage()`'s public signature (`(filePath, opts?) => Promise<ImageKind>`) does not change — existing callers (`ingestDir.ts`) must keep working untouched.
- No live network calls in unit tests — vision-call tests mock `global.fetch`; classify.ts falls back to the existing aspect-ratio heuristic whenever `CIC_INGESTION_URL` is unset, so existing `classify.test.ts` cases keep passing unmodified.
- No secret/API-key values are ever logged.

---

### Task 1: `cic-ingestion` — return Vision labels from `/api/analyze/image`

**Files:**
- Modify: `c:\dev\cic-ingestion\src\services\imageAnalysis\types.ts`
- Modify: `c:\dev\cic-ingestion\src\services\imageAnalysis\ImageAnalysisService.ts`
- Test: `c:\dev\cic-ingestion\src\services\imageAnalysis\__tests__\ImageAnalysisService.test.ts` (create if it does not already exist — check first with `find src/services/imageAnalysis -iname "ImageAnalysisService.test.ts"`)

**Interfaces:**
- Produces: `AnalyzeImageResponse.labels: Array<{ description: string; score: number }>` — consumed by Task 2 (`trm`'s `imageAnalyzer.ts`).

- [ ] **Step 1: Write the failing test**

```typescript
// c:\dev\cic-ingestion\src\services\imageAnalysis\__tests__\ImageAnalysisService.test.ts
import { ImageAnalysisService } from '../ImageAnalysisService';

describe('ImageAnalysisService labels passthrough', () => {
  const onePxPng = Buffer.from(
    '89504e470d0a1a0a0000000d494844520000000100000001080600000' +
    '01f15c4890000000a49444154789c6360000002000155000005e6cc7b' +
    '000000000049454e44ae426082',
    'hex'
  ).toString('base64');

  it('mock mode (no API key) returns an empty labels array, not undefined', async () => {
    delete process.env.VISION_API_KEY;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const service = new ImageAnalysisService({});
    const result = await service.analyze({ imageBuffer: onePxPng, requestId: 'test-1' });
    expect(result.labels).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd c:\dev\cic-ingestion && npx jest src/services/imageAnalysis/__tests__/ImageAnalysisService.test.ts -t "labels array"`
Expected: FAIL — `result.labels` is `undefined` (property does not exist yet).

- [ ] **Step 3: Implement**

In `types.ts`, add a `Label` type and add `labels` to the response:

```typescript
export interface Label {
  description: string;
  score: number; // 0-1
}

export interface AnalyzeImageResponse {
  matches: ImageMatch[];
  labels: Label[];
  metadata: AnalysisMetadata;
}
```

In `ImageAnalysisService.ts`, thread labels through both the real-Vision path and the mock path:

```typescript
// in analyze(), real-Vision branch — after `const matches = this._transformVisionResults(visionResult);`
const labels: Label[] = (visionResult.labels || []).map((l) => ({
  description: l.description,
  score: l.score,
}));

return {
  matches,
  labels,
  metadata: { /* unchanged */ },
};
```

```typescript
// _generateMockResults — add labels: [] to the returned object
private _generateMockResults(imageBuffer: Buffer, format: string): AnalyzeImageResponse {
  const mockMatches: ImageMatch[] = [ /* unchanged */ ];
  return {
    matches: mockMatches,
    labels: [],
    metadata: { /* unchanged */ },
  };
}
```

Add the `Label` import at the top of `ImageAnalysisService.ts`:
```typescript
import { AnalyzeImageRequest, AnalyzeImageResponse, ImageMatch, ImageAnalysisConfig, OcrRequest, OcrResponse, Label } from './types';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd c:\dev\cic-ingestion && npx jest src/services/imageAnalysis/__tests__/ImageAnalysisService.test.ts`
Expected: PASS

- [ ] **Step 5: Run full imageAnalysis test suite to check for regressions**

Run: `cd c:\dev\cic-ingestion && npx jest src/services/imageAnalysis`
Expected: All PASS (existing `router.test.ts`, `observability.test.ts` unaffected — they don't assert on the full response shape).

- [ ] **Step 6: Commit**

```bash
cd c:\dev\cic-ingestion
git add src/services/imageAnalysis/types.ts src/services/imageAnalysis/ImageAnalysisService.ts src/services/imageAnalysis/__tests__/ImageAnalysisService.test.ts
git commit -m "feat(imageAnalysis): return Vision labels from /api/analyze/image

Labels were already being computed by LABEL_DETECTION and discarded
before the response. Exposing them lets downstream callers classify
images (photo vs scanned document) without a second vision call."
```

---

### Task 2: `trm` — pass Vision labels through `ImageAnalyzer.extract()`

**Files:**
- Modify: `c:\dev\trm\src\ingestion\imageExtract\imageAnalyzer.ts`
- Modify: `c:\dev\trm\src\ingestion\imageExtract\imageAnalyzer.test.ts`

**Interfaces:**
- Consumes: `cic-ingestion`'s `/api/analyze/image` response now includes `labels` (Task 1).
- Produces: `AnalysisResult.labels: Array<{ description: string; score: number }>` — consumed by Task 3 (`classify.ts`).

- [ ] **Step 1: Write the failing test**

Add to `imageAnalyzer.test.ts`:

```typescript
it('passes through labels from the service response', async () => {
  const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]);
  global.fetch = jest.fn().mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      matches: [],
      labels: [{ description: 'Document', score: 0.91 }],
      metadata: {
        format: 'png',
        visionApiUsed: true,
        latencyMs: 12,
        apiProvider: 'google_vision',
      },
    }),
  });

  const result = await analyzer.extract(pngBuffer);
  expect(result.labels).toEqual([{ description: 'Document', score: 0.91 }]);
});

it('defaults labels to an empty array when the service response omits it', async () => {
  const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]);
  global.fetch = jest.fn().mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      matches: [],
      metadata: { format: 'png', visionApiUsed: false, latencyMs: 10, apiProvider: 'mock' },
    }),
  });

  const result = await analyzer.extract(pngBuffer);
  expect(result.labels).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd c:\dev\trm && npx jest src/ingestion/imageExtract/imageAnalyzer.test.ts -t "passes through labels"`
Expected: FAIL — `result.labels` is `undefined`.

- [ ] **Step 3: Implement**

In `imageAnalyzer.ts`, add `labels` to `AnalysisResult` and thread it through `_callService`:

```typescript
export interface Label {
  description: string;
  score: number;
}

export interface AnalysisResult {
  matches: ImageMatch[];
  labels: Label[];
  metadata: {
    format: string;
    size: number;
    processedAt: string;
    visionApiUsed: boolean;
    latencyMs: number;
    apiProvider: string;
    error?: string;
  };
}
```

In `_callService`, after `const data = await response.json() as any;`:

```typescript
return {
  matches: data.matches || [],
  labels: data.labels || [],
  metadata: { /* unchanged */ },
};
```

Also add `labels: []` to `_createErrorResult`'s returned object so the type stays consistent on the error path.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd c:\dev\trm && npx jest src/ingestion/imageExtract/imageAnalyzer.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
cd c:\dev\trm
git add src/ingestion/imageExtract/imageAnalyzer.ts src/ingestion/imageExtract/imageAnalyzer.test.ts
git commit -m "feat(imageAnalyzer): pass through Vision labels from cic-ingestion"
```

---

### Task 3: Real vision-label classification in `classify.ts`, aspect-ratio kept as fallback

**Files:**
- Modify: `c:\dev\trm\src\ingestion\imageExtract\classify.ts`
- Modify: `c:\dev\trm\tests\ingestion\imageExtract\classify.test.ts`

**Interfaces:**
- Consumes: `ImageAnalyzer.extract()` → `AnalysisResult.labels` (Task 2).
- Produces: `classifyImage(filePath, opts?) => Promise<ImageKind>` — **signature unchanged**, still consumed as-is by `ingestDir.ts` and by Task 5 (`triage-intake.ts`).

- [ ] **Step 1: Write the failing test**

Add to `classify.test.ts`:

```typescript
describe('vision-label classification (when CIC_INGESTION_URL is set)', () => {
  const originalEnv = process.env.CIC_INGESTION_URL;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CIC_INGESTION_URL;
    else process.env.CIC_INGESTION_URL = originalEnv;
    jest.restoreAllMocks();
  });

  it('classifies as text-doc when a Document-like label scores above threshold', async () => {
    process.env.CIC_INGESTION_URL = 'http://localhost:9999';
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        matches: [],
        labels: [{ description: 'Document', score: 0.88 }],
        metadata: { format: 'png', visionApiUsed: true, latencyMs: 5, apiProvider: 'google_vision' },
      }),
    });

    const fixture = path.join(fixturesDir, 'photo-valid-1x1.png'); // aspect ratio alone would say "photo"
    const result = await classifyImage(fixture);
    expect(result).toBe('text-doc');
  });

  it('classifies as photo when labels have no document-like signal', async () => {
    process.env.CIC_INGESTION_URL = 'http://localhost:9999';
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        matches: [],
        labels: [{ description: 'Airplane', score: 0.95 }],
        metadata: { format: 'png', visionApiUsed: true, latencyMs: 5, apiProvider: 'google_vision' },
      }),
    });

    const fixture = path.join(fixturesDir, 'text-doc-valid-scanned-page.png'); // aspect ratio alone would say "text-doc"
    const result = await classifyImage(fixture);
    expect(result).toBe('photo');
  });

  it('falls back to the aspect-ratio heuristic when the vision call throws', async () => {
    process.env.CIC_INGESTION_URL = 'http://localhost:9999';
    global.fetch = jest.fn().mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const fixture = path.join(fixturesDir, 'text-doc-valid-scanned-page.png');
    const result = await classifyImage(fixture);
    expect(result).toBe('text-doc'); // aspect-ratio fallback result, unchanged from today
  });

  it('an explicit opts.kind override still short-circuits before any vision call', async () => {
    process.env.CIC_INGESTION_URL = 'http://localhost:9999';
    global.fetch = jest.fn();
    const result = await classifyImage('/nonexistent/path.png', { kind: 'photo' });
    expect(result).toBe('photo');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd c:\dev\trm && npx jest tests/ingestion/imageExtract/classify.test.ts -t "vision-label classification"`
Expected: FAIL — current body never calls `fetch`, so all four new assertions fail (results come from the aspect-ratio path regardless of mocked labels).

- [ ] **Step 3: Implement**

Replace the body of `classify.ts`:

```typescript
import * as fs from 'node:fs';
import { ImageAnalyzer } from './imageAnalyzer';

export type ImageKind = 'photo' | 'text-doc';

export interface ClassifyOptions {
  kind?: ImageKind;
}

interface Dimensions {
  width: number;
  height: number;
}

const DOCUMENT_LABEL_KEYWORDS = [
  'document', 'text', 'paper', 'letter', 'receipt', 'book', 'newspaper', 'page', 'handwriting',
];
const LABEL_CONFIDENCE_THRESHOLD = 0.5;

/**
 * Classifies an image as a photo or a scanned/photographed text document.
 * Primary path: one Vision-label call via ImageAnalyzer (CIC_INGESTION_URL),
 * checking for document-like labels above LABEL_CONFIDENCE_THRESHOLD. Falls
 * back to the aspect-ratio heuristic below whenever CIC_INGESTION_URL is
 * unset or the vision call fails -- this keeps the function usable offline
 * and keeps existing callers/tests working with no vision service running.
 */
export async function classifyImage(filePath: string, opts?: ClassifyOptions): Promise<ImageKind> {
  if (opts?.kind) return opts.kind;

  const cicIngestionUrl = process.env.CIC_INGESTION_URL;
  if (cicIngestionUrl) {
    try {
      const buffer = await fs.promises.readFile(filePath);
      const analyzer = new ImageAnalyzer(cicIngestionUrl, 5000, 1);
      const result = await analyzer.extract(buffer);
      const hasDocumentLabel = result.labels.some(
        (label) =>
          label.score >= LABEL_CONFIDENCE_THRESHOLD &&
          DOCUMENT_LABEL_KEYWORDS.some((kw) => label.description.toLowerCase().includes(kw))
      );
      return hasDocumentLabel ? 'text-doc' : 'photo';
    } catch {
      // Fall through to the aspect-ratio heuristic below.
    }
  }

  const buffer = await fs.promises.readFile(filePath);
  const dims = readDimensions(buffer);
  if (!dims || dims.width <= 0) return 'photo';

  const aspectRatio = dims.height / dims.width;
  return aspectRatio >= 1.3 ? 'text-doc' : 'photo';
}

// readDimensions, isPng, readPngDimensions, isJpeg, readJpegDimensions: unchanged, keep as-is.
```

Keep every function below `classifyImage` (`readDimensions` through `readJpegDimensions`) exactly as they are today — only `classifyImage`'s body changes.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd c:\dev\trm && npx jest tests/ingestion/imageExtract/classify.test.ts`
Expected: All PASS, including every pre-existing test in the file (they never set `CIC_INGESTION_URL`, so they take the unchanged aspect-ratio path).

- [ ] **Step 5: Run the full trm test suite to check for regressions in `ingestDir`**

Run: `cd c:\dev\trm && npx jest tests/cli/commands/ingestDir.test.ts` (locate the actual path first with `find tests -iname "ingestDir*"` if this differs)
Expected: All PASS — `ingestDir.ts` doesn't set `CIC_INGESTION_URL` for the purpose of classification (it's used for OCR separately, but that's a distinct call already covered by existing tests) and passes `cliArgs.kind` through unchanged.

- [ ] **Step 6: Commit**

```bash
cd c:\dev\trm
git add src/ingestion/imageExtract/classify.ts tests/ingestion/imageExtract/classify.test.ts
git commit -m "feat(classify): real Vision-label classification, aspect-ratio as fallback

Fills the extension point already documented in classifyImage's
docstring. Signature is unchanged so ingestDir.ts and the new
triage-intake script both keep working without modification."
```

---

### Task 4: `intakeManifest.ts` — resumable global triage manifest

**Files:**
- Create: `c:\dev\trm\src\core\intakeManifest.ts`
- Test: `c:\dev\trm\tests\core\intakeManifest.test.ts`

**Interfaces:**
- Consumes: nothing (pure fs module, mirrors `manifestStore.ts` conventions and reuses `writeFileAtomic` from `atomicWrite.ts`).
- Produces: `IntakeEntry`, `readIntakeManifest`, `isIntakeDone`, `writeIntakeEntry`, `findByHash` — consumed by Task 5 (`triage-intake.ts`).

- [ ] **Step 1: Write the failing test**

```typescript
// c:\dev\trm\tests\core\intakeManifest.test.ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  intakeManifestPath,
  readIntakeManifest,
  writeIntakeEntry,
  isIntakeDone,
  findByHash,
  IntakeEntry,
} from '../../src/core/intakeManifest';

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trm-intake-'));
}

function makeEntry(overrides: Partial<IntakeEntry> = {}): IntakeEntry {
  return {
    hash: 'abc123',
    sourcePath: 'intake/mfm/photo1.jpg',
    batch: 'mfm',
    ext: '.jpg',
    sizeBytes: 1024,
    kind: 'image',
    classifiedType: 'exhibit-photo',
    isDup: false,
    status: 'done',
    classifiedAt: '2026-08-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('intakeManifest', () => {
  it('intakeManifestPath points at intake-manifest.json under root', () => {
    const root = makeRoot();
    expect(intakeManifestPath(root)).toBe(path.join(root, 'intake-manifest.json'));
  });

  it('readIntakeManifest returns an empty entries map when no file exists yet', () => {
    const root = makeRoot();
    expect(readIntakeManifest(root)).toEqual({ entries: {} });
  });

  it('writeIntakeEntry then readIntakeManifest round-trips an entry, keyed by hash', () => {
    const root = makeRoot();
    const entry = makeEntry();
    writeIntakeEntry(root, entry);
    const manifest = readIntakeManifest(root);
    expect(manifest.entries['abc123']).toEqual(entry);
  });

  it('isIntakeDone is false for an unknown hash', () => {
    const root = makeRoot();
    expect(isIntakeDone(root, 'nope')).toBe(false);
  });

  it('isIntakeDone is true only when status is done', () => {
    const root = makeRoot();
    writeIntakeEntry(root, makeEntry({ hash: 'h1', status: 'done' }));
    writeIntakeEntry(root, makeEntry({ hash: 'h2', status: 'failed', error: 'boom' }));
    expect(isIntakeDone(root, 'h1')).toBe(true);
    expect(isIntakeDone(root, 'h2')).toBe(false);
  });

  it('findByHash returns the existing entry for dedup lookups, or null', () => {
    const root = makeRoot();
    writeIntakeEntry(root, makeEntry({ hash: 'h1' }));
    expect(findByHash(root, 'h1')?.hash).toBe('h1');
    expect(findByHash(root, 'missing')).toBeNull();
  });

  it('writeIntakeEntry creates intake-manifest.json if it does not exist yet', () => {
    const root = makeRoot();
    writeIntakeEntry(root, makeEntry());
    expect(fs.existsSync(path.join(root, 'intake-manifest.json'))).toBe(true);
  });

  it('writing a second entry preserves the first (no overwrite of unrelated hashes)', () => {
    const root = makeRoot();
    writeIntakeEntry(root, makeEntry({ hash: 'h1' }));
    writeIntakeEntry(root, makeEntry({ hash: 'h2', sourcePath: 'intake/mfm/photo2.jpg' }));
    const manifest = readIntakeManifest(root);
    expect(Object.keys(manifest.entries).sort()).toEqual(['h1', 'h2']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd c:\dev\trm && npx jest tests/core/intakeManifest.test.ts`
Expected: FAIL — `src/core/intakeManifest.ts` does not exist yet (module not found).

- [ ] **Step 3: Implement**

```typescript
// c:\dev\trm\src\core\intakeManifest.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomic } from './atomicWrite';

export type IntakeKind = 'image' | 'text';
export type IntakeType = 'exhibit-photo' | 'doc-photo' | 'text' | 'junk' | 'unsure';
export type IntakeStatus = 'done' | 'failed';

export interface IntakeEntry {
  hash: string;
  sourcePath: string;
  batch: string;
  ext: string;
  sizeBytes: number;
  kind: IntakeKind;
  classifiedType: IntakeType;
  confidence?: number;
  isDup: boolean;
  status: IntakeStatus;
  error?: string;
  classifiedAt: string;
}

export interface IntakeManifestFile {
  entries: Record<string, IntakeEntry>;
}

export function intakeManifestPath(root: string): string {
  return path.join(root, 'intake-manifest.json');
}

export function readIntakeManifest(root: string): IntakeManifestFile {
  const file = intakeManifestPath(root);
  if (!fs.existsSync(file)) return { entries: {} };
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

export function writeIntakeEntry(root: string, entry: IntakeEntry): void {
  const manifest = readIntakeManifest(root);
  manifest.entries[entry.hash] = entry;
  writeFileAtomic(intakeManifestPath(root), JSON.stringify(manifest, null, 2));
}

export function isIntakeDone(root: string, hash: string): boolean {
  return readIntakeManifest(root).entries[hash]?.status === 'done';
}

export function findByHash(root: string, hash: string): IntakeEntry | null {
  return readIntakeManifest(root).entries[hash] ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd c:\dev\trm && npx jest tests/core/intakeManifest.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
cd c:\dev\trm
git add src/core/intakeManifest.ts tests/core/intakeManifest.test.ts
git commit -m "feat(core): add resumable intake-triage manifest store

Mirrors manifestStore.ts's hash-keyed/atomic-write/resumable pattern,
but global (not scoped to a topic node) since triage runs before any
topic is assigned."
```

---

### Task 5: `triage-intake.ts` script — walk, hash, dedup, classify, checkpoint

**Files:**
- Create: `c:\dev\trm\src\cli\commands\triageIntake.ts`
- Modify: `c:\dev\trm\src\cli\index.ts` (register the command)
- Modify: `c:\dev\trm\package.json` (add `triage:intake` script — optional convenience, the CLI command is the real entry point)
- Test: `c:\dev\trm\tests\cli\commands\triageIntake.test.ts`

**Interfaces:**
- Consumes: `hashFile` (`contentHash.ts`), `classifyImage` (`classify.ts`, Task 3), `isIntakeDone`/`findByHash`/`writeIntakeEntry` (`intakeManifest.ts`, Task 4), `visionPool` (`concurrency.ts`).
- Produces: `runTriageIntake(root, opts): Promise<TriageIntakeSummary>` — CLI-testable entry point, mirrors `runIngestDir`'s shape.

- [ ] **Step 1: Write the failing test**

```typescript
// c:\dev\trm\tests\cli\commands\triageIntake.test.ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTriageIntake } from '../../../src/cli/commands/triageIntake';
import { readIntakeManifest } from '../../../src/core/intakeManifest';
import * as classifyModule from '../../../src/ingestion/imageExtract/classify';

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-triage-'));
  return root;
}

function writeIntakeFile(root: string, batch: string, name: string, contents: string | Buffer): string {
  const dir = path.join(root, 'intake', batch);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents);
  return file;
}

describe('runTriageIntake', () => {
  afterEach(() => jest.restoreAllMocks());

  it('classifies a text file as classifiedType "text" with no vision call', async () => {
    const root = makeRoot();
    writeIntakeFile(root, 'old-chats', 'export1.md', '# chat export\nsome text');
    const classifySpy = jest.spyOn(classifyModule, 'classifyImage');

    const summary = await runTriageIntake(root, {});
    const manifest = readIntakeManifest(root);
    const entries = Object.values(manifest.entries);

    expect(entries).toHaveLength(1);
    expect(entries[0].classifiedType).toBe('text');
    expect(entries[0].batch).toBe('old-chats');
    expect(classifySpy).not.toHaveBeenCalled();
    expect(summary.totalFiles).toBe(1);
  });

  it('classifies an image file via classifyImage, mapping photo -> exhibit-photo', async () => {
    const root = makeRoot();
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeIntakeFile(root, 'mfm', 'photo1.png', pngBytes);
    jest.spyOn(classifyModule, 'classifyImage').mockResolvedValueOnce('photo');

    await runTriageIntake(root, {});
    const manifest = readIntakeManifest(root);
    const entry = Object.values(manifest.entries)[0];

    expect(entry.classifiedType).toBe('exhibit-photo');
    expect(entry.kind).toBe('image');
  });

  it('maps text-doc classification to doc-photo', async () => {
    const root = makeRoot();
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeIntakeFile(root, 'benson-ford', 'scan1.png', pngBytes);
    jest.spyOn(classifyModule, 'classifyImage').mockResolvedValueOnce('text-doc');

    await runTriageIntake(root, {});
    const manifest = readIntakeManifest(root);
    expect(Object.values(manifest.entries)[0].classifiedType).toBe('doc-photo');
  });

  it('marks a second identical file as a dup without calling classifyImage again', async () => {
    const root = makeRoot();
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeIntakeFile(root, 'mfm', 'photo1.png', pngBytes);
    writeIntakeFile(root, 'mfm', 'photo1-copy.png', pngBytes); // identical bytes
    const classifySpy = jest.spyOn(classifyModule, 'classifyImage').mockResolvedValue('photo');

    await runTriageIntake(root, {});
    const manifest = readIntakeManifest(root);
    const entries = Object.values(manifest.entries);

    expect(entries).toHaveLength(1); // same hash -> same manifest key
    expect(classifySpy).toHaveBeenCalledTimes(1);
  });

  it('marks an unreadable/unsupported extension as failed and continues', async () => {
    const root = makeRoot();
    writeIntakeFile(root, 'misc', 'weird.xyz', 'unsupported');

    const summary = await runTriageIntake(root, {});
    const manifest = readIntakeManifest(root);
    const entry = Object.values(manifest.entries)[0];

    expect(entry.status).toBe('failed');
    expect(entry.error).toMatch(/unsupported extension/i);
    expect(summary.failedCount).toBe(1);
  });

  it('resumes: a second run skips files already marked done', async () => {
    const root = makeRoot();
    writeIntakeFile(root, 'old-chats', 'export1.md', 'text content');

    await runTriageIntake(root, {});
    const classifySpy = jest.spyOn(classifyModule, 'classifyImage');
    const summary2 = await runTriageIntake(root, {});

    expect(summary2.skippedCount).toBe(1);
    expect(classifySpy).not.toHaveBeenCalled();
  });

  it('--dir scopes the walk to a single batch folder', async () => {
    const root = makeRoot();
    writeIntakeFile(root, 'mfm', 'a.md', 'text a');
    writeIntakeFile(root, 'benson-ford', 'b.md', 'text b');

    const summary = await runTriageIntake(root, { dir: 'intake/mfm' });
    expect(summary.totalFiles).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd c:\dev\trm && npx jest tests/cli/commands/triageIntake.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// c:\dev\trm\src\cli\commands\triageIntake.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { hashFile } from '../../core/contentHash';
import { visionPool } from '../../core/concurrency';
import {
  IntakeEntry,
  IntakeType,
  writeIntakeEntry,
  isIntakeDone,
  findByHash,
} from '../../core/intakeManifest';
import { classifyImage } from '../../ingestion/imageExtract/classify';

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.json']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic']);

export interface TriageIntakeOptions {
  dir?: string; // relative to root, e.g. "intake/mfm"; omit to scan all of intake/
}

export interface TriageIntakeSummary {
  totalFiles: number;
  processedCount: number;
  skippedCount: number;
  dupCount: number;
  failedCount: number;
  byType: Record<string, number>;
}

function walkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) out.push(...walkFiles(full));
    else if (stat.isFile()) out.push(full);
  }
  return out;
}

function batchFor(root: string, filePath: string): string {
  const intakeDir = path.join(root, 'intake');
  const rel = path.relative(intakeDir, filePath);
  return rel.split(path.sep)[0];
}

export async function runTriageIntake(
  root: string,
  opts: TriageIntakeOptions
): Promise<TriageIntakeSummary> {
  const walkDir = opts.dir ? path.join(root, opts.dir) : path.join(root, 'intake');
  const files = walkFiles(walkDir);

  const summary: TriageIntakeSummary = {
    totalFiles: files.length,
    processedCount: 0,
    skippedCount: 0,
    dupCount: 0,
    failedCount: 0,
    byType: {},
  };

  for (const filePath of files) {
    const rel = path.relative(root, filePath).split(path.sep).join('/');
    const batch = batchFor(root, filePath);
    const ext = path.extname(filePath).toLowerCase();

    let hash: string;
    try {
      hash = await hashFile(filePath);
    } catch (err) {
      summary.failedCount++;
      continue;
    }

    if (isIntakeDone(root, hash)) {
      summary.skippedCount++;
      continue;
    }

    const existing = findByHash(root, hash);
    if (existing) {
      const entry: IntakeEntry = {
        ...existing,
        sourcePath: rel,
        batch,
        isDup: true,
        status: 'done',
        classifiedAt: new Date().toISOString(),
      };
      writeIntakeEntry(root, entry);
      summary.dupCount++;
      summary.byType[entry.classifiedType] = (summary.byType[entry.classifiedType] ?? 0) + 1;
      continue;
    }

    const sizeBytes = fs.statSync(filePath).size;
    const baseEntry = {
      hash,
      sourcePath: rel,
      batch,
      ext,
      sizeBytes,
      isDup: false,
      classifiedAt: new Date().toISOString(),
    };

    if (TEXT_EXTENSIONS.has(ext)) {
      writeIntakeEntry(root, {
        ...baseEntry,
        kind: 'text',
        classifiedType: 'text',
        status: 'done',
      });
      summary.processedCount++;
      summary.byType.text = (summary.byType.text ?? 0) + 1;
      continue;
    }

    if (IMAGE_EXTENSIONS.has(ext)) {
      try {
        const kind = await visionPool(() => classifyImage(filePath));
        const classifiedType: IntakeType = kind === 'text-doc' ? 'doc-photo' : 'exhibit-photo';
        writeIntakeEntry(root, {
          ...baseEntry,
          kind: 'image',
          classifiedType,
          status: 'done',
        });
        summary.processedCount++;
        summary.byType[classifiedType] = (summary.byType[classifiedType] ?? 0) + 1;
      } catch (err) {
        writeIntakeEntry(root, {
          ...baseEntry,
          kind: 'image',
          classifiedType: 'unsure',
          status: 'failed',
          error: (err as Error).message,
        });
        summary.failedCount++;
      }
      continue;
    }

    writeIntakeEntry(root, {
      ...baseEntry,
      kind: 'text',
      classifiedType: 'unsure',
      status: 'failed',
      error: 'unsupported extension',
    });
    summary.failedCount++;
  }

  return summary;
}
```

Register in `src/cli/index.ts` (add near the other `program.command(...)` blocks, before `program.parse();`):

```typescript
import { runTriageIntake } from './commands/triageIntake';
```

```typescript
program
  .command('triage-intake')
  .option('--dir <dir>', 'scope to one batch, e.g. intake/benson-ford')
  .action(async (opts) => {
    const summary = await runTriageIntake(root, opts);
    console.log(JSON.stringify(summary, null, 2));
  });
```

Add to `package.json` `scripts`:
```json
"triage:intake": "ts-node src/cli/index.ts triage-intake"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd c:\dev\trm && npx jest tests/cli/commands/triageIntake.test.ts`
Expected: All PASS

- [ ] **Step 5: Run the full trm suite**

Run: `cd c:\dev\trm && npm test`
Expected: All PASS, no regressions.

- [ ] **Step 6: Manual smoke test**

```bash
cd c:\dev\trm
mkdir -p intake/smoke-test
echo "hello" > intake/smoke-test/note.md
npm run triage:intake
cat intake-manifest.json
rm -rf intake/smoke-test intake-manifest.json
```
Expected: JSON summary prints `processedCount: 1`, `byType.text: 1`; `intake-manifest.json` contains one entry with `classifiedType: "text"`.

- [ ] **Step 7: Commit**

```bash
cd c:\dev\trm
git add src/cli/commands/triageIntake.ts src/cli/index.ts package.json tests/cli/commands/triageIntake.test.ts
git commit -m "feat(cli): add trm triage-intake command

Walks trm/intake/<batch>/**, hashes + dedups against intake-manifest.json,
routes text straight through, classifies images via classifyImage
(Task 3's real vision-label path), and writes a resumable manifest --
the pre-scan step for sorting a raw dump before any per-type ingest runs."
```

---

## Out of scope (unchanged from spec)

Per-type downstream ingest, live cloud/email pulling, physical file reorganization — not built here. Next design picks up from `intake-manifest.json` filtered by `classifiedType`/`!isDup`, grouped by `batch`.
