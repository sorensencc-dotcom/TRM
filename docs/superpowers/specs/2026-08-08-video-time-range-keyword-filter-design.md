# Video Time-Range Trim + Keyword-Filtered Frame Analysis — Design

## Problem

`trm ingest-dir`'s video pipeline (shipped 2026-08-08, hardened same day —
see `memory/project-trm-video-ingest-shipped-2026-08-08.md` and
`memory/project-trm-video-smoke-test-2026-08-08.md`) always processes a
video's full duration: whisper transcribes the whole audio track, ffmpeg
samples frames across the whole timeline, and every sampled frame gets a
Vision API call.

For a long candidate video (e.g. 60 minutes) where only a known segment is
relevant (e.g. 15:00–25:00), or where most of the runtime is irrelevant
noise around a few keyword-worthy moments, this wastes real time and real
Vision API spend on footage nobody wants ingested.

Two related asks:

1. Trim ingestion to an explicit time range (`--start`/`--end`/`--duration`).
2. Within the (possibly trimmed) range, use keywords — supplied manually or
   pulled from the target topic's existing known terms — to skip Vision
   analysis on frames that don't correspond to a keyword mention in the
   transcript.

## Goals

- `ingest-dir --start 15:00 --end 25:00` (or `--start 10:00 --duration 5:00`)
  processes only that slice of the video — ffmpeg and whisper both operate
  on the trimmed range, not the full file.
- `ingest-dir --keywords "car,accident,interview"` and/or
  `--auto-keywords` skip Vision analysis on frames that don't fall near a
  keyword mention in the transcript, without dropping any transcript text
  and without changing behavior for videos where no keyword flag is given.
- All existing video ingest behavior (caps, per-video metrics, partial-
  progress resume, dependency-version logging, subprocess-kill safety) keeps
  working unchanged when these new flags are absent.
- Every trim/keyword decision made for a given ingest is fully reproducible
  from the stored output (envelope + metrics log), not just from operator
  memory of what flags were typed.

## Non-goals

- No frame-accurate seeking — `-ss` before `-i` (fast, keyframe-inexact) is
  used deliberately; see Design.
- No filtering of extracted facts or transcript text by keyword — keywords
  only affect which frames get a Vision call. The full transcript always
  flows into the composed text.
- No change to dedup identity — re-ingesting the same file with different
  trim/keyword options is a documented limitation requiring `--force`, not
  a new dedup key.
- No auto-keyword derivation from free-text fact content (tokenization,
  stopword filtering, frequency ranking) — only existing `Fact.categories`
  values feed `--auto-keywords`. Free-text mining is future work if this
  proves useful.
- No single-file `ingest-video` command — this ships as new `ingest-dir`
  flags, applied to every video processed in that run.

## Design

### CLI surface (`src/cli/index.ts`, `ingest-dir` command)

New options:

- `--start <time>` — `HH:MM:SS` or `MM:SS`.
- `--end <time>` — same format. Mutually exclusive with `--duration`.
- `--duration <time>` — same format. Mutually exclusive with `--end`.
- `--keywords <comma-separated list>` — manual keyword list.
- `--auto-keywords` — boolean; merges in keywords derived from the target
  topic's existing facts (see Auto-keyword derivation below).

None of these five flags may be combined with `--retry-failed` (see Dedup &
retry-failed below) — `--retry-failed` always replays the options recorded
at failure time, so passing new ones alongside it would be ambiguous about
which wins. Rejected at Phase 1 validation.

### Time-range validation & normalization — two phases

**Phase 1 (syntax, in the Commander action handler, before `runIngestDir`
is called — no binary/file work has happened yet):**

- Malformed timestamp format → reject.
- Negative value in any of `--start`/`--end`/`--duration` → reject.
- Zero or negative resulting duration → reject.
- `--end` + `--duration` both given → reject.
- Any of the five new flags combined with `--retry-failed` → reject.

**Phase 2 (duration-dependent, per video, immediately after that video's
`probeVideo()` call succeeds, before extraction starts):**

All four input shapes normalize to one `(effectiveStartMs, effectiveEndMs)`
pair *before* any clamping:

| Input given | Normalizes to |
|---|---|
| `--start` + `--end` | `(start, end)` |
| `--start` + `--duration` | `(start, start + duration)` |
| `--start` only | `(start, probedDurationMs)` |
| `--end` only | `(0, end)` |
| `--duration` only | `(0, duration)` |
| none | `(0, probedDurationMs)` — i.e. today's unchanged behavior |

Then, in order:

1. If `effectiveStartMs > probedDurationMs` → reject. This is a per-video
   failure — caught by the existing outer per-file `catch`, routed through
   `failedStore`/`videoMetricsLog` exactly like any other video failure
   (corrupt media, cap violation, etc). The batch continues processing
   other files.
2. If `effectiveEndMs > probedDurationMs` → clamp `effectiveEndMs` to
   `probedDurationMs`, print a warning (`"end=70:00 clamped to video
   duration 60:00"`).
3. `clipDurationMs = effectiveEndMs - effectiveStartMs` — this, not the
   probed full-video duration, is what gets passed to `extractFrames`/
   `extractAudio`/`transcribeAudio*` for strategy selection and timeout
   scaling.

`extractFrames`/`extractAudio` gain an optional `startMs` parameter: when
present, both build ffmpeg args with `-ss <startMs/1000>` *before* `-i`
(fast, seeks to the nearest preceding keyframe) and `-t <clipDurationMs/1000>`
to bound output to the clip. This is deliberately not frame-accurate
seeking — accurate seeking requires decoding from file-start, which defeats
the entire point of trimming a 60-minute file to save work. The ±15s
keyword-match padding (below) already absorbs far more slop than
keyframe-seek drift (sub-second to low-seconds) ever produces. Documented
in `--help` text as a known characteristic, not a bug.

### Keyword semantics

Keyword matching operates on **transcript segment text only**. It never
touches frame labels (don't exist yet when the filtering decision happens)
and never touches extracted facts (facts extraction still runs on whatever
composed text survives — keywords reduce which frames feed into that text,
they don't post-filter the facts themselves). **The transcript text itself
is never filtered or trimmed** — the full transcript always flows into the
composed text unchanged.

Normalization of the effective keyword list (union of `--keywords` and, if
`--auto-keywords`, the auto-derived list): trim whitespace, lowercase, strip
surrounding punctuation, drop empty entries, dedupe via `Set`. Likely `[]`
when `--auto-keywords` is given but the topic has no existing facts with
non-empty categories, or `--keywords` is given as an empty/all-empty string
— an empty effective keyword list is treated identically to no keyword
flags given at all (no filtering).

Matching rule: **whole-word, case-folded** against transcript segment text
(`"car"` matches `"car"`/`"Car"`, not `"scary"` or `"cartoon"`) — lower
false-positive rate than substring matching, which matters here because a
false match costs a real Vision API call.

### Auto-keyword derivation (`--auto-keywords`)

Source: `manifestStore.listEntries(root, targetTopicPath)` filtered to
`status === 'done'`, each read via `manifestStore.readExtract()`, collecting
the union of every `Fact.categories` entry across all of them — **not**
`extract.json`, which is a regenerated cache that can be stale relative to
the live per-source extract payloads. `Fact.categories` is already a flat
`string[]` (no nesting to handle). Empty-string category entries are
dropped by the same normalization pass as manual `--keywords`.

### Pipeline architecture — segment-aware transcription

New `transcribeAudioWithSegments()` in `transcribe.ts`, additive alongside
the existing `transcribeAudio()` — **not** a replacement. The existing
function keeps returning a plain string via whisper's `-nt` (no-timestamps)
flag, used for every video where no keyword flag is given (today's
behavior, zero regression risk to the pipeline hardened earlier this
session). `transcribeAudioWithSegments()` is only invoked when keyword
filtering is active: it omits `-nt`, so whisper.cpp emits its default
timestamped format:

```
[00:00:00.000 --> 00:00:02.500]   Hello world
```

Parsed into `{ text: string; segments: { startMs: number; endMs: number;
text: string }[] }`. The parser is defensive — skips lines that don't match
the `[HH:MM:SS.mmm --> HH:MM:SS.mmm]` bracket pattern rather than throwing,
and accumulates any following non-bracket lines as continuation text for
the most recently opened segment (handles whisper wrapping long segment
text across multiple lines) until the next valid bracket or EOF.

**This parser must be verified against real whisper-cli output, not just
hardcoded mock strings**, as its own test — this project already shipped
once with an assumed-vs-real whisper.cpp format mismatch (the original
binary-name/model-format/args bug from the initial video-ingest ship), and
the real-binary smoke-test precedent this session (follow-up #5,
`tests/smoke/videoPipeline.smoke.test.ts`) exists specifically to catch this
class of bug before it ships again.

Frame-window filtering (only when keyword filtering is active and produces
at least one match): all matching happens in **clip-relative** time —
segments come back clip-relative from whisper (it only ever sees the
trimmed WAV), and extracted frame timestamps are clip-relative before their
final origin-offset step (see Timestamp provenance below), so mixing
relative and absolute time here would be a real bug surface. A frame is
included if its clip-relative timestamp falls inside
`[segment.startMs - 15000, segment.endMs + 15000]` for *any* matched
segment (union across all matches, not just the nearest one), clamped to
`[0, clipDurationMs]`. 15000ms is a named constant, not hardcoded inline —
future-configurable but not exposed as a flag in this iteration (YAGNI:
no evidence yet that the default needs tuning per-video).

**Fallback (no filtering actually happens, but is recorded distinctly from
a successful filter):**

- Keyword flags given, video has no audio (`hasAudioStream: false`) → no
  transcript possible, all extracted frames go to Vision.
- Keyword flags given, transcript produces zero matches → all extracted
  frames go to Vision (never silently produce a near-empty ingest from an
  over-specific keyword list).

Both cases record `keywordFilterOutcome: 'fallback-no-audio'` /
`'fallback-no-match'` respectively — never reported as `'filtered'`.

Concurrency: frame **extraction** (ffmpeg, cheap, local) still runs
concurrently with transcription exactly as today, keyword filtering or not
— it doesn't depend on transcript content. Frame **Vision analysis** is the
one step that now waits on transcript segments when keyword filtering is
active, since it needs the match windows first. The non-keyword-filter path
(no `--keywords`/`--auto-keywords`) is completely unaffected — still fully
concurrent, identical to the already-shipped/tested behavior.

### Timestamp provenance

All stored timestamps (in `FrameAnalysis`, the composed envelope text, and
`videoProcessing` metadata) are **original-video-relative**, per explicit
preference — not clip-relative. Clip-relative frame/segment timestamps get
`effectiveStartMs` added exactly once, at the point they're about to be
persisted (after keyword-window filtering has already happened in
clip-relative space) — never earlier, to avoid double-offset bugs. Trim
metadata (`effectiveStartMs`, `effectiveEndMs`) is recorded alongside so
the original-video timestamps are interpretable without needing to also
know the trim.

### Dedup & retry-failed

Dedup identity is unchanged — purely content-hash-based, as it is today for
every file type. Re-ingesting the same file with different trim/keyword
options is a **documented limitation**: it's treated as an already-done
duplicate and skipped unless `--force` is passed. Changing this would mean
folding processing options into `manifestStore`'s dedup identity, a
cross-cutting change every file type (not just video) shares — out of
scope here.

`failedStore` entries gain an optional field:

```ts
videoOptions?: {
  startMs?: number;
  endMs?: number;
  keywords?: string[];
  keywordSource?: 'manual' | 'auto' | 'manual+auto' | 'none';
}
```

Populated only for video failures, recorded at failure time with whatever
effective options were in play for that attempt. `--retry-failed` replays
these recorded options exactly — never the current invocation's flags
(which are rejected outright if given alongside `--retry-failed`, per Phase
1 validation above).

### Observability

`videoMetricsLog` entry gains:

- `trimStartMs?`, `trimEndMs?` — effective/clamped, original-video-relative.
- `keywordsUsed?: string[]` — the normalized effective union (can be `[]`).
- `keywordSource?: 'manual' | 'auto' | 'manual+auto' | 'none'`.
- `keywordFilterOutcome?: 'not-requested' | 'filtered' | 'fallback-no-match'
  | 'fallback-no-audio'`.
- `framesConsidered?: number` — every frame `extractFrames()` produced for
  the (trimmed) clip.
- `framesAnalyzed?: number` — frames actually sent to Vision. Equals
  `framesConsidered` whenever `keywordFilterOutcome` is `'not-requested'`
  or either fallback variant; less than it only when `'filtered'`.

`RawSourceEnvelope` gains an optional `videoProcessing` block mirroring the
same fields (minus the two frame counts, which are ops telemetry, not
source-record content) — a permanent, reproducible record on the source
itself, independent of the `.trm-ops/` log (which could in principle be
pruned/rotated later).

## Error handling

- Phase 1 (syntax/mutual-exclusion) failures: non-zero exit, printed before
  any file, binary, or network work happens.
- Phase 2 (duration-dependent) failures: per-video, routed through the
  existing outer `catch` → `failedStore`/`manifestStore.markFailed`/
  `videoMetricsLog` (outcome `'failure'`), exactly like a corrupt-media or
  cap-violation failure today — one video's failure doesn't abort the
  batch.
- `runIngestDir`'s CLI action handler (`cli/index.ts`) sets
  `process.exitCode = 1` whenever the returned summary has
  `failureCount > 0` — new for `ingest-dir` specifically (other commands
  like `validate`/`sync-treatment` already follow this convention; this
  closes a pre-existing gap where `ingest-dir` never set a failing exit
  code at all, video-related or not). The full summary is still printed
  either way.

## Testing

- Time-range normalization/clamping: unit tests for all five input shapes
  (start+end, start+duration, start-only, end-only, duration-only, none) ×
  clamp/reject boundary cases (start beyond duration, end beyond duration,
  start>=end, zero/negative duration, malformed strings).
- Whisper segment parser: unit tests with hand-built fixture strings
  (hours component, decimal precision variants, irregular spacing,
  malformed/unparseable lines interspersed, multiline segment text) *plus*
  one real-binary test (extending the existing opt-in
  `tests/smoke/videoPipeline.smoke.test.ts` pattern) that runs actual
  whisper-cli against a real short spoken-word fixture and asserts the
  parser correctly extracts segments from genuine output.
- Keyword matching: unit tests for whole-word vs substring-would-have-
  matched cases, case-folding, punctuation stripping, empty-list handling,
  window union across multiple matches, clamping to clip bounds.
- Auto-keyword derivation: unit test against a fabricated multi-entry
  `manifestStore` fixture with varied `categories`, confirming union +
  normalization, and confirming it reads live entries rather than
  `extract.json`.
- Integration tests in `ingestDir.test.ts` (mocked video pipeline, matching
  existing convention): trim flags reduce what gets passed to
  `extractFrames`/`extractAudio`/`transcribeAudio*`; keyword flags reduce
  which frames reach `analyzeFrames`; both fallback paths produce all-
  frames-analyzed with the correct `keywordFilterOutcome`; `--retry-failed`
  combined with any new flag is rejected; `--retry-failed` alone replays
  recorded `videoOptions`; exit code is 1 when `failureCount > 0`.

## Out of scope / explicitly deferred

- Configurable match-padding window (currently a fixed 15s constant).
- Free-text fact mining for auto-keywords (categories-only for now).
- Folding processing options into dedup identity.
- Frame-accurate seeking.
- Single-file `ingest-video` command.
