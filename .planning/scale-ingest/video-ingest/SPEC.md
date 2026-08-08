# SPEC — scale-ingest / video-ingest

**Locked:** 2026-08-07 (rev 2)  **Status:** Blocked pending final read — see CONTEXT.md rev 2

## Goal

`trm ingest-dir` accepts video files (home movies, interviews, narrated
footage) alongside images and text docs, extracting facts from a single
composed transcript+frame-label text input per video.

## Acceptance Criteria

1. `ingestDir.ts` classifies files by extension into three branches: image,
   text-doc, video. Video files never fall through to `convertFileToText`
   and never error as "unsupported extension".
2. Before any video file is processed, a preflight check verifies `ffmpeg`,
   `ffprobe`, and the configured whisper.cpp binary + model file are present
   and runnable. Missing dependency aborts the whole batch with one
   actionable error — it does not surface as N per-file failures.
3. Frame sampling always runs for every video file: 1 frame/10s, capped at
   30 frames (evenly sampled across full duration for longer videos),
   downscaled to 1024px max long edge before Vision analysis.
4. Transcript extraction (whisper.cpp, stream index 0) runs only when
   ffprobe reports an audio stream present on the file.
5. Transcript text (if any) and per-frame Vision `labels` (if any, rendered
   as `[frame @ mm:ss] labels: ...` lines) are concatenated into a single
   text blob, stored in `envelope.text`, and passed to exactly one
   `runner.run(source, composedText)` call. No dual-runner-call fact merge.
6. `RawSourceEnvelope.kind` gains `'video'`. `extract.ts:36`'s
   `kind === 'image'` skip branch is confirmed (by explicit test) to NOT
   catch `'video'` — video envelopes fall through to the existing
   text-extraction branch using `envelope.text`. `envelope.frames` (new,
   optional) stores per-frame provenance metadata only, not a second
   extraction input.
7. ffprobe edge cases handled without crashing the batch: malformed/corrupt
   media and ffprobe timeout (10s) route through the existing
   `failedStore`/`manifestStore.markFailed` path; video-only and
   audio-only-in-video-container files are not errors, just partial
   contributions (empty transcript or near-empty labels).
8. Dedup (`manifestStore.isDone`/`markDone`), failure tracking, and
   `regenerateExtractJson` all work unmodified for video sources.
9. No cloud video/audio upload — frame extraction and transcription run
   locally via ffmpeg/whisper.cpp; only frame *analysis* (Vision API labels)
   is a network call, same as the existing photo path.
10. ffmpeg and whisper.cpp workloads run under dedicated bounded pools
    (`TRM_FFMPEG_CONCURRENCY` default 2, `TRM_WHISPER_CONCURRENCY` default
    1), independent of `ioLimit`/`claudePool`/`visionPool`.

## In Scope

- New `VIDEO_EXTENSIONS` set and file-kind classification branch in
  `ingestDir.ts`.
- ffmpeg-based frame sampling at locked defaults (see Domain Notes).
- whisper.cpp-based local transcription (stream index 0 only).
- ffprobe-based audio-stream detection with defined failure handling.
- `RawSourceEnvelope` `kind: 'video'` + optional `frames` provenance field.
- Preflight dependency check (binary/model existence) before batch start.
- Explicit test in `extract.test.ts` covering the `kind: 'video'`
  fallthrough behavior in `extract.ts`.
- Dedicated ffmpeg/whisper concurrency pools.

## Out of Scope (Deferred)

- Scene detection / shot-boundary detection.
- Vision-language embeddings (CLIP/SigLIP) for video search.
- Cloud transcription fallback.
- Reverse-image search on sampled video frames.
- Multiple audio stream support (stream index 0 only in v1).
- CLI-configurable frame interval / cap / resolution (defaults are fixed
  constants in v1).
- Strict binary version pinning for ffmpeg/whisper.cpp (existence + runs
  successfully is sufficient).

## Dependencies

- **Inputs:** existing `ingestDir.ts` pipeline (manifest, dedup, extraction
  runner, envelope writer); `ImageAnalyzer.extract()`'s existing `labels`
  field (already returned, currently unused by the photo branch).
- **Outputs:** video facts flow into the same `extract.json` via the
  unmodified `extract.ts` fallthrough branch — no schema change needed
  beyond the new envelope kind and optional `frames` field.
- **External:** ffmpeg + ffprobe (subprocess, frame extraction, stream
  detection), whisper.cpp (self-hosted transcription binary/model). Both
  permissive-licensed. Config via `TRM_FFMPEG_PATH`, `TRM_FFPROBE_PATH`,
  `TRM_WHISPER_BIN`, `TRM_WHISPER_MODEL` env vars, PATH-lookup default.

## Domain Notes

**Fact-merge model:** one composed text input, one `runner.run()` call —
not two parallel extraction paths merged after the fact. This is the single
biggest simplification from rev 1 and removes an entire class of
fact-ID-collision/dedup problems.

**Frame sampling always runs**, regardless of audio-stream presence — this
replaces the rev-1 "meaningful frame content" heuristic (undefined,
unimplementable) with a pure stream-presence rule that's actually testable.

**Runtime dependency posture:** ffmpeg/whisper.cpp are native binaries, not
npm packages — treated as an infrastructure precondition (preflight check,
fail-fast on the whole batch) rather than a per-file try/catch concern.

Build-vs-buy question (adopt an existing video-ingestion repo wholesale)
resolved: no. See CONTEXT.md — OpenMontage/Coactive/Intel Edge Platform are
full platforms, wrong shape for a local-first personal archive. Only
reusable pieces are ffmpeg and whisper.cpp, same dependency shape as
existing mammoth/pdf-parse/Vision-API deps.

## Canonical References

- CONTEXT.md (this slice's decisions, rev 2 resolves 2026-08-07 review)
- `src/cli/commands/ingestDir.ts` (existing photo/text-doc branches to extend)
- `src/cli/commands/extract.ts:36` (kind==='image' skip branch — audited, video falls through safely)
- `src/ingestion/imageExtract/imageAnalyzer.ts:21` (existing `labels` field, reused for frame descriptions)
- `src/core/rawSource.ts` (RawSourceEnvelope definition to extend)
