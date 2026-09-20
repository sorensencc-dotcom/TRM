# Internet Archive archival-admission spec

**Status:** Approved for plan phase
**Parent:** `scale-ingest/video-ingest`

## Goal

TRM accepts Internet Archive media only after catalog-level verification,
quarantines unresolved identifiers, preserves archival provenance, and delegates
verified media to the existing `ingest-dir` / video-ingest pipeline.

This spec governs admission only. It does not add media extraction,
transcription, fact extraction, NotebookLM synchronization, or automatic frame
claim verification.

## Identity model

```text
Internet Archive identifier → downloaded media content hash → TRM SourceEntry.id
```

These identities remain distinct. Existing TRM content-hash deduplication stays
authoritative for downloaded bytes.

## Admission flow

```text
identifier
  → local archival manifest
  → exact IA metadata validation
  ├─ unknown/quarantined/mismatch → quarantine; no download or TRM source
  └─ verified → staged download + hash → existing ingest-dir/video pipeline
```

Quarantine belongs in the archival manifest. `failed.json` remains reserved for
retryable media-processing failures and must not retry quarantined identifiers.

## Acceptance criteria

1. Manifest records source system, archive identifier, canonical URL, catalog
   fields, verification status, and quarantine reason.
2. Only `verified` records can download media.
3. IA metadata must match the requested identifier exactly. Validation failure
   creates no `SourceEntry`, raw envelope, completion manifest entry, or media
   download.
4. Verified media is staged deterministically and hashed before delegation.
5. The adapter delegates to existing ingestion and does not duplicate probing,
   frame extraction, transcription, extraction, deduplication, or failure
   persistence.
6. Archival provenance is additive:

   ```ts
   interface ArchivalProvenance {
     sourceSystem: 'internet_archive';
     archiveIdentifier: string;
     canonicalUrl: string;
     verificationStatus: 'verified';
     metadataFetchedAt: string;
     metadataSha256: string;
     mediaSha256?: string;
     claimStatus: 'catalog_only' | 'frame_verified';
   }
   ```

7. Catalog verification does not verify personnel, visual coverage, transfer
   details, licensing, or editorial timecodes.
8. Automated frame `timestampMs` values remain extraction provenance and cannot
   populate editorial `timecode_in` / `timecode_out` fields.
9. Download failures use retryable download-failure handling. Admission failures
   remain quarantined.
10. Archive downloads use a bounded concurrency limit independent of media
    extraction pools.

## Initial manifest

- `74182StoryOfWillowRun` — verified, catalog-only claims;
- `Conquerb1943` — verified, catalog-only claims;
- `xd-31051-ford-motor-company-1920s-1930s-footage-mos-vwr` — quarantined;
- `fc-fc-439a-c` — quarantined;
- `08144_Master_Hands` — quarantined.

## Required tests

- verified record accepted;
- unknown and quarantined records perform zero downloads;
- metadata identifier mismatch is quarantined;
- download failure creates no completed TRM source;
- staged media hash is recorded;
- archival provenance survives source/raw-envelope round trip;
- verified media reaches the existing video-ingest path;
- quarantine never enters `--retry-failed`.

## Out of scope

- second media pipeline, manifest, deduplication, or failed-store system;
- automatic personnel identification or editorial claims;
- inferred timecodes;
- NotebookLM registry/mining changes;
- licensing or production approval.

## Canonical references

- `.planning/scale-ingest/video-ingest/SPEC.md`
- `.planning/scale-ingest/video-ingest/PLAN.md`
- `src/core/sourceIngest.ts`
- `src/core/rawSource.ts`
- `src/core/manifestStore.ts`
- `src/core/failedStore.ts`
- `src/cli/commands/ingestDir.ts`
