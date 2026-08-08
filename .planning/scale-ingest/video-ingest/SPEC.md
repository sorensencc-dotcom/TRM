# SPEC — scale-ingest / video-ingest

**Locked:** 2026-08-07  **Status:** Ready for plan-phase

## Goal

`trm ingest-dir` accepts video files (home movies, interviews, narrated
footage) alongside images and text docs, extracting facts from transcript
and/or sampled frames depending on what each file actually contains.

## Acceptance Criteria

1. `ingestDir.ts` classifies files by extension into three branches: image,
   text-doc, video (currently two). Video files never fall through to
   `convertFileToText` and never error as "unsupported extension".
2. For a video file with a detected audio stream, the pipeline runs
   self-hosted transcription (whisper.cpp) and feeds the transcript text into
   the existing `runner.run(source, text)` extraction path, same as text-docs
   today.
3. For a video file with no audio stream, the pipeline samples frames via
   ffmpeg at a fixed interval and runs each sampled frame through the
   existing `ImageAnalyzer`/vision path, same as photo classification today.
4. For a video file with both audio and meaningful frame content, both paths
   run and both contribute facts to the same source entry.
5. `RawSourceEnvelope` gains `kind: 'video'` with optional `transcript` and
   optional `frames` fields; existing `'image'` and `'text'` envelope shapes
   are unchanged (no breaking change to existing consumers).
6. Dedup (`manifestStore.isDone`/`markDone`), failure tracking
   (`failedStore`), and `regenerateExtractJson` all work unmodified for video
   sources — new branch reuses existing manifest/store machinery, doesn't
   fork it.
7. No cloud video/audio upload — transcription and frame sampling run
   locally (whisper.cpp + ffmpeg), consistent with existing local-first OCR/
   Vision posture.

## In Scope

- New `VIDEO_EXTENSIONS` set and file-kind classification branch in
  `ingestDir.ts`.
- ffmpeg-based frame sampling (interval TBD in plan-phase).
- whisper.cpp-based local transcription.
- `RawSourceEnvelope` video-kind schema.
- Per-file audio-stream detection (ffprobe) to select transcript vs.
  frame-sampling vs. both.

## Out of Scope (Deferred)

- Scene detection / shot-boundary detection.
- Vision-language embeddings (CLIP/SigLIP) for video search.
- Cloud transcription fallback.
- Reverse-image search on sampled video frames (photo path's reverse-search
  behavior is not assumed to carry over — revisit if a real need surfaces).
- Batch/scale performance tuning for video (concurrency limits, GPU use) —
  follow the same `ioLimit`/pool pattern as existing code, but sizing is a
  plan-phase/execute-phase concern, not spec.

## Dependencies

- **Inputs:** existing `ingestDir.ts` pipeline (manifest, dedup, extraction
  runner, envelope writer); `ImageAnalyzer`/vision path for frame analysis.
- **Outputs:** video facts flow into the same `extract.json` /
  `regenerateExtractJson` consumers as image/text facts — no downstream
  schema change needed beyond the new envelope kind.
- **External:** ffmpeg (frame extraction, subprocess), whisper.cpp
  (self-hosted transcription binary/bindings). Both MIT/permissive-licensed,
  no cloud dependency added.

## Domain Notes

Build-vs-buy question (video ingestion pipeline as a whole) resolved: no.
See CONTEXT.md — evaluated OpenMontage, Coactive, Intel Edge Platform video-
search-and-summarization; all are full platforms, not libraries, and don't
fit TRM's local-first personal-archive architecture. Only reusable pieces
are ffmpeg (frame extraction) and whisper.cpp (transcription), both already
the same shape as existing deps (mammoth, pdf-parse, Vision API client).

## Canonical References

- CONTEXT.md (this slice's decisions + GitHub research)
- `src/cli/commands/ingestDir.ts` (existing photo/text-doc branches to extend)
- `src/ingestion/fileConvert.ts` (existing text-extraction pattern)
- `src/core/rawSource.ts` (RawSourceEnvelope definition to extend)
