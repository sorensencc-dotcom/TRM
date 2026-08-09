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
  only affect which frames get a Vision call. The full transcript of the
  selected clip always flows into the composed text.
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

All six input shapes normalize to one `(effectiveStartMs, effectiveEndMs)`
pair *before* any clamping:

| Input given | Normalizes to |
|---|---|
| `--start` + `--end` | `(start, end)` |
| `--start` + `--duration` | `(start, start + duration)` |
| `--start` only | `(start, probedDurationMs)` |
| `--end` only | `(0, end)` |
| `--duration` only | `(0, duration)` |
| none | `(0, probedDurationMs)` — i.e. today's unchanged behavior |

Then, in order, all still per-video failures routed through the existing
outer per-file `catch` → `failedStore`/`videoMetricsLog` exactly like any
other video failure (corrupt media, existing cap violation, etc) — the
batch continues processing other files on any rejection below:

1. If `effectiveStartMs > probedDurationMs` → reject.
2. If `effectiveEndMs > probedDurationMs` → clamp `effectiveEndMs` to
   `probedDurationMs`, print a warning (`"end=70:00 clamped to video
   duration 60:00"`).
3. `clipDurationMs = effectiveEndMs - effectiveStartMs`.
4. **If `clipDurationMs <= 0` → reject.** Phase 1's zero/negative-duration
   check only catches an explicit `--duration` of zero or less; it cannot
   see this case, which only exists after clamping — e.g. `--start 10:00
   --end 10:00` normalizes fine in Phase 1 (both positive, no explicit
   duration given) but produces a zero-length clip here, and `--start
   65:00` on a 60-minute video with no explicit `--end` normalizes to
   `(65:00, 60:00)` before step 1 catches it as out-of-range — but
   `--duration 5:00` alone on a video shorter than 5 minutes would clamp to
   a *positive* but very short clip, not zero, so this check is a genuine
   independent guard, not redundant with step 1.
5. **Existing max-duration cap (`getVideoMaxDurationMs()`, `TRM_VIDEO_MAX_DURATION_MS`,
   from the earlier duration/size-cap hardening work) now applies to
   `clipDurationMs`, not `probedDurationMs`.** This is a real behavior
   change: today it rejects based on the full source file's duration before
   any trim concept existed. Checking it against the untrimmed
   `probedDurationMs` here would reject the exact motivating case — trim a
   60-minute video (over most default caps) down to a 10-minute slice — for
   a video that was never going to have more than 10 minutes of real work
   done on it. The **file-size cap** (`getVideoMaxBytes()`,
   `TRM_VIDEO_MAX_BYTES`) is unchanged — it still runs where it always has,
   via `fs.stat` before `probeVideo()` even runs, against the full source
   file. Trimming doesn't reduce how much of the file ffmpeg has to seek
   through to reach the trim start, so the size cap staying source-file-wide
   is intentional, not an oversight.
6. `clipDurationMs` (now validated) is what gets passed to
   `extractFrames`/`extractAudio`/`transcribeAudio*` for strategy selection
   and timeout scaling — never the raw `probedDurationMs`.

`extractFrames`/`extractAudio` gain an optional `startMs` parameter: when
present, both build ffmpeg args with `-ss <startMs/1000>` *before* `-i`
(fast, seeks to the nearest preceding keyframe) and `-t <clipDurationMs/1000>`
to bound output to the clip. This is deliberately not frame-accurate
seeking — accurate seeking requires decoding from file-start, which defeats
the entire point of trimming a 60-minute file to save work. The ±15s
keyword-match padding (below) already absorbs far more slop than
keyframe-seek drift (sub-second to low-seconds) ever produces. Documented
in `--help` text as a known characteristic, not a bug.

`durationMs` passed to `extractFrames`/`extractAudio` is always
`clipDurationMs` (never `probedDurationMs`), per step 6 above — so
`buildFfmpegArgs`' existing threshold logic (`MIDPOINT_THRESHOLD_MS`,
`FPS_THRESHOLD_MS`) already operates on the trimmed length with no change.
**The one interaction that needs explicit handling: the `< 10s` midpoint
strategy already emits its own `-ss` computed from `durationMs / 2`** (today
that's a plain seek-to-midpoint-of-file; now it's seek-to-midpoint-of-clip).
`startMs` is not a second, independent `-ss` — it's folded into that same
value: `buildFfmpegArgs` takes `startMs` as a third argument (default `0`,
so the non-trim call site is unchanged) and computes a single `-ss` per
strategy:

| Strategy | `-ss` value (seconds) |
|---|---|
| midpoint (`< 10s`) | `startMs/1000 + durationMs/2/1000` |
| fps (`< 300s`) | `startMs/1000` |
| select (`>= 300s`) | `startMs/1000` |

Only one `-ss` flag is ever emitted, immediately before `-i`, for every
strategy. `-t <clipDurationMs/1000>` is added after `-i` for the fps and
select strategies (which don't otherwise bound their output duration); the
midpoint strategy already bounds itself via `-vframes 1` and doesn't need
`-t`. When `startMs` is `0` (no trim, or trim starting at the file's own
start), this produces byte-identical args to today's untrimmed call —
verified by a unit test asserting `buildFfmpegArgs(file, dur, pattern, 0)`
equals the pre-trim baseline for all three strategy branches.

### Keyword semantics

Keyword matching operates on **transcript segment text only**. It never
touches frame labels (don't exist yet when the filtering decision happens)
and never touches extracted facts (facts extraction still runs on whatever
composed text survives — keywords reduce which frames feed into that text,
they don't post-filter the facts themselves). **The transcript text itself
is never filtered or trimmed** — the full transcript of the selected clip
always flows into the composed text unchanged.

Normalization of the effective keyword list (union of `--keywords` and, if
`--auto-keywords`, the auto-derived list): trim whitespace, lowercase, strip
surrounding punctuation, drop empty entries, dedupe via `Set`. Likely `[]`
when `--auto-keywords` is given but the topic has no existing facts with
non-empty categories, or `--keywords` is given as an empty/all-empty string.

**`keywordSource` vs `keywordFilterOutcome` — kept independent, not
conflated:** `keywordSource` records what was *requested*
(`'manual'`/`'auto'`/`'manual+auto'`) whenever either flag was given at
all, regardless of whether normalization left `keywordsUsed` empty.
`keywordFilterOutcome: 'not-requested'` is reserved strictly for the case
where *neither* flag was given — never used just because the effective
list happened to normalize to `[]`. An empty effective list (flags given,
nothing survived normalization) behaves like — and is recorded as —
`keywordFilterOutcome: 'fallback-no-match'`: there's nothing to match
against, so trivially zero matches, same all-frames-analyzed behavior as
the transcript-produced-zero-matches case below. This keeps "what did the
operator ask for" and "what actually happened" independently reconstructable
from the log/envelope, rather than one field silently overwriting the
other.

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

### Pipeline fork: legacy concurrent path vs staged path

Today `ingestDir.ts` runs two `Promise.allSettled` branches per video: one
does `extractAudio` + `transcribeAudio` end-to-end, the other does
`extractFrames` + `analyzeFrames` end-to-end, fully concurrent. A staged
pipeline (extract frames, wait for transcript segments, filter, *then*
analyze) is only needed when a keyword match window can actually change
which frames get analyzed. Rather than routing every video through the
staged pipeline and folding the fallback cases in after the fact, the
decision of which pipeline to run is made **once, before any of Stage A
runs**, using values already known at that point (`keywordSource`,
normalized `keywordsUsed`, and `hasAudioStream` from the earlier
`probeVideo()` call):

| Condition | Pipeline used | `keywordFilterOutcome` |
|---|---|---|
| No `--keywords`/`--auto-keywords` given | **Legacy concurrent** (today's two `Promise.allSettled` branches, unchanged) | `'not-requested'` |
| Flags given, normalized `keywordsUsed` is `[]` | **Legacy concurrent**, using plain `transcribeAudio` (no segments needed — nothing to match) | `'fallback-no-match'` |
| Flags given, `keywordsUsed` non-empty, `hasAudioStream === false` | **Legacy concurrent**, using plain `transcribeAudio` (returns `''`, no segments possible) | `'fallback-no-audio'` |
| Flags given, `keywordsUsed` non-empty, `hasAudioStream === true` | **Staged** (below) | `'filtered'` if ≥1 match, else `'fallback-no-match'` |

Only the last row — keywords actually given, normalized to a non-empty
list, on a video that has audio to search — pays the concurrency cost of
waiting for transcript segments before Vision runs. Every other case,
including both fallback cases, keeps today's fully-concurrent behavior
byte-for-byte: transcript and frame analysis run in parallel via the
existing `Promise.allSettled`, `analyzeFrames` covers the full frame set,
and `framesConsidered === framesAnalyzed`. This is the only place
`keywordFilterOutcome` is decided for the two fallback rows — they are
never routed through the staged pipeline just to be told after the fact
that nothing was filtered.

**Staged pipeline (last row only):**

- **Stage A** (concurrent, `Promise.allSettled`): transcript branch runs
  `extractAudio` + `transcribeAudioWithSegments`; frame branch runs
  `extractFrames` only (no `analyzeFrames` here). Rejection handling is
  unchanged from today — either branch rejecting routes through the
  existing outer `catch`, and whichever branch fulfilled still gets cached
  via `writeVideoPartialProgress`.
- **Stage B** (sequential, once both Stage A branches fulfill): the
  transcript's segments are matched against the keyword list to produce
  match windows, `framePaths`/`timestampsMs` are filtered to frames falling
  inside any window, and `analyzeFrames` runs only over that subset.
  `framesConsidered` (Stage A's full extracted count) and `framesAnalyzed`
  (the filtered subset Vision actually saw) are recorded separately, per
  Observability below. A Stage B `analyzeFrames` failure is caught and
  routed through the same outer per-video `catch` as any other video
  failure — it doesn't get special-cased.

**Partial-progress cache — options fingerprint (applies to both
pipelines):** `VideoPartialProgress` is keyed by content hash only, but
what gets cached under that hash (`transcript`, the new
`transcriptSegments`, `frameAnalyses`) depends on which trim/keyword options
produced it — a plain `transcript` from an untrimmed run is not valid to
reuse for a `--start 15:00 --end 25:00` retry of the same file, and a
`frameAnalyses` result filtered against one keyword list is not valid to
reuse against a different one. `VideoPartialProgress` gains a required
`optionsFingerprint: string` field: a deterministic serialization of
`{ effectiveStartMs, effectiveEndMs, keywordsUsed: [...keywordsUsed].sort(),
keywordSource }` (post-normalization, sorted so union-merge ordering can't
change the fingerprint), computed once Phase 2 validation has produced
`effectiveStartMs`/`effectiveEndMs` for the current attempt.
`writeVideoPartialProgress` always writes the current attempt's fingerprint
alongside whichever branch(es) fulfilled. `readVideoPartialProgress`'s
caller compares the stored fingerprint against the current attempt's before
reusing anything; a mismatch is treated exactly like the existing
corrupt-JSON case — no cached progress, both branches rerun from scratch —
rather than partially trusting a cache produced under different options.
This applies uniformly: a `--force` re-ingest with different trim or
keyword flags, or a `--retry-failed` that (per Dedup & retry-failed below)
replays the *originally recorded* options, both get a fingerprint match/miss
decision instead of blindly reusing whatever happens to be on disk under
that hash.

`VideoPartialProgress.frameAnalyses` keeps meaning exactly what it means
today — "Vision already ran and produced these results" — written only when
`analyzeFrames` actually completes, whether that's inline (legacy path) or
in Stage B (staged path). The new `transcriptSegments` field is written
whenever `transcribeAudioWithSegments` completes, so a retry after a Stage
B-only failure (Vision error, keyword-window compute bug) — same
fingerprint, so the cache is valid — doesn't pay for a second whisper pass;
only frame extraction (cheap, local, and never cached since the temp files
don't survive past this run's `finally` cleanup) and `analyzeFrames` need to
rerun.

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

- Time-range normalization/clamping: unit tests for all six input shapes
  (start+end, start+duration, start-only, end-only, duration-only, none) ×
  clamp/reject boundary cases (start beyond duration, end beyond duration,
  zero-length clip after clamping, clip duration exceeding
  `TRM_VIDEO_MAX_DURATION_MS`, zero/negative explicit duration, malformed
  strings).
- Whisper segment parser: unit tests with hand-built fixture strings
  (hours component, decimal precision variants, irregular spacing,
  malformed/unparseable lines interspersed, multiline segment text) are
  **mandatory, run in normal CI** regardless of whether real whisper
  binaries are installed. Separately, one real-binary test — extending the
  existing opt-in `tests/smoke/videoPipeline.smoke.test.ts` pattern
  (`TRM_SMOKE_VIDEO=1` + real ffmpeg/ffprobe/whisper-cli required, skipped
  otherwise) — runs actual whisper-cli against a real short spoken-word
  fixture and asserts the parser correctly extracts segments from genuine
  output. The mandatory unit tests are what actually gate CI; the
  real-binary test is a periodic/manual real-world check, same as the
  existing video smoke suite.
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
- Pipeline fork: with no keyword flags, and separately with keyword flags
  that normalize to `[]` or hit a `hasAudioStream: false` video, assert
  `transcribeAudio` (not `transcribeAudioWithSegments`) is called and that
  frame extraction and transcription are invoked without either awaiting
  the other's result (i.e. the legacy concurrent path, not the staged one)
  — the fallback rows must not go through Stage A/B at all, not just
  produce the same `framesAnalyzed` count by coincidence.
- Partial-progress fingerprint: a cached `VideoPartialProgress` written
  under one `optionsFingerprint` (e.g. untrimmed, no keywords) must be
  ignored — both branches rerun from scratch — when the same content hash
  is retried with a different fingerprint (e.g. `--start`/`--end` added, or
  a different `--keywords` list), including the `--force` case; a retry
  with the *same* effective options must still reuse the cache.

## Out of scope / explicitly deferred

- Configurable match-padding window (currently a fixed 15s constant).
- Free-text fact mining for auto-keywords (categories-only for now).
- Folding processing options into dedup identity.
- Frame-accurate seeking.
- Single-file `ingest-video` command.
