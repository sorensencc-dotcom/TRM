# CONTEXT — scale-ingest / video-ingest

**Locked:** 2026-08-07 (rev 2 — resolves 2026-08-07 review blockers)

## Gray areas resolved (rev 1)

1. **Audio content mix.** Archive has both silent reels and footage with
   audio. Pipeline branches per-file on ffprobe-detected audio-stream
   presence.
2. **Storage shape.** New `kind: 'video'` on `RawSourceEnvelope`, sibling to
   `'image'`/`'text'`.

## Review blockers (2026-08-07) — resolved

### 1. Fact-merge model
No dual-runner-call merge. **Single composed text input, single
`runner.run()` call**, same shape as the existing text-doc path:

- If audio stream present: whisper.cpp transcript text.
- Frame sampling always runs (see #6) — each sampled frame's Vision `labels`
  field (already returned by `ImageAnalyzer.extract()`, currently discarded
  by the photo branch — see `imageAnalyzer.ts:21`) is rendered as
  `[frame @ 00:12] labels: person, outdoor, beach` lines.
- Transcript text + frame-label lines are concatenated into one string,
  stored in `envelope.text` (reusing the existing field — no new envelope
  field needed for the extraction input itself).
- One `runner.run(source, composedText)` call produces one fact array — no
  cross-call ID-collision handling needed, because there's only one call.
- `envelope.frames` (new, optional) stores the raw per-frame metadata
  (timestamp, sampled frame path, labels) for provenance/debugging — it is
  NOT a second extraction input.

### 2. RawSourceEnvelope kind expansion — consumer audit
Grepped all `envelope.kind` / `kind: '...'` usages in `src/`:

- **`extract.ts:36`** — `if (envelope.kind === 'image') { skip; continue }`
  else falls through to `runner.run(source, envelope.text ?? '')`. Since
  video's extraction input is stored in `envelope.text` (see #1), `kind:
  'video'` falls through to the existing default branch **unmodified** and
  extracts correctly. Acceptance criterion: add an explicit test in
  `extract.test.ts` asserting a `kind: 'video'` envelope is NOT skipped and
  its `text` is passed to the runner — do not rely on the fallthrough being
  silently correct forever.
- **`ingest.ts`, `triageIntake.ts`** — only ever construct `'text'`/`'image'`
  envelopes; no video path added there. Out of scope for this phase.
- **`ingestDir.ts`** — gets the new video branch (in scope).
- No other exhaustive `switch`/`if-chain` on `envelope.kind` found in `src/`.
  Plan-phase re-runs this grep at implementation time in case new consumers
  land between now and then.

### 3. ffmpeg / whisper.cpp runtime dependency contract
Not treated as ordinary npm deps (they're native binaries):

- **Preflight, not per-file failure.** Before `ingest-dir` processes any
  video file, run a one-time check: `ffmpeg -version`, `ffprobe -version`.
  Any missing → abort the whole batch with one actionable error naming the
  missing binary and the env var to configure it. Do not let missing
  binaries surface as N per-file failures in `failedStore`.
- **Whisper preflight is lazy, not global.** whisper.cpp binary + model
  existence is checked only when the *first* file in the batch reports an
  audio stream (via ffprobe), not at batch start. A video-only batch (all
  silent reels) never touches whisper and never pays its startup cost. Once
  triggered, the check result is cached for the rest of the batch run — it
  does not re-check per file.
- **Config surface** (mirrors existing `CIC_INGESTION_URL` pattern):
  `TRM_FFMPEG_PATH`, `TRM_FFPROBE_PATH`, `TRM_WHISPER_BIN`,
  `TRM_WHISPER_MODEL` — default to PATH lookup if unset.
- **Subprocess contract** for every ffmpeg/ffprobe/whisper invocation:
  explicit timeout (see #5 for ffprobe; ffmpeg/whisper timeouts sized in
  plan-phase relative to file duration), stderr captured and included in
  thrown error text, temp output files written under a per-run temp
  subdirectory and removed in a `finally` block regardless of success or
  failure.
- **No version pinning.** Binary-exists + runs successfully is sufficient;
  strict version compatibility checks are out of scope for v1.

### 4. Frame sampling defaults (locked)
- Interval: 1 frame per 10 seconds of source duration.
- Max frames per file: 30, sampled evenly across full duration (long videos
  are subsampled, not truncated to the first N frames).
- Output frame resolution: downscaled to 1024px max long edge before
  sending to Vision API (matches existing photo-analysis payload sizing).
- Files longer than 60 minutes: processed normally, but log a warning
  (cost/duration signal for later tuning) — no silent truncation of the
  audio transcript.
- These are v1 defaults; a CLI override flag is deferred, not in scope.

### 5. ffprobe failure / edge-case behavior
- Missing `ffprobe` binary: covered by preflight (#3) — batch aborts before
  any file is touched.
- Malformed/corrupt media (ffprobe non-zero exit or unparseable output):
  file routed through the existing `failedStore`/`manifestStore.markFailed`
  path, same as an OCR or Vision failure today — not a crash, not silently
  skipped.
- ffprobe timeout: 10s, treated identically to malformed media (failedStore
  path).
- Video-only file (no audio stream): frame-sampling path only, no
  transcript contribution (empty, not an error).
- Audio-only content in a file with a video extension: frame-sampling still
  runs and naturally yields near-empty/low-signal `labels`; that's not
  treated as an error, just low-signal output — same tolerance the current
  photo path already has for uninformative images.
- Multiple audio streams: transcribe stream index 0 only in v1; additional
  streams ignored (no error).

### 6. "Audio vs. meaningful frame content" — resolved
Not a content heuristic. Simplified to a pure stream-presence rule:
**frame sampling always runs for every video file** (bounded by the caps in
#4), removing the ambiguous "meaningful frame content" detection entirely.
Transcript path runs only when ffprobe reports an audio stream. So: frame
path is unconditional; transcript path is conditional on stream presence.
Both can contribute to the same composed text (#1); an audio-only or
frame-only outcome is not an error condition.

### 7. Concurrency — separate bounded pools
Local ffmpeg/whisper workloads are CPU/RAM-bound independently of the
existing network-bound `ioLimit`/`claudePool`/`visionPool`. New pools,
env-var overridable (mirrors `TRM_IO_CONCURRENCY`):

- `TRM_FFMPEG_CONCURRENCY` (default 2) — frame extraction.
- `TRM_WHISPER_CONCURRENCY` (default 1) — transcription, the heaviest
  single workload; serialized by default.
- Frame *analysis* (Vision API calls on sampled frames) reuses the existing
  `visionPool` — it's network-bound like the current photo path, not a new
  local-resource pool.

## Review blockers (2026-08-07, rev 3) — performance

### 8. Concurrent transcript + frame extraction per video
Transcript extraction and frame sampling are independent CPU workflows for a
given video — run them concurrently (`Promise.all`) per file, then compose
the text once both resolve. Do not serialize frame-sampling after transcript
(or vice versa) within a single file's processing.

### 9. One ffmpeg process per video, not one per frame
Frame extraction is a single ffmpeg invocation per video producing the
entire bounded frame set, not N spawned processes (one per timestamp).
ffprobe-derived duration selects the extraction strategy:
- Duration < 5 min: `fps=1/10` filter (matches the 1-frame/10s default,
  naturally caps under the 30-frame limit for anything ≤ 5 min).
- Duration ≥ 5 min: explicit evenly-spaced timestamp/`select` filter,
  capped at 30 frames total (not 1/10s, which would exceed the cap).
- Duration < 10s (short-clip fast path): single representative frame
  (midpoint), not multiple near-duplicate samples.

### 10. Bounded per-video frame-analysis, buffers not retained
`ioLimit=8` videos × 30 frames = up to 240 queued Vision calls if frame
analysis is unbounded — that's a resource-exhaustion repeat of the same
problem `ioLimit` itself was introduced to prevent (see `ingestDir.ts:105`
comment). Frame analysis uses a small per-video limiter (bounded
producer/consumer): frames are analyzed incrementally through `visionPool`,
and each frame buffer is discarded immediately after its Vision call
resolves and labels are captured — full-resolution frame buffers are never
held for the whole file at once, only one (or a small bounded batch) in
flight.

### 11. Duration/audio-stream caching
A single ffprobe call per file returns both duration and audio-stream
presence — these are not separate subprocess invocations. The cached result
feeds both the frame-extraction-strategy decision (#9) and the
transcript-path decision (#6).

### 12. envelope.frames path semantics — locked
Sampled frames are written to the per-run temp directory, analyzed, and
deleted (per the runtime contract in #3) — they are **not** archived.
Therefore `envelope.frames` entries do **not** store a frame file path
(a path into a deleted temp dir would be a dangling reference post-cleanup).
`envelope.frames[i]` shape: `{ timestampMs: number, labels: Label[] }` only.
No content hash in v1 (deferred — not needed unless/until frame archival
becomes an actual requirement, which is out of scope per rev 1).

## Build vs. buy (GitHub research) — unchanged from rev 1
No existing repo replaces the TRM-specific glue (classify → extract → fact
pipeline → manifest/dedup/envelope storage). Evaluated OpenMontage,
Coactive, Intel Edge Platform video-search-and-summarization — all full
platforms, wrong shape for a local-first personal archive. Reusable pieces:
**ffmpeg** (frame extraction) + **whisper.cpp** (self-hosted transcription),
same dependency shape as existing `mammoth`/`pdf-parse`/Vision-API client.

## Sources consulted
- https://sipsip.ai/blog/open-source-video-transcriber
- https://docs.openedgeplatform.intel.com/2025.2/edge-ai-libraries/video-search-and-summarization/overview-architecture-summary.html
- https://tosea.ai/blog/openmontage-agentic-video-production-guide
- https://github.com/mazsola2k/ai-video-editor
