# PLAN — scale-ingest / video-ingest

**Mode:** Deep (D3)  **Time budget:** Standard  **Drafted:** 2026-08-07
**Source:** SPEC.md rev 4 / CONTEXT.md rev 4

## Phase 1 — Runtime dependency layer

### Task 1.1 — ffmpeg/ffprobe preflight + config surface
- **Deliverable:** `src/core/videoDeps.ts` exporting `checkFfmpegDeps(): Promise<void>`
  — runs `ffmpeg -version` / `ffprobe -version` via configured paths
  (`TRM_FFMPEG_PATH`, `TRM_FFPROBE_PATH`, PATH-lookup default), throws one
  actionable error naming the missing binary + env var on failure.
- **Success criteria:** Called once at top of `runIngestDir` before any file
  loop, only when the batch contains ≥1 video file (skip entirely for
  image/text-only batches — no behavior change to existing paths). Missing
  binary aborts the whole batch, zero files reach `failedStore`.
- **Files:** new `src/core/videoDeps.ts`, new
  `tests/core/videoDeps.test.ts`, edit `src/cli/commands/ingestDir.ts`
  (call site only).
- **Dependencies:** none.
- **Blast radius:** low — new module, one call-site addition in
  `ingestDir.ts` guarded by "batch has video files" check.

### Task 1.2 — Lazy single-flight whisper preflight
- **Deliverable:** `checkWhisperDeps(): Promise<void>` in `videoDeps.ts`,
  memoized as a single in-flight promise (`let whisperCheckPromise:
  Promise<void> | null`) — first caller creates it, concurrent callers under
  `ioLimit` await the same promise, result cached for the batch.
- **Success criteria:** Test simulates N concurrent calls (mirrors
  `ioLimit` fan-out) and asserts the underlying binary-check function fires
  exactly once. Video-only-silent batch never calls it.
- **Files:** `src/core/videoDeps.ts`, `tests/core/videoDeps.test.ts`.
- **Dependencies:** 1.1 (same module).
- **Blast radius:** low — isolated function, no existing code depends on it
  yet (wired in Phase 3).

## Phase 2 — Media probing & classification

### Task 2.1 — VIDEO_EXTENSIONS + three-way classification branch
- **Deliverable:** `VIDEO_EXTENSIONS` set (`.mp4`, `.mov`, `.avi`, `.mkv` —
  confirm exact list against archive sample in implementation) in
  `ingestDir.ts`; work-item loop branches image / text-doc / video instead
  of the current image / non-image binary split.
- **Success criteria:** Video file routed to new branch (stubbed, no-op in
  this task); existing image/text-doc routing byte-for-byte unchanged
  (regression-tested against current `ingestDir.test.ts` suite).
- **Files:** `src/cli/commands/ingestDir.ts`,
  `tests/cli/commands/ingestDir.test.ts`.
- **Dependencies:** none (can run parallel to Phase 1).
- **Blast radius:** medium — touches the shared classification `if` in
  the hot path all existing ingest runs go through; must not regress
  image/text-doc branches.

### Task 2.2 — Cached ffprobe (duration + audio-stream presence)
- **Deliverable:** `src/core/videoProbe.ts` exporting `probeVideo(filePath):
  Promise<{ durationMs: number; hasAudioStream: boolean }>` — one ffprobe
  subprocess call per file, 10s timeout, non-zero-exit/unparseable-output
  routed as a thrown error (caller maps to `failedStore`).
- **Success criteria:** Single subprocess invocation per call (assert via
  spawn-call-count in test); malformed/corrupt fixture file throws;
  10s-timeout case throws; multi-audio-stream fixture returns
  `hasAudioStream: true` without erroring (stream index 0 selection happens
  downstream in transcription, not here).
- **Files:** new `src/core/videoProbe.ts`, new
  `tests/core/videoProbe.test.ts`.
- **Dependencies:** none.
- **Blast radius:** low — new isolated module.

## Phase 3 — Frame extraction & analysis

### Task 3.1 — Single-process ffmpeg frame extraction (3 strategies)
- **Deliverable:** `src/ingestion/videoExtract/extractFrames.ts` exporting
  `extractFrames(filePath, durationMs, tempDir): Promise<string[]>` (sampled
  frame file paths in the temp dir) — one ffmpeg invocation, strategy
  selected by duration: `fps=1/10` for `< 300000ms`, evenly-spaced `select`
  filter capped at 30 frames for `>= 300000ms`, single midpoint frame for
  `< 10000ms`. Output frames downscaled to 1024px max long edge in the same
  ffmpeg call (`scale` filter). Runs under `TRM_FFMPEG_CONCURRENCY` pool
  (default 2).
- **Success criteria:** Exactly one `ffmpeg` subprocess spawned per call
  regardless of frame count (assert spawn-call-count = 1 in test, three
  fixtures: 4:59, 5:00, 5:01, 0:08 durations hit the correct strategy per
  the `< 300s` boundary rule). Frame count ≤ 30 for all durations tested.
- **Files:** new `src/ingestion/videoExtract/extractFrames.ts`, new
  `src/core/concurrency.ts` addition (`ffmpegPool`), new
  `tests/ingestion/videoExtract/extractFrames.test.ts`.
- **Dependencies:** 2.2 (needs duration).
- **Blast radius:** low — new module; `concurrency.ts` addition is additive
  (new export, no change to `visionPool`/`claudePool`).

### Task 3.2 — Bounded per-video frame analysis, buffer discard
- **Deliverable:** `analyzeFrames(framePaths, timestampsMs): Promise<{
  timestampMs: number; labels: Label[] }[]>` in `extractFrames.ts` (or
  sibling module) — submits frames through a new `TRM_FRAME_ANALYSIS_CONCURRENCY`
  pool (default 3) sitting in front of the existing `visionPool` /
  `ImageAnalyzer.extract()`; each frame file is read, analyzed, and deleted
  (temp file `fs.unlink`) immediately after its Vision call resolves —
  never all 30 buffers held at once. Result ordered ascending by
  `timestampMs`.
- **Success criteria:** Test with a mocked slow `ImageAnalyzer.extract()`
  and 30 fixture frames asserts max concurrent in-flight calls ≤ 3
  (frame-analysis pool bound honored independent of `visionPool`'s own
  bound). Test asserts frame files no longer exist on disk after
  `analyzeFrames` resolves. Result array is `timestampMs`-ascending.
- **Files:** `src/ingestion/videoExtract/extractFrames.ts`,
  `src/core/concurrency.ts` (add `frameAnalysisPool`),
  `tests/ingestion/videoExtract/extractFrames.test.ts`.
- **Dependencies:** 3.1.
- **Blast radius:** low — new pool is additive; does not change
  `visionPool` behavior for the existing photo path.

## Phase 4 — Transcript extraction

### Task 4.1 — whisper.cpp transcription
- **Deliverable:** `src/ingestion/videoExtract/transcribe.ts` exporting
  `transcribeAudio(filePath): Promise<string>` — spawns whisper.cpp on
  stream index 0 only, explicit timeout (sized relative to duration, e.g.
  `max(30s, durationMs * 0.5)`), stderr captured into thrown-error text on
  failure, runs under `TRM_WHISPER_CONCURRENCY` pool (default 1).
- **Success criteria:** One subprocess per call; stderr content appears in
  thrown error message on non-zero exit; timeout case throws distinctly
  from a normal failure (test asserts error message differentiates
  "timeout" vs "process failed"); silent/no-speech audio fixture returns
  empty string, not an error.
- **Files:** new `src/ingestion/videoExtract/transcribe.ts`,
  `src/core/concurrency.ts` (add `whisperPool`), new
  `tests/ingestion/videoExtract/transcribe.test.ts`.
- **Dependencies:** 1.2 (whisper preflight gates first real call).
- **Blast radius:** low — new isolated module.

## Phase 5 — Compose, envelope, integration

### Task 5.1 — RawSourceEnvelope `kind: 'video'` + `frames` field
- **Deliverable:** extend `RawSourceEnvelope` in `src/core/rawSource.ts`:
  `kind: 'text' | 'image' | 'video'`, new optional
  `frames?: { timestampMs: number; labels: Label[] }[]`.
- **Success criteria:** Existing `'text'`/`'image'` envelope
  read/write round-trip tests still pass unmodified (type widening is
  additive, no field removed/renamed).
- **Files:** `src/core/rawSource.ts`, `tests/core/rawSource.test.ts`.
- **Dependencies:** none — can land any time before 5.3.
- **Blast radius:** low, but **wide reach**: this is the one shared type
  the exhaustive-consumer audit in SPEC.md AC6 depends on. Re-grep
  `envelope.kind` across `src/` at this task's start in case new consumers
  landed since the SPEC audit (2026-08-07).

### Task 5.2 — `extract.ts` fallthrough test for `kind: 'video'`
- **Deliverable:** explicit test in `tests/cli/commands/extract.test.ts`
  asserting a `kind: 'video'` envelope is NOT caught by the
  `kind === 'image'` skip at `extract.ts:36` and its `text` field is passed
  to `runner.run()`.
- **Success criteria:** Test fails if someone later changes the skip
  condition to `kind !== 'text'` (i.e. it actually exercises the
  fallthrough, not just re-asserts current code shape).
- **Files:** `tests/cli/commands/extract.test.ts`. No production code
  change expected (SPEC AC6 predicts current fallthrough is already
  correct) — if the test fails, `extract.ts:36` needs an explicit `kind ===
  'video'` branch added.
- **Dependencies:** 5.1.
- **Blast radius:** low — test-only, unless the assumption is wrong (see
  above).

### Task 5.3 — Concurrent transcript+frame orchestration, text composition
- **Deliverable:** new `videoIngest.ts` branch in `ingestDir.ts` (wired
  into the Task 2.1 stub): per video file, `Promise.all([
  hasAudioStream ? transcribeAudio(...) : Promise.resolve(''),
  extractFrames(...).then(analyzeFrames) ])`; compose text as transcript +
  `\n` + each frame's `[frame @ mm:ss] labels: a, b, c` line in
  `timestampMs` order; single `runner.run(source, composedText)` call;
  write `RawSourceEnvelope` with `kind: 'video'`, `text: composedText`,
  `frames: [...]`.
- **Success criteria:** Matches SPEC ACs 3–6 end to end on a fixture set
  (silent video, audio-only-content video, mixed video, <10s clip,
  ≥300s video) — one `runner.run()` call per video (not two), envelope
  written with correct `kind`/`text`/`frames` shape, dedup/failedStore
  entries created identically to the existing text-doc branch on failure.
- **Files:** `src/cli/commands/ingestDir.ts`,
  `tests/cli/commands/ingestDir.test.ts` (video fixtures).
- **Dependencies:** 2.1, 2.2, 3.1, 3.2, 4.1, 5.1, 5.2.
- **Blast radius:** medium — this is the integration point; touches the
  same `ingestDir.ts` file as Task 2.1 but is additive (new branch body,
  not a change to existing image/text-doc branch bodies).

### Task 5.4 — ffprobe/media edge-case → failedStore wiring
- **Deliverable:** wire `probeVideo`/`extractFrames`/`transcribeAudio`
  thrown errors (malformed media, ffprobe timeout, ffmpeg/whisper subprocess
  failure) through the same `manifestStore.markFailed` /
  `failedStore.appendFailure` path the image/text-doc branches already use
  — no new error-handling shape.
- **Success criteria:** Corrupt-media fixture and induced-timeout fixture
  both land in `failedStore` with the underlying error message preserved,
  batch continues processing remaining files (no crash), `--retry-failed`
  picks them up on a subsequent run same as an OCR failure today.
- **Files:** `src/cli/commands/ingestDir.ts`,
  `tests/cli/commands/ingestDir.test.ts`.
- **Dependencies:** 5.3.
- **Blast radius:** low — reuses existing catch/failedStore block, no new
  failure-handling code path.

## Dependency order

```
1.1 ─┐
1.2 ─┤→ 4.1 ─┐
2.1 ──────────┤
2.2 → 3.1 → 3.2 ┤→ 5.3 → 5.4
5.1 → 5.2 ──────┘
```

Phases 1, 2, 3, 4 can be built in parallel (independent modules, no shared
file edits except the additive `concurrency.ts` exports). Phase 5 is the
integration/convergence point.

## Out of scope (per SPEC)

Scene detection, CLIP/SigLIP embeddings, cloud transcription fallback,
reverse-image search on frames, multi-audio-stream support, CLI-configurable
sampling params, binary version pinning — none of these get tasks.

## PLAN AUDIT gate checklist (self-check before execution)

- [x] Every SPEC.md acceptance criterion (1–11) maps to at least one task:
      AC1→2.1, AC2→1.1/1.2, AC3→3.1, AC4→4.1/5.3, AC5→5.3, AC6→5.1/5.2,
      AC7→5.4, AC8→5.3 (reuse, not new code), AC9→3.1/4.1 (no cloud calls
      added), AC10→3.1/4.1 pools, AC11→3.2.
- [x] No task drops SPEC scope; out-of-scope items have zero tasks.
- [x] Dependencies ordered — no task references a module before its
      producing task.
- [x] User approval to proceed to execution — approved 2026-08-07.
