# TRM Raw-Source JSON Envelope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify `trm`'s raw source storage so both text and image sources are written as one structured JSON envelope at ingest time, fix the silent image-source skip bug in extraction, and migrate existing on-disk vaults to the new format.

**Architecture:** A new `RawSourceEnvelope` type plus `writeRawEnvelope`/`readRawEnvelope` helpers in `src/core/rawSource.ts` become the single read/write path for `sources/raw/{id}.json`. `ingest.ts` and `extract.ts` both go through these helpers instead of doing ad-hoc `fs.writeFileSync`/`fs.readFileSync` against `.txt`/`.json` directly. A standalone migration script converts legacy `.txt` files into the envelope shape.

**Tech Stack:** TypeScript, Jest (`ts-jest`), Node `fs`/`path`.

## Global Constraints

- No `.txt` raw files after this change — `ingest.ts` never writes `.txt`.
- Envelope shape is exactly `{ sourceId, kind, capturedAt, text?, image? }` — no additional fields, no segmentation/chunking (explicitly out of scope per approved design).
- `extract.ts` must never silently `continue` past an image-kind source — it must log an explicit skip reason.
- Migration script must be idempotent (safe to run twice) and must not touch files that already have a corresponding `.json`.
- Existing public behavior for text extraction (fact IDs, summary generation) is unchanged — only the on-disk raw storage format changes.

---

### Task 1: `RawSourceEnvelope` type + read/write helpers

**Files:**
- Create: `src/core/rawSource.ts`
- Test: `tests/core/rawSource.test.ts`

**Interfaces:**
- Produces:
  - `interface RawSourceEnvelope { sourceId: string; kind: 'text' | 'image'; capturedAt: string; text?: string; image?: RawImagePayload }`
  - `interface RawImagePayload { matches: { url: string; similarity: number; source: string }[]; metadata: { format: string; size: number; processedAt: string; visionApiUsed: boolean; error?: string; implementation?: string }; mock: boolean }`
  - `function rawSourcePath(root: string, topicPath: string, sourceId: string): string` — returns `sources/raw/{sourceId}.json` path (uses `nodeDir` from `../core/paths`).
  - `function writeRawEnvelope(root: string, topicPath: string, envelope: RawSourceEnvelope): void` — creates parent dir if needed, writes pretty-printed JSON.
  - `function readRawEnvelope(root: string, topicPath: string, sourceId: string): RawSourceEnvelope | null` — returns `null` if the file doesn't exist (never throws for a missing file).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/rawSource.test.ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { rawSourcePath, writeRawEnvelope, readRawEnvelope, RawSourceEnvelope } from '../../src/core/rawSource';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-'));
  fs.mkdirSync(path.join(root, 'topics', 'cuba'), { recursive: true });
  return root;
}

describe('rawSource', () => {
  it('rawSourcePath points at sources/raw/{id}.json under the topic dir', () => {
    const root = makeRoot();
    const p = rawSourcePath(root, 'cuba', 'SRC-001');
    expect(p).toBe(path.join(root, 'topics', 'cuba', 'sources', 'raw', 'SRC-001.json'));
  });

  it('writeRawEnvelope then readRawEnvelope round-trips a text envelope', () => {
    const root = makeRoot();
    const envelope: RawSourceEnvelope = {
      sourceId: 'SRC-001',
      kind: 'text',
      capturedAt: '2026-07-25T00:00:00.000Z',
      text: 'Fact one.\nFact two.',
    };
    writeRawEnvelope(root, 'cuba', envelope);
    const read = readRawEnvelope(root, 'cuba', 'SRC-001');
    expect(read).toEqual(envelope);
  });

  it('writeRawEnvelope then readRawEnvelope round-trips an image envelope', () => {
    const root = makeRoot();
    const envelope: RawSourceEnvelope = {
      sourceId: 'SRC-002',
      kind: 'image',
      capturedAt: '2026-07-25T00:00:00.000Z',
      image: {
        matches: [],
        metadata: { format: 'png', size: 8, processedAt: '2026-07-25T00:00:00.000Z', visionApiUsed: false },
        mock: true,
      },
    };
    writeRawEnvelope(root, 'cuba', envelope);
    const read = readRawEnvelope(root, 'cuba', 'SRC-002');
    expect(read).toEqual(envelope);
  });

  it('readRawEnvelope returns null when the source has no raw file', () => {
    const root = makeRoot();
    expect(readRawEnvelope(root, 'cuba', 'SRC-999')).toBeNull();
  });

  it('writeRawEnvelope creates sources/raw if it does not exist yet', () => {
    const root = makeRoot();
    writeRawEnvelope(root, 'cuba', { sourceId: 'SRC-001', kind: 'text', capturedAt: '2026-07-25T00:00:00.000Z', text: 'x' });
    expect(fs.existsSync(path.join(root, 'topics', 'cuba', 'sources', 'raw', 'SRC-001.json'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/core/rawSource.test.ts`
Expected: FAIL with `Cannot find module '../../src/core/rawSource'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/core/rawSource.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { nodeDir } from './paths';

export interface RawImagePayload {
  matches: { url: string; similarity: number; source: string }[];
  metadata: {
    format: string;
    size: number;
    processedAt: string;
    visionApiUsed: boolean;
    error?: string;
    implementation?: string;
  };
  mock: boolean;
}

export interface RawSourceEnvelope {
  sourceId: string;
  kind: 'text' | 'image';
  capturedAt: string;
  text?: string;
  image?: RawImagePayload;
}

export function rawSourcePath(root: string, topicPath: string, sourceId: string): string {
  return path.join(nodeDir(root, topicPath), 'sources', 'raw', `${sourceId}.json`);
}

export function writeRawEnvelope(root: string, topicPath: string, envelope: RawSourceEnvelope): void {
  const filePath = rawSourcePath(root, topicPath, envelope.sourceId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(envelope, null, 2));
}

export function readRawEnvelope(root: string, topicPath: string, sourceId: string): RawSourceEnvelope | null {
  const filePath = rawSourcePath(root, topicPath, sourceId);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/core/rawSource.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/rawSource.ts tests/core/rawSource.test.ts
git commit -m "feat: add RawSourceEnvelope type and read/write helpers"
```

---

### Task 2: `ingest.ts` writes the unified envelope

**Files:**
- Modify: `src/cli/commands/ingest.ts`
- Modify: `tests/cli/ingest.test.ts`

**Interfaces:**
- Consumes: `writeRawEnvelope`, `RawSourceEnvelope` from `../../core/rawSource` (Task 1).
- Produces: `runIngest` now writes `sources/raw/{id}.json` for both text and image sources; never writes `.txt`.

- [ ] **Step 1: Update the existing tests to expect the envelope shape (this is the failing-test step — these currently pass against the old `.txt`/bare-JSON shape and must be rewritten first)**

Replace the three raw-format-asserting tests in `tests/cli/ingest.test.ts` (the `.txt`-content test, the `.png` test, and the multi-extension test) with:

```typescript
  it('with --file and no url, writes a text envelope to sources/raw/SRC-001.json and derives a local: url', async () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    const filePath = path.join(root, 'doc.txt');
    fs.writeFileSync(filePath, 'Converted file content.', 'utf-8');

    const entry = await runIngest(root, 'cuba', { actor: 'ACTOR-001', type: 'pdf', title: 'Overview', origin: 'LOC', file: filePath });

    expect(entry?.url).toBe('local:doc.txt');
    const rawPath = path.join(root, 'topics', 'cuba', 'sources', 'raw', 'SRC-001.json');
    expect(fs.existsSync(rawPath)).toBe(true);
    const envelope = JSON.parse(fs.readFileSync(rawPath, 'utf-8'));
    expect(envelope.kind).toBe('text');
    expect(envelope.sourceId).toBe('SRC-001');
    expect(envelope.text).toBe('Converted file content.');
    expect(typeof envelope.capturedAt).toBe('string');
  });
```

```typescript
  it('with --file pointing at a .png, writes an image envelope and flags mock: true', async () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    const filePath = path.join(root, 'photo.png');
    fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const entry = await runIngest(root, 'cuba', { actor: 'ACTOR-001', type: 'image', title: 'Photo', origin: 'LOC', file: filePath });

    expect(entry?.url).toBe('local:photo.png');
    const jsonPath = path.join(root, 'topics', 'cuba', 'sources', 'raw', 'SRC-001.json');
    expect(fs.existsSync(jsonPath)).toBe(true);
    const envelope = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    expect(envelope.kind).toBe('image');
    expect(envelope.image.mock).toBe(true);
    expect(envelope.image.metadata.visionApiUsed).toBe(false);
    expect(Array.isArray(envelope.image.matches)).toBe(true);
  });
```

```typescript
  it('recognizes .jpg, .jpeg, .webp, .gif as image extensions too', async () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    for (const ext of ['jpg', 'jpeg', 'webp', 'gif']) {
      const filePath = path.join(root, `photo.${ext}`);
      fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const entry = await runIngest(root, 'cuba', { actor: 'ACTOR-001', type: 'image', title: 'Photo', origin: 'LOC', file: filePath });
      const jsonPath = path.join(root, 'topics', 'cuba', 'sources', 'raw', `${entry?.id}.json`);
      expect(fs.existsSync(jsonPath)).toBe(true);
      const envelope = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      expect(envelope.kind).toBe('image');
    }
  });
```

Also update the `'a corrupt/unrecognized image writes an error-flagged JSON, does not throw'` test's assertions from `written.mock`/`written.matches`/`written.metadata.error` to `written.image.mock`/`written.image.matches`/`written.image.metadata.error`, and `written.kind` to `'image'`.

- [ ] **Step 2: Run tests to verify they fail against current `ingest.ts`**

Run: `npx jest tests/cli/ingest.test.ts`
Expected: FAIL — assertions like `envelope.kind` are `undefined`, `envelope.text` is `undefined` (current code writes bare text/JSON, no envelope).

- [ ] **Step 3: Update `ingest.ts` to write the envelope**

```typescript
// C:\dev\trm\src\cli\commands\ingest.ts
import * as path from 'node:path';
import { SourceEntry } from '../../core/sourceIngest';
import { addSource } from '../../core/sourceIngest';
import { resolveActor } from '../../registry/actorRegistry';
import { convertFileToText } from '../../ingestion/fileConvert';
import { extractImage } from '../../ingestion/imageExtract';
import { writeRawEnvelope, RawSourceEnvelope } from '../../core/rawSource';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

export async function runIngest(
  root: string,
  topicPath: string,
  cliArgs: { actor?: string; type: string; title: string; origin: string; url?: string; file?: string; dryRun?: boolean }
): Promise<SourceEntry | null> {
  const actor = resolveActor(root, cliArgs.actor);
  if (cliArgs.dryRun) return null;

  const url = cliArgs.url || (cliArgs.file ? `local:${path.basename(cliArgs.file)}` : undefined);
  if (!url) {
    throw new Error('trm ingest: either <url> or --file must be provided');
  }

  const isImage = cliArgs.file ? IMAGE_EXTENSIONS.has(path.extname(cliArgs.file).toLowerCase()) : false;

  let text: string | undefined;
  let imageResult: Awaited<ReturnType<typeof extractImage>> | undefined;

  if (cliArgs.file && isImage) {
    imageResult = await extractImage(cliArgs.file);
  } else if (cliArgs.file) {
    text = await convertFileToText(cliArgs.file);
  }

  const entry = addSource(root, topicPath, actor, { type: cliArgs.type, title: cliArgs.title, origin: cliArgs.origin, url });

  if (imageResult !== undefined) {
    const envelope: RawSourceEnvelope = {
      sourceId: entry.id,
      kind: 'image',
      capturedAt: new Date().toISOString(),
      image: { ...imageResult, mock: !imageResult.metadata.visionApiUsed },
    };
    writeRawEnvelope(root, topicPath, envelope);
  } else if (text !== undefined) {
    const envelope: RawSourceEnvelope = {
      sourceId: entry.id,
      kind: 'text',
      capturedAt: new Date().toISOString(),
      text,
    };
    writeRawEnvelope(root, topicPath, envelope);
  }

  return entry;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/cli/ingest.test.ts`
Expected: PASS (all tests, including the untouched ones for dry-run/url/error paths)

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/ingest.ts tests/cli/ingest.test.ts
git commit -m "feat: ingest writes unified RawSourceEnvelope for text and image sources"
```

---

### Task 3: `extract.ts` reads the envelope, skips image sources explicitly

**Files:**
- Modify: `src/cli/commands/extract.ts`
- Modify: `tests/cli/extract.test.ts`
- Modify: `tests/cli/extractWiring.test.ts`

**Interfaces:**
- Consumes: `readRawEnvelope` from `../../core/rawSource` (Task 1).
- Produces: `runExtract` unchanged signature/return type (`{ facts: Fact[]; summary: string } | null`); image-kind sources produce a console-logged skip instead of an unlogged `continue`.

- [ ] **Step 1: Rewrite failing tests against the envelope shape**

Replace the raw-file setup in all three `extract.test.ts` tests — change:
```typescript
    const rawDir = path.join(root, 'topics', 'cuba', 'sources', 'raw');
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(path.join(rawDir, 'SRC-001.txt'), 'Fact one.\nFact two.\n');
```
to:
```typescript
    const rawDir = path.join(root, 'topics', 'cuba', 'sources', 'raw');
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(path.join(rawDir, 'SRC-001.json'), JSON.stringify({
      sourceId: 'SRC-001', kind: 'text', capturedAt: '2026-07-25T00:00:00.000Z', text: 'Fact one.\nFact two.\n',
    }));
```
(and the analogous `SRC-002.json` in the multi-source test, with matching `text` content). Then add a new test to the same `describe` block:

```typescript
  it('skips image-kind sources with a logged reason instead of silently dropping them', () => {
    const root = makeRoot();
    runCreate(root, 'cuba', { actor: 'ACTOR-001' });
    runIngest(root, 'cuba', { actor: 'ACTOR-001', type: 'image', title: 'photo', origin: 'x', url: 'x' });
    const rawDir = path.join(root, 'topics', 'cuba', 'sources', 'raw');
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(path.join(rawDir, 'SRC-001.json'), JSON.stringify({
      sourceId: 'SRC-001',
      kind: 'image',
      capturedAt: '2026-07-25T00:00:00.000Z',
      image: { matches: [], metadata: { format: 'png', size: 1, processedAt: '2026-07-25T00:00:00.000Z', visionApiUsed: false }, mock: true },
    }));

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = runExtract(root, 'cuba', { actor: 'ACTOR-001' }, stubRunner);
    warnSpy.mockRestore();

    expect(result?.facts).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('SRC-001'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no text content'));
  });
```

Also update `tests/cli/extractWiring.test.ts`'s `setUpSource` helper: change the `.txt` write to a `.json` envelope write in the same way.

- [ ] **Step 2: Run tests to verify they fail against current `extract.ts`**

Run: `npx jest tests/cli/extract.test.ts tests/cli/extractWiring.test.ts`
Expected: FAIL — existing tests now get 0 facts (current code looks for `.txt` which no longer exists), new skip test fails (`readFileSync` on missing `metadata.json`... actually fails because `runExtract` still reads `.txt`, so `SRC-001.json` for image case doesn't match the old `.txt`-only lookup and no warning is ever logged).

- [ ] **Step 3: Update `extract.ts`**

```typescript
// C:\dev\trm\src\cli\commands\extract.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { nodeDir } from '../../core/paths';
import { readTopicMeta } from '../../core/topicNode';
import { Fact } from '../../scoring/types';
import { ExtractionRunner } from '../../extraction/types';
import { stubRunner } from '../../extraction/stubRunner';
import { claudeCodeRunner } from '../../extraction/claudeCodeRunner';
import { resolveActor } from '../../registry/actorRegistry';
import { appendOperation } from '../../lineage/hasher';
import { readRawEnvelope } from '../../core/rawSource';

interface SourceMetadata {
  sources: { id: string }[];
}

export function runExtract(
  root: string,
  topicPath: string,
  cliArgs: { actor?: string; dryRun?: boolean; stub?: boolean },
  runnerOverride?: ExtractionRunner
): { facts: Fact[]; summary: string } | null {
  const runner = runnerOverride ?? (cliArgs.stub ? stubRunner : claudeCodeRunner);
  const actor = resolveActor(root, cliArgs.actor);
  readTopicMeta(root, topicPath); // throws if node doesn't exist
  const dir = nodeDir(root, topicPath);
  const metadataPath = path.join(dir, 'sources', 'metadata.json');
  const metadata: SourceMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));

  const collectedFacts: Fact[] = [];
  const summaries: string[] = [];
  for (const source of metadata.sources) {
    const envelope = readRawEnvelope(root, topicPath, source.id);
    if (!envelope) continue;
    if (envelope.kind === 'image') {
      console.warn(`[extract] skipping ${source.id}: no text content for fact extraction (kind=image)`);
      continue;
    }
    const sourceMeta = metadata.sources.find((s: any) => s.id === source.id);
    const { facts, summary } = runner.run(sourceMeta as any, envelope.text ?? '');
    collectedFacts.push(...facts);
    summaries.push(summary);
  }

  // Each runner numbers facts FCT-001.. independently per source (it has no
  // visibility into other sources in this pass), so ids collide once concatenated
  // across sources. Renumber globally, sequentially, in source order.
  const allFacts: Fact[] = collectedFacts.map((fact, i) => ({
    ...fact,
    id: `FCT-${String(i + 1).padStart(3, '0')}`,
  }));

  if (cliArgs.dryRun) return null;

  const extractsDir = path.join(dir, 'extracts');
  fs.mkdirSync(extractsDir, { recursive: true });
  fs.writeFileSync(path.join(extractsDir, 'extract.json'), JSON.stringify({ facts: allFacts }, null, 2));
  fs.writeFileSync(path.join(extractsDir, 'summary.md'), summaries.join('\n\n'));

  const now = new Date().toISOString();
  appendOperation(
    root,
    topicPath,
    { op: 'EXTRACT', actor, timestamp: now, fact_count: allFacts.length },
    { fact_count: allFacts.length }
  );

  return { facts: allFacts, summary: summaries.join('\n\n') };
}
```

Note: `sourceMeta` lookup was already redundant with `source` in the original code (both come from the same `metadata.sources` array via the same `.find`); left as-is to keep this diff minimal and focused on the raw-read change — not a scope-creep cleanup.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/cli/extract.test.ts tests/cli/extractWiring.test.ts`
Expected: PASS (all tests, including the new image-skip test)

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/extract.ts tests/cli/extract.test.ts tests/cli/extractWiring.test.ts
git commit -m "fix: extract reads unified envelope, explicitly skips image sources instead of silently dropping them"
```

---

### Task 4: Migration script for existing `.txt` raw sources

**Files:**
- Create: `scripts/migrate-raw-to-json.ts`
- Test: `tests/scripts/migrate-raw-to-json.test.ts`

**Interfaces:**
- Produces: `function migrateRawToJson(vaultRoot: string): { migrated: string[]; skipped: string[] }` — exported for testing; a `if (require.main === module)` block at the bottom wires it to `process.argv[2]` for CLI use (`ts-node scripts/migrate-raw-to-json.ts <vaultRoot>`).
- Consumes: `RawSourceEnvelope`, `writeRawEnvelope` from `../src/core/rawSource`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/scripts/migrate-raw-to-json.test.ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { migrateRawToJson } from '../../scripts/migrate-raw-to-json';

function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-vault-'));
  const rawDir = path.join(root, 'topics', 'cuba', 'sources', 'raw');
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(path.join(rawDir, 'SRC-001.txt'), 'Fact one.\nFact two.');
  return root;
}

describe('migrateRawToJson', () => {
  it('converts a .txt raw file into a text envelope .json and removes the .txt', () => {
    const root = makeVault();
    const result = migrateRawToJson(root);

    const jsonPath = path.join(root, 'topics', 'cuba', 'sources', 'raw', 'SRC-001.json');
    const txtPath = path.join(root, 'topics', 'cuba', 'sources', 'raw', 'SRC-001.txt');
    expect(fs.existsSync(jsonPath)).toBe(true);
    expect(fs.existsSync(txtPath)).toBe(false);

    const envelope = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    expect(envelope.sourceId).toBe('SRC-001');
    expect(envelope.kind).toBe('text');
    expect(envelope.text).toBe('Fact one.\nFact two.');
    expect(typeof envelope.capturedAt).toBe('string');

    expect(result.migrated).toEqual([jsonPath]);
    expect(result.skipped).toEqual([]);
  });

  it('is idempotent: running twice does not error and migrates nothing the second time', () => {
    const root = makeVault();
    migrateRawToJson(root);
    const second = migrateRawToJson(root);
    expect(second.migrated).toEqual([]);
  });

  it('skips a .txt file that already has a corresponding .json (does not overwrite)', () => {
    const root = makeVault();
    const rawDir = path.join(root, 'topics', 'cuba', 'sources', 'raw');
    fs.writeFileSync(path.join(rawDir, 'SRC-002.txt'), 'Other text.');
    fs.writeFileSync(path.join(rawDir, 'SRC-002.json'), JSON.stringify({ sourceId: 'SRC-002', kind: 'text', capturedAt: 'x', text: 'preexisting' }));

    const result = migrateRawToJson(root);

    const preserved = JSON.parse(fs.readFileSync(path.join(rawDir, 'SRC-002.json'), 'utf-8'));
    expect(preserved.text).toBe('preexisting');
    expect(result.skipped).toContain(path.join(rawDir, 'SRC-002.txt'));
  });

  it('finds raw dirs at any topic depth', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-vault-'));
    const rawDir = path.join(root, 'topics', 'charlie', 'cuba', 'havana', 'sources', 'raw');
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(path.join(rawDir, 'SRC-001.txt'), 'Deep text.');

    const result = migrateRawToJson(root);

    expect(result.migrated).toHaveLength(1);
    expect(fs.existsSync(path.join(rawDir, 'SRC-001.json'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/scripts/migrate-raw-to-json.test.ts`
Expected: FAIL with `Cannot find module '../../scripts/migrate-raw-to-json'`

- [ ] **Step 3: Write the migration script**

```typescript
// scripts/migrate-raw-to-json.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RawSourceEnvelope } from '../src/core/rawSource';

function findRawDirs(topicsRoot: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(topicsRoot)) return results;

  function walk(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name === 'raw' && path.basename(dir) === 'sources') {
        results.push(full);
      } else {
        walk(full);
      }
    }
  }
  walk(topicsRoot);
  return results;
}

export function migrateRawToJson(vaultRoot: string): { migrated: string[]; skipped: string[] } {
  const migrated: string[] = [];
  const skipped: string[] = [];
  const topicsRoot = path.join(vaultRoot, 'topics');

  for (const rawDir of findRawDirs(topicsRoot)) {
    const files = fs.readdirSync(rawDir).filter((f) => f.endsWith('.txt'));
    for (const file of files) {
      const sourceId = path.basename(file, '.txt');
      const txtPath = path.join(rawDir, file);
      const jsonPath = path.join(rawDir, `${sourceId}.json`);

      if (fs.existsSync(jsonPath)) {
        skipped.push(txtPath);
        continue;
      }

      const text = fs.readFileSync(txtPath, 'utf-8');
      const stat = fs.statSync(txtPath);
      const envelope: RawSourceEnvelope = {
        sourceId,
        kind: 'text',
        capturedAt: stat.mtime.toISOString(),
        text,
      };
      fs.writeFileSync(jsonPath, JSON.stringify(envelope, null, 2));
      fs.unlinkSync(txtPath);
      migrated.push(jsonPath);
    }
  }

  return { migrated, skipped };
}

if (require.main === module) {
  const vaultRoot = process.argv[2];
  if (!vaultRoot) {
    console.error('usage: ts-node scripts/migrate-raw-to-json.ts <vaultRoot>');
    process.exit(1);
  }
  const result = migrateRawToJson(vaultRoot);
  console.log(`migrated ${result.migrated.length} file(s), skipped ${result.skipped.length} (already had .json)`);
  result.migrated.forEach((f) => console.log(`  + ${f}`));
  result.skipped.forEach((f) => console.log(`  ~ ${f} (already migrated)`));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/scripts/migrate-raw-to-json.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/migrate-raw-to-json.ts tests/scripts/migrate-raw-to-json.test.ts
git commit -m "feat: add idempotent migration script for legacy .txt raw sources"
```

---

### Task 5: Full suite check + real-vault migration (manual, confirm-gated)

**Files:** none (verification + a manual data operation, not a code change)

- [ ] **Step 1: Run the full test suite**

Run: `npx jest`
Expected: PASS, no regressions in `tests/cli/*`, `tests/core/*`, `tests/scripts/*`.

- [ ] **Step 2: Dry-check the two real vaults before touching them**

```bash
find "/c/Users/soren/trm-vault" -path "*/sources/raw/*.txt"
find "/c/tmp/trm-cic-live" -path "*/sources/raw/*.txt"
```
Expected: 13 files under `trm-vault`, 1 file under `trm-cic-live` (confirmed during brainstorming).

- [ ] **Step 3: Confirm with the user before running migration against real data**

This mutates the user's actual research vaults (deletes `.txt` files after writing `.json` — reversible only via git if the vault happens to be a git repo, per TRM's design it usually isn't remote-tracked). Ask explicitly before running:

```bash
npx ts-node scripts/migrate-raw-to-json.ts "C:\Users\soren\trm-vault"
npx ts-node scripts/migrate-raw-to-json.ts "C:\tmp\trm-cic-live"
```

- [ ] **Step 4: Verify migration output**

```bash
find "/c/Users/soren/trm-vault" -path "*/sources/raw/*.txt"
find "/c/tmp/trm-cic-live" -path "*/sources/raw/*.txt"
```
Expected: no `.txt` files remain in either vault; corresponding `.json` files exist alongside existing metadata.
