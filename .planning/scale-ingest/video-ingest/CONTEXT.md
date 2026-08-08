# CONTEXT — scale-ingest / video-ingest

**Locked:** 2026-08-07

## Gray areas resolved

1. **Audio content mix.** Archive has both silent 8mm/16mm reels and footage with
   audio (interviews, narrated docs). No single strategy covers both — pipeline
   must branch per-file on detected audio track, not assume one mode.
   → Both frame-sampling and transcript extraction are required capabilities,
   selected automatically per file (ffprobe audio-stream check), not by manual
   flag.

2. **Storage shape.** New `kind: 'video'` on `RawSourceEnvelope`, sibling to
   existing `'image'` and `'text'` kinds — not folded into either. Keeps
   image/text envelope shapes unchanged; video envelope carries optional
   `transcript` (Whisper output) and optional `frames` (sampled-frame refs +
   any per-frame vision analysis), populated based on what the source file
   actually has.

## Build vs. buy (GitHub research)

Searched for an existing open-source video-ingestion repo to adopt wholesale
instead of building the TRM branch. Findings:

- **OpenMontage**, **Coactive**, **Intel Edge Platform video-search-and-summarization**
  — full agentic/production video-analytics platforms (scene detection, CLIP/
  SigLIP embeddings, object detection, cloud-scale search). Overkill for a
  personal-archive fact-extraction pipeline; would mean adopting a platform,
  not a library, and doesn't fit TRM's existing local-first, self-hosted,
  no-cloud-video-processing posture.
- **Whisper / faster-whisper / whisper.cpp** — MIT-licensed, self-hosted,
  no GPU required (whisper.cpp), well-benchmarked for 2026. This is the
  actual reusable component: transcription, not a full pipeline.
- **ffmpeg** — standard frame-extraction tool, already the de facto choice;
  not a "repo" decision, just a dependency.

**Decision:** no existing repo replaces the TRM-specific glue (classify →
extract → fact pipeline → manifest/dedup/envelope storage) — that logic is
tightly coupled to TRM's own `ingestDir.ts` / `manifestStore` / extraction
runner architecture and isn't something an external project provides. Build
the branch in TRM using **ffmpeg** (frame sampling, via child_process or a
thin wrapper) and **whisper.cpp** (self-hosted transcription, no cloud audio
upload) as library dependencies — same shape as the existing `mammoth`/
`pdf-parse`/Vision-API dependencies already in `fileConvert.ts` and
`ingestDir.ts`. Do not adopt a third-party ingestion framework.

## Sources consulted
- https://sipsip.ai/blog/open-source-video-transcriber
- https://docs.openedgeplatform.intel.com/2025.2/edge-ai-libraries/video-search-and-summarization/overview-architecture-summary.html
- https://tosea.ai/blog/openmontage-agentic-video-production-guide
- https://github.com/mazsola2k/ai-video-editor
