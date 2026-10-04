# TRM Raw-Source JSON Envelope — Design

## Problem

`ingest.ts` writes text sources as plain `sources/raw/{id}.txt` and image sources as
`sources/raw/{id}.json`. `extract.ts` only ever looks for `${id}.txt`
(`fs.existsSync(rawFile)` gated on the `.txt` path), so image-ingested sources are
silently skipped during extraction — no error, no log, facts just never appear.

Separately: raw source data should become structured JSON at ingest time (not left as
loose `.txt`), so downstream stages consume one consistent shape regardless of source
type.

## Design

### 1. Unified raw-source envelope

All raw sources, text or image, are written as `sources/raw/{id}.json`:

```ts
interface RawSourceEnvelope {
  sourceId: string;
  kind: 'text' | 'image';
  capturedAt: string;        // ISO timestamp, set at ingest
  text?: string;             // present when kind === 'text'
  image?: ExtractionResult;  // present when kind === 'image', existing shape unchanged
}
```

`ingest.ts` no longer writes `.txt` directly. `convertFileToText` output and
`extractImage` output both get wrapped in this envelope before being written.

### 2. `extract.ts` reads the envelope

Reads `sources/raw/{id}.json`. Branches on `kind`:
- `'text'` → runs the extraction runner on `envelope.text`, same behavior as today.
- `'image'` → explicitly skipped, with a logged reason (`no text content for fact
  extraction`) rather than a silent `continue`. No image-fact-extraction is built —
  out of scope; this only makes the existing skip visible instead of accidental.

### 3. Migration

A one-time script converts existing `sources/raw/*.txt` files to the envelope shape
(`kind: 'text'`, `capturedAt` backfilled from file mtime) and deletes the `.txt`.
Confirmed scope: 13 files under `C:\Users\soren\trm-vault`, 1 file under
`C:\tmp\trm-cic-live` — 14 total. Script takes a root dir arg so it can run against
either vault, and is idempotent (skips ids that already have a `.json`).

## Testing

- `extract.test.ts`: text-kind envelope produces facts (existing behavior preserved).
- `extract.test.ts`: image-kind envelope is skipped with a logged reason, not silently
  dropped — proves the bug is fixed.
- `ingest.test.ts`: text ingest writes `.json` envelope, not `.txt`.
- Migration script test: fixture dir with mixed `.txt` files converts correctly and is
  idempotent on a second run.

## Out of scope

- Building fact-extraction over image analysis results.
- Segmented/chunked excerpts at ingest (plain envelope only, per approved design).
- Any change to `cic-ingestion`'s Vision API service that `imageExtract` calls.
