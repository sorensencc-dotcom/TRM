# Triage-Intake PDF/DOCX/EPUB Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classify `.pdf`, `.docx`, `.epub` in `trm triage-intake` as `text` (validated via real extraction) instead of auto-failing as "unsupported extension", without an OOM risk on large batches.

**Architecture:** Reuse the existing `convertFileToText` converter (already used by `trm ingest --file`) inside `triageIntake.ts`'s `processFile`, gated behind a new `docPool` concurrency limiter (same `p-limit` pattern as the existing `visionPool`/`claudePool`) to bound simultaneous in-memory parses.

**Tech Stack:** TypeScript, Jest, `p-limit`, `pdf-parse`, `mammoth` (all already in the repo).

## Global Constraints

- No manifest schema change (`IntakeEntry` in `src/core/intakeManifest.ts` stays as-is).
- Extracted text is validated, never persisted, at triage time.
- `.txt/.md/.json` path must remain untouched: no read, no extraction call, zero added cost.
- Default pool concurrency is 4, overridable via `TRM_DOC_CONCURRENCY`, matching `DEFAULT_CONCURRENCY` in `src/core/concurrency.ts`.
- Failure entries use `error instanceof Error ? error.message : String(error)` — never an unchecked `(err as Error).message` cast — because `pdf-parse`/`mammoth`/the epub extractor are not guaranteed to throw `Error` instances.
- Failure entries use `classifiedType: 'unsure'` (matching the existing image-classification failure convention a few lines above in the same file), not `classifiedType: 'text'`.

Spec: `docs/superpowers/specs/2026-08-05-triage-intake-pdf-docx-epub-design.md`

---

### Task 1: Add `docPool` to the concurrency module

**Files:**
- Modify: `src/core/concurrency.ts`
- Test: `tests/core/concurrency.test.ts`

**Interfaces:**
- Produces: `export const docPool: <T>(fn: () => Promise<T>) => Promise<T>` (a `p-limit` instance), configured via `TRM_DOC_CONCURRENCY`, default 4.

- [ ] **Step 1: Write the failing test**

Add to `tests/core/concurrency.test.ts`. First add `'TRM_DOC_CONCURRENCY'` to the `ENV_KEYS` array at the top:

```ts
const ENV_KEYS = ['TRM_VISION_CONCURRENCY', 'TRM_CLAUDE_CONCURRENCY', 'TRM_DOC_CONCURRENCY'];
```

Then add these two tests inside the existing `describe('concurrency', ...)` block, after the last test:

```ts
  it('docPool defaults to a concurrency of 4 when no env var is set', async () => {
    delete process.env.TRM_DOC_CONCURRENCY;
    const { docPool } = require('../../src/core/concurrency');

    const maxActive = await trackConcurrency(docPool, 10);
    expect(maxActive).toBe(4);
  });

  it('bounds concurrent execution to the configured TRM_DOC_CONCURRENCY limit', async () => {
    process.env.TRM_DOC_CONCURRENCY = '2';
    const { docPool } = require('../../src/core/concurrency');

    const maxActive = await trackConcurrency(docPool, 10);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBeGreaterThan(0);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/core/concurrency.test.ts -t docPool`
Expected: FAIL — `docPool` is not exported from `src/core/concurrency`.

- [ ] **Step 3: Implement `docPool`**

In `src/core/concurrency.ts`, add after the existing exports:

```ts
export const docPool = pLimit(configuredLimit('TRM_DOC_CONCURRENCY'));
```

Full resulting file:

```ts
import pLimit from 'p-limit';

const DEFAULT_CONCURRENCY = 4;

function configuredLimit(name: string): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_CONCURRENCY;
}

export const visionPool = pLimit(configuredLimit('TRM_VISION_CONCURRENCY'));
export const claudePool = pLimit(configuredLimit('TRM_CLAUDE_CONCURRENCY'));
export const docPool = pLimit(configuredLimit('TRM_DOC_CONCURRENCY'));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/core/concurrency.test.ts`
Expected: PASS, all tests including the two new ones.

- [ ] **Step 5: Commit**

```bash
git add src/core/concurrency.ts tests/core/concurrency.test.ts
git commit -m "feat(trm): add docPool concurrency limiter for document extraction"
```

---

### Task 2: Route PDF/DOCX/EPUB through `convertFileToText` in triage-intake

**Files:**
- Modify: `src/cli/commands/triageIntake.ts`
- Test: `tests/cli/commands/triageIntake.test.ts`

**Interfaces:**
- Consumes: `docPool` from `../../core/concurrency` (produced in Task 1); `convertFileToText(filePath: string): Promise<string>` from `../../ingestion/fileConvert` (already exists, unchanged).
- Produces: no new exports — behavioral change to `runTriageIntake`'s classification of `.pdf`/`.docx`/`.epub` files.

- [ ] **Step 1: Write the failing tests**

Add to `tests/cli/commands/triageIntake.test.ts`. First add this import near the top, alongside the existing `classifyModule` import:

```ts
import * as fileConvertModule from '../../../src/ingestion/fileConvert';
```

Then add these tests inside the existing `describe('runTriageIntake', ...)` block:

```ts
  it('classifies a valid PDF as classifiedType "text" via convertFileToText', async () => {
    const root = makeRoot();
    writeIntakeFile(root, 'docs', 'report.pdf', Buffer.from('%PDF-1.4 fake'));
    const convertSpy = jest
      .spyOn(fileConvertModule, 'convertFileToText')
      .mockResolvedValueOnce('extracted pdf text');

    const summary = await runTriageIntake(root, {});
    const manifest = readIntakeManifest(root);
    const entry = Object.values(manifest.entries)[0];

    expect(convertSpy).toHaveBeenCalledWith(expect.stringContaining('report.pdf'));
    expect(entry.classifiedType).toBe('text');
    expect(entry.status).toBe('done');
    expect(summary.processedCount).toBe(1);
    expect(summary.failedCount).toBe(0);
  });

  it('classifies a valid DOCX as classifiedType "text" via convertFileToText', async () => {
    const root = makeRoot();
    writeIntakeFile(root, 'docs', 'notes.docx', Buffer.from('fake docx bytes'));
    jest.spyOn(fileConvertModule, 'convertFileToText').mockResolvedValueOnce('extracted docx text');

    const summary = await runTriageIntake(root, {});
    const manifest = readIntakeManifest(root);
    const entry = Object.values(manifest.entries)[0];

    expect(entry.classifiedType).toBe('text');
    expect(entry.status).toBe('done');
    expect(summary.processedCount).toBe(1);
  });

  it('marks a corrupt PDF as failed with the parser error preserved', async () => {
    const root = makeRoot();
    writeIntakeFile(root, 'docs', 'corrupt.pdf', Buffer.from('not a real pdf'));
    jest
      .spyOn(fileConvertModule, 'convertFileToText')
      .mockRejectedValueOnce(new Error('bad XRef entry'));

    const summary = await runTriageIntake(root, {});
    const manifest = readIntakeManifest(root);
    const entry = Object.values(manifest.entries)[0];

    expect(entry.status).toBe('failed');
    expect(entry.classifiedType).toBe('unsure');
    expect(entry.error).toBe('bad XRef entry');
    expect(summary.failedCount).toBe(1);
    expect(summary.processedCount).toBe(0);
  });

  it('marks a scanned PDF with no extractable text as failed (validation failure)', async () => {
    const root = makeRoot();
    writeIntakeFile(root, 'docs', 'scanned.pdf', Buffer.from('scanned image pdf'));
    jest
      .spyOn(fileConvertModule, 'convertFileToText')
      .mockRejectedValueOnce(new Error('trm ingest --file: "scanned.pdf" produced no extractable text'));

    const summary = await runTriageIntake(root, {});
    const manifest = readIntakeManifest(root);
    const entry = Object.values(manifest.entries)[0];

    expect(entry.status).toBe('failed');
    expect(entry.error).toBe('trm ingest --file: "scanned.pdf" produced no extractable text');
    expect(summary.failedCount).toBe(1);
  });

  it('does not call convertFileToText for plain text files', async () => {
    const root = makeRoot();
    writeIntakeFile(root, 'docs', 'plain.txt', 'plain text contents');
    const convertSpy = jest.spyOn(fileConvertModule, 'convertFileToText');

    await runTriageIntake(root, {});

    expect(convertSpy).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/cli/commands/triageIntake.test.ts -t "PDF\|DOCX\|plain text files"`
Expected: FAIL — `.pdf`/`.docx` currently fall into the `unknown` branch (`classifiedType: 'unsure'`, `error: 'unsupported extension'`), not the `text` branch, so the "valid PDF"/"valid DOCX" assertions fail. `convertSpy` is never called for any test since the code path doesn't exist yet.

- [ ] **Step 3: Implement the extraction branch**

In `src/cli/commands/triageIntake.ts`:

1. Add the import (with the other imports at the top):

```ts
import { convertFileToText } from '../../ingestion/fileConvert';
```

2. Add a comment above `TEXT_EXTENSIONS` explaining the two-set split, and add the new set right after it:

```ts
// Zero-cost text classification: extension check only, no file read.
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.json']);
// Extraction-backed text classification: must run convertFileToText to
// confirm the document actually yields text before classifying it 'text'.
// Kept separate from TEXT_EXTENSIONS so a future edit can't accidentally
// route .txt/.md/.json through real extraction (adds unnecessary I/O cost).
const EXTRACTABLE_TEXT_EXTENSIONS = new Set(['.pdf', '.docx', '.epub']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic']);
```

3. In `processFile`, insert a new branch immediately before the existing `if (TEXT_EXTENSIONS.has(ext))` block:

```ts
    if (EXTRACTABLE_TEXT_EXTENSIONS.has(ext)) {
      try {
        await docPool(() => convertFileToText(filePath));
        manifest.write({
          ...baseEntry,
          kind: 'text',
          classifiedType: 'text',
          status: 'done',
        });
        checkpoint();
        summary.processedCount++;
        summary.byType.text = (summary.byType.text ?? 0) + 1;
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        manifest.write({
          ...baseEntry,
          kind: 'text',
          classifiedType: 'unsure',
          status: 'failed',
          error: errMessage,
        });
        checkpoint();
        summary.failedCount++;
      }
      return;
    }

```

4. Add the `docPool` import alongside the existing `visionPool` import:

```ts
import { visionPool, docPool } from '../../core/concurrency';
```

(Check the existing import line for `visionPool` — it currently reads `import { visionPool } from '../../core/concurrency';`; change it to import both.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/cli/commands/triageIntake.test.ts`
Expected: PASS, all tests including the 5 new ones and all pre-existing ones (no regression in the `.txt/.md/.json` or image paths).

- [ ] **Step 5: Run the full test suite**

Run: `npx jest`
Expected: PASS, no regressions anywhere else in the repo.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/triageIntake.ts tests/cli/commands/triageIntake.test.ts
git commit -m "feat(trm): classify PDF/DOCX/EPUB as text in triage-intake via convertFileToText"
```

---

## Post-plan verification

- [ ] Re-run the real intake batch to confirm the fix: `node dist/cli/index.js triage-intake --dir intake/dump` (after `npm run build` in `C:\dev\trm`) from `C:\Users\soren\trm-vault`, and confirm `failedCount` drops (PDF/DOCX no longer counted as `unsupported extension`; only genuinely-corrupt files and extensionless files remain failed).
