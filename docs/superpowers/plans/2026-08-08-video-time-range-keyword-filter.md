# Video Time-Range Trim + Keyword-Filtered Frame Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `--start`/`--end`/`--duration` time-range trimming and `--keywords`/`--auto-keywords` keyword-filtered Vision analysis to `trm ingest-dir`'s video pipeline, per `docs/superpowers/specs/2026-08-08-video-time-range-keyword-filter-design.md`.

**Architecture:** New pure helper modules (time parsing/validation, keyword normalization/window matching, whisper segment parsing, auto-keyword derivation) feed into `ingestDir.ts`'s existing per-video pipeline. The pipeline forks at run time: the untouched legacy fully-concurrent `Promise.allSettled` path handles "no keywords" and both fallback cases; a new staged (extract → transcript segments → filter → analyze) path handles the one case where keyword filtering actually changes which frames get analyzed. `VideoPartialProgress` gains an options fingerprint so cached transcript/frame-analysis results are never reused across a trim/keyword option change.

**Tech Stack:** TypeScript, Jest (`ts-jest`), Commander CLI, execFile-based ffmpeg/ffprobe/whisper.cpp subprocess calls (all mocked in unit/integration tests — this plan adds no new real-binary smoke tests beyond the mandatory hand-built-fixture parser tests).

## Global Constraints

- No frame-accurate seeking — `-ss` before `-i` only, never frame-accurate decode-from-start.
- Keywords never filter transcript text or extracted facts — only which frames reach Vision.
- Dedup identity (content hash) is unchanged; re-ingesting with different options is a documented `--force`-required limitation, not a new dedup key.
- All existing video ingest behavior (caps, metrics, partial-progress resume, dependency-version logging, subprocess-kill safety) must keep working unchanged when none of the five new flags are given.
- Match-padding window is a fixed, named 15000ms constant — not configurable in this iteration.
- `Fact.categories` (from `src/scoring/types.ts`) is the only source for `--auto-keywords` — no free-text mining.

---

## File Structure

New files:
- `src/core/videoTimeRange.ts` — time-string parsing, Phase 1 syntax validation, Phase 2 duration-dependent normalization/clamping.
- `src/ingestion/videoExtract/keywordFilter.ts` — keyword normalization, whole-word matching, match-window computation.
- `src/ingestion/videoExtract/autoKeywords.ts` — `Fact.categories` union derivation from a topic's done manifest entries.
- `tests/core/videoTimeRange.test.ts`
- `tests/ingestion/videoExtract/keywordFilter.test.ts`
- `tests/ingestion/videoExtract/autoKeywords.test.ts`

Modified files:
- `src/ingestion/videoExtract/extractFrames.ts` — `buildFfmpegArgs`/`extractFrames` gain optional `startMs`.
- `src/ingestion/videoExtract/extractAudio.ts` — `extractAudio` gains optional trim bound.
- `src/ingestion/videoExtract/transcribe.ts` — adds `TranscriptSegment`, `parseWhisperSegments`, `transcribeAudioWithSegments`.
- `src/core/videoPartialProgress.ts` — adds `optionsFingerprint`, `computeOptionsFingerprint`, `KeywordSource`, `transcriptSegments`.
- `src/core/failedStore.ts` — adds `VideoFailureOptions`, `FailedEntry.videoOptions`, `appendFailure`'s new optional param.
- `src/core/videoMetricsLog.ts` — adds trim/keyword/frame-count fields to `VideoMetricsEntry`.
- `src/core/rawSource.ts` — adds `VideoProcessingMetadata`, `RawSourceEnvelope.videoProcessing`.
- `src/cli/index.ts` — new `ingest-dir` options, Phase 1 wiring, try/catch + exit code.
- `src/cli/commands/ingestDir.ts` — the actual pipeline integration (Tasks 10–11).
- `tests/ingestion/videoExtract/extractFrames.test.ts`, `extractAudio.test.ts`, `transcribe.test.ts`, `tests/core/videoPartialProgress.test.ts`, `tests/core/failedStore.test.ts` (if it exists — otherwise create), `tests/cli/ingestDir.test.ts`.

---

### Task 1: Time-string parsing + Phase 1 syntax validation

**Files:**
- Create: `src/core/videoTimeRange.ts`
- Test: `tests/core/videoTimeRange.test.ts`

**Interfaces:**
- Produces: `parseTimeString(input: string): number` (throws `Error` on malformed input), `TrimSyntaxInput { start?: string; end?: string; duration?: string }`, `ParsedTrimOptions { startMs?: number; endMs?: number; durationMs?: number }`, `parseAndValidateTrimSyntax(input: TrimSyntaxInput): ParsedTrimOptions`.

- [ ] **Step 1: Write failing tests for `parseTimeString`**

```typescript
// tests/core/videoTimeRange.test.ts
import { parseTimeString, parseAndValidateTrimSyntax } from '../../src/core/videoTimeRange';

describe('parseTimeString', () => {
  it('parses MM:SS', () => {
    expect(parseTimeString('05:30')).toBe(5 * 60 * 1000 + 30 * 1000);
  });

  it('parses HH:MM:SS', () => {
    expect(parseTimeString('01:15:00')).toBe((1 * 3600 + 15 * 60) * 1000);
  });

  it('allows minutes beyond 59 in MM:SS form', () => {
    expect(parseTimeString('90:00')).toBe(90 * 60 * 1000);
  });

  it('rejects minutes beyond 59 in HH:MM:SS form', () => {
    expect(() => parseTimeString('01:75:00')).toThrow(/Invalid time format/);
  });

  it('rejects seconds beyond 59', () => {
    expect(() => parseTimeString('05:99')).toThrow(/Invalid time format/);
  });

  it('rejects a negative value', () => {
    expect(() => parseTimeString('-5:00')).toThrow(/Invalid time format/);
  });

  it('rejects non-numeric input', () => {
    expect(() => parseTimeString('abc')).toThrow(/Invalid time format/);
  });

  it('rejects too many colon-separated parts', () => {
    expect(() => parseTimeString('1:02:03:04')).toThrow(/Invalid time format/);
  });

  it('rejects an empty string', () => {
    expect(() => parseTimeString('')).toThrow(/Invalid time format/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/core/videoTimeRange.test.ts -t parseTimeString`
Expected: FAIL — `Cannot find module '../../src/core/videoTimeRange'`

- [ ] **Step 3: Implement `parseTimeString`**

```typescript
// src/core/videoTimeRange.ts
const TIME_PART_PATTERN = /^\d+$/;

/**
 * Parses "HH:MM:SS" or "MM:SS" into milliseconds. Minutes are unrestricted
 * in MM:SS form (e.g. "90:00" is valid) but capped at 0-59 in the HH:MM:SS
 * form's middle component; seconds are always capped at 0-59.
 */
export function parseTimeString(input: string): number {
  const parts = input.trim().split(':');
  if ((parts.length !== 2 && parts.length !== 3) || !parts.every((p) => TIME_PART_PATTERN.test(p))) {
    throw new Error(`Invalid time format "${input}" -- expected HH:MM:SS or MM:SS`);
  }

  const nums = parts.map(Number);
  const seconds = nums[nums.length - 1];
  const minutes = nums[nums.length - 2];
  const hours = nums.length === 3 ? nums[0] : 0;

  if (seconds > 59 || (nums.length === 3 && minutes > 59)) {
    throw new Error(`Invalid time format "${input}" -- minutes/seconds must be 00-59`);
  }

  return ((hours * 60 + minutes) * 60 + seconds) * 1000;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/core/videoTimeRange.test.ts -t parseTimeString`
Expected: PASS

- [ ] **Step 5: Write failing tests for `parseAndValidateTrimSyntax`**

```typescript
describe('parseAndValidateTrimSyntax', () => {
  it('parses start+end', () => {
    expect(parseAndValidateTrimSyntax({ start: '15:00', end: '25:00' })).toEqual({
      startMs: 15 * 60 * 1000,
      endMs: 25 * 60 * 1000,
    });
  });

  it('parses duration only', () => {
    expect(parseAndValidateTrimSyntax({ duration: '05:00' })).toEqual({ durationMs: 5 * 60 * 1000 });
  });

  it('parses none of the three as an empty object', () => {
    expect(parseAndValidateTrimSyntax({})).toEqual({});
  });

  it('rejects --end and --duration both given', () => {
    expect(() => parseAndValidateTrimSyntax({ end: '10:00', duration: '05:00' })).toThrow(
      /mutually exclusive/
    );
  });

  it('rejects a zero or negative explicit --duration', () => {
    expect(() => parseAndValidateTrimSyntax({ duration: '00:00' })).toThrow(/positive/);
  });

  it('rejects --end <= --start', () => {
    expect(() => parseAndValidateTrimSyntax({ start: '10:00', end: '10:00' })).toThrow(
      /--end must be after --start/
    );
    expect(() => parseAndValidateTrimSyntax({ start: '10:00', end: '05:00' })).toThrow(
      /--end must be after --start/
    );
  });

  it('propagates a malformed timestamp from any of the three flags', () => {
    expect(() => parseAndValidateTrimSyntax({ start: 'bogus' })).toThrow(/Invalid time format/);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx jest tests/core/videoTimeRange.test.ts -t parseAndValidateTrimSyntax`
Expected: FAIL — `parseAndValidateTrimSyntax is not a function`

- [ ] **Step 7: Implement `parseAndValidateTrimSyntax`**

```typescript
export interface TrimSyntaxInput {
  start?: string;
  end?: string;
  duration?: string;
}

export interface ParsedTrimOptions {
  startMs?: number;
  endMs?: number;
  durationMs?: number;
}

export function parseAndValidateTrimSyntax(input: TrimSyntaxInput): ParsedTrimOptions {
  if (input.end !== undefined && input.duration !== undefined) {
    throw new Error('trm ingest-dir: --end and --duration are mutually exclusive');
  }

  const result: ParsedTrimOptions = {};
  if (input.start !== undefined) result.startMs = parseTimeString(input.start);
  if (input.end !== undefined) result.endMs = parseTimeString(input.end);
  if (input.duration !== undefined) result.durationMs = parseTimeString(input.duration);

  if (result.durationMs !== undefined && result.durationMs <= 0) {
    throw new Error('trm ingest-dir: --duration must be a positive time value');
  }

  if (result.startMs !== undefined && result.endMs !== undefined && result.endMs <= result.startMs) {
    throw new Error('trm ingest-dir: --end must be after --start');
  }

  return result;
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx jest tests/core/videoTimeRange.test.ts`
Expected: PASS (all tests in the file)

- [ ] **Step 9: Commit**

```bash
git add src/core/videoTimeRange.ts tests/core/videoTimeRange.test.ts
git commit -m "feat(video): add time-string parsing and Phase 1 trim syntax validation"
```

---

### Task 2: Phase 2 duration-dependent trim normalization/clamping

**Files:**
- Modify: `src/core/videoTimeRange.ts`
- Test: `tests/core/videoTimeRange.test.ts`

**Interfaces:**
- Consumes: `ParsedTrimOptions` (Task 1).
- Produces: `TrimResult { effectiveStartMs: number; effectiveEndMs: number; clipDurationMs: number; warning?: string }`, `resolveTrimWindow(parsed: ParsedTrimOptions, probedDurationMs: number, maxClipDurationMs: number): TrimResult` (throws `Error` on any Phase 2 rejection).

- [ ] **Step 1: Write failing tests covering all six input shapes and boundary cases**

```typescript
describe('resolveTrimWindow', () => {
  const HOUR = 60 * 60 * 1000;

  it('start+end normalizes to (start, end)', () => {
    const r = resolveTrimWindow({ startMs: 5 * 60000, endMs: 10 * 60000 }, HOUR, HOUR);
    expect(r).toEqual({ effectiveStartMs: 5 * 60000, effectiveEndMs: 10 * 60000, clipDurationMs: 5 * 60000 });
  });

  it('start+duration normalizes to (start, start+duration)', () => {
    const r = resolveTrimWindow({ startMs: 5 * 60000, durationMs: 3 * 60000 }, HOUR, HOUR);
    expect(r).toEqual({ effectiveStartMs: 5 * 60000, effectiveEndMs: 8 * 60000, clipDurationMs: 3 * 60000 });
  });

  it('start-only normalizes to (start, probedDurationMs)', () => {
    const r = resolveTrimWindow({ startMs: 5 * 60000 }, 10 * 60000, HOUR);
    expect(r).toEqual({ effectiveStartMs: 5 * 60000, effectiveEndMs: 10 * 60000, clipDurationMs: 5 * 60000 });
  });

  it('end-only normalizes to (0, end)', () => {
    const r = resolveTrimWindow({ endMs: 5 * 60000 }, HOUR, HOUR);
    expect(r).toEqual({ effectiveStartMs: 0, effectiveEndMs: 5 * 60000, clipDurationMs: 5 * 60000 });
  });

  it('duration-only normalizes to (0, duration)', () => {
    const r = resolveTrimWindow({ durationMs: 5 * 60000 }, HOUR, HOUR);
    expect(r).toEqual({ effectiveStartMs: 0, effectiveEndMs: 5 * 60000, clipDurationMs: 5 * 60000 });
  });

  it('none normalizes to (0, probedDurationMs) -- unchanged default behavior', () => {
    const r = resolveTrimWindow({}, 42 * 60000, HOUR);
    expect(r).toEqual({ effectiveStartMs: 0, effectiveEndMs: 42 * 60000, clipDurationMs: 42 * 60000 });
  });

  it('rejects start beyond probed duration', () => {
    expect(() => resolveTrimWindow({ startMs: 65 * 60000 }, 60 * 60000, HOUR)).toThrow(/beyond the video/);
  });

  it('clamps end beyond probed duration and returns a warning', () => {
    const r = resolveTrimWindow({ endMs: 70 * 60000 }, 60 * 60000, HOUR);
    expect(r.effectiveEndMs).toBe(60 * 60000);
    expect(r.warning).toMatch(/clamped/);
  });

  it('rejects a zero-length clip produced only after clamping (start==end after normalization)', () => {
    expect(() => resolveTrimWindow({ startMs: 10 * 60000, endMs: 10 * 60000 }, HOUR, HOUR)).toThrow();
  });

  it('a short explicit --duration on a shorter-than-duration video clamps to a positive, non-zero clip (independent guard, not redundant)', () => {
    const r = resolveTrimWindow({ durationMs: 5 * 60000 }, 3 * 60000, HOUR);
    expect(r.effectiveEndMs).toBe(3 * 60000);
    expect(r.clipDurationMs).toBe(3 * 60000);
  });

  it('rejects clip duration exceeding the max clip duration cap', () => {
    expect(() => resolveTrimWindow({ durationMs: 20 * 60000 }, HOUR, 10 * 60000)).toThrow(
      /exceeds max duration/
    );
  });

  it('uncapped-by-trim: with no trim, cap is checked against the full probed duration, unchanged from today', () => {
    expect(() => resolveTrimWindow({}, 20 * 60000, 10 * 60000)).toThrow(/exceeds max duration/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/core/videoTimeRange.test.ts -t resolveTrimWindow`
Expected: FAIL — `resolveTrimWindow is not a function`

- [ ] **Step 3: Implement `resolveTrimWindow`**

```typescript
function formatMsAsClock(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export interface TrimResult {
  effectiveStartMs: number;
  effectiveEndMs: number;
  clipDurationMs: number;
  warning?: string;
}

/**
 * Phase 2: duration-dependent normalization/clamping, run per-video
 * immediately after probeVideo() succeeds. maxClipDurationMs is the
 * existing TRM_VIDEO_MAX_DURATION_MS cap, now checked against the
 * trimmed clip length rather than the raw probed duration.
 */
export function resolveTrimWindow(
  parsed: ParsedTrimOptions,
  probedDurationMs: number,
  maxClipDurationMs: number
): TrimResult {
  let effectiveStartMs: number;
  let effectiveEndMs: number;

  if (parsed.startMs !== undefined && parsed.endMs !== undefined) {
    effectiveStartMs = parsed.startMs;
    effectiveEndMs = parsed.endMs;
  } else if (parsed.startMs !== undefined && parsed.durationMs !== undefined) {
    effectiveStartMs = parsed.startMs;
    effectiveEndMs = parsed.startMs + parsed.durationMs;
  } else if (parsed.startMs !== undefined) {
    effectiveStartMs = parsed.startMs;
    effectiveEndMs = probedDurationMs;
  } else if (parsed.endMs !== undefined) {
    effectiveStartMs = 0;
    effectiveEndMs = parsed.endMs;
  } else if (parsed.durationMs !== undefined) {
    effectiveStartMs = 0;
    effectiveEndMs = parsed.durationMs;
  } else {
    effectiveStartMs = 0;
    effectiveEndMs = probedDurationMs;
  }

  if (effectiveStartMs > probedDurationMs) {
    throw new Error(
      `trm ingest-dir: --start (${formatMsAsClock(effectiveStartMs)}) is beyond the video's duration (${formatMsAsClock(probedDurationMs)})`
    );
  }

  let warning: string | undefined;
  if (effectiveEndMs > probedDurationMs) {
    warning = `end=${formatMsAsClock(effectiveEndMs)} clamped to video duration ${formatMsAsClock(probedDurationMs)}`;
    effectiveEndMs = probedDurationMs;
  }

  const clipDurationMs = effectiveEndMs - effectiveStartMs;
  if (clipDurationMs <= 0) {
    throw new Error(
      `trm ingest-dir: trim window produces a zero-length clip (start=${formatMsAsClock(effectiveStartMs)}, end=${formatMsAsClock(effectiveEndMs)})`
    );
  }

  if (clipDurationMs > maxClipDurationMs) {
    throw new Error(
      `trm ingest-dir: clip exceeds max duration (${clipDurationMs}ms > ${maxClipDurationMs}ms limit; set TRM_VIDEO_MAX_DURATION_MS to override)`
    );
  }

  return { effectiveStartMs, effectiveEndMs, clipDurationMs, warning };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/core/videoTimeRange.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/videoTimeRange.ts tests/core/videoTimeRange.test.ts
git commit -m "feat(video): add Phase 2 trim normalization and clip-duration-cap clamping"
```

---

### Task 3: `extractFrames`/`buildFfmpegArgs` gain optional trim offset

**Files:**
- Modify: `src/ingestion/videoExtract/extractFrames.ts`
- Test: `tests/ingestion/videoExtract/extractFrames.test.ts`

**Interfaces:**
- Produces: `buildFfmpegArgs(filePath: string, durationMs: number, outputPattern: string, startMs?: number): string[]`, `extractFrames(filePath: string, durationMs: number, tempDir: string, startMs?: number): Promise<string[]>`.

**Design note:** `startMs === undefined` means "not trimmed" and must produce byte-identical args to today's baseline for all three strategies (verified below). `startMs` being a defined number (including `0`, e.g. an `--end`-only or `--duration`-only trim that starts at the file's beginning) means "trimming is active" — this is the only reliable signal that a `-t` bound is needed for the fps/select strategies, since those two branches don't otherwise self-bound their output length; conditioning `-t` on `startMs > 0` alone would silently leave `--end 10:00` (with no `--start`) unbounded.

- [ ] **Step 1: Write failing tests**

```typescript
// append inside describe('strategy selection (buildFfmpegArgs)', ...) in extractFrames.test.ts
it('startMs undefined: byte-identical to the untrimmed baseline for all three strategies', () => {
  for (const durationMs of [8000, 299000, 300000]) {
    const trimmed = buildFfmpegArgs('/in.mp4', durationMs, '/tmp/frame-%03d.jpg', undefined);
    const baseline = buildFfmpegArgs('/in.mp4', durationMs, '/tmp/frame-%03d.jpg');
    expect(trimmed).toEqual(baseline);
  }
});

it('midpoint strategy with startMs folds startMs into the single -ss (startMs + durationMs/2)', () => {
  const args = buildFfmpegArgs('/in.mp4', 8000, '/tmp/frame-%03d.jpg', 900000);
  const ssValues = args.filter((_, i) => args[i - 1] === '-ss');
  expect(args.filter((a) => a === '-ss')).toHaveLength(1);
  expect(args[args.indexOf('-ss') + 1]).toBe('904.000'); // 900 + 4
});

it('fps strategy with startMs=0 (e.g. --end-only trim) adds an explicit -ss 0.000 and a -t bound', () => {
  const args = buildFfmpegArgs('/in.mp4', 200000, '/tmp/frame-%03d.jpg', 0);
  expect(args[args.indexOf('-ss') + 1]).toBe('0.000');
  expect(args).toContain('-t');
  expect(args[args.indexOf('-t') + 1]).toBe('200.000');
});

it('select strategy with a positive startMs adds -ss startMs and a -t bound', () => {
  const args = buildFfmpegArgs('/in.mp4', 600000, '/tmp/frame-%03d.jpg', 900000);
  expect(args[args.indexOf('-ss') + 1]).toBe('900.000');
  expect(args[args.indexOf('-t') + 1]).toBe('600.000');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/ingestion/videoExtract/extractFrames.test.ts -t "startMs"`
Expected: FAIL — args don't match (no 4th param handling yet)

- [ ] **Step 3: Implement**

```typescript
// src/ingestion/videoExtract/extractFrames.ts -- replace buildFfmpegArgs and extractFrames

export async function extractFrames(
  filePath: string,
  durationMs: number,
  tempDir: string,
  startMs?: number
): Promise<string[]> {
  const ffmpegPath = process.env.TRM_FFMPEG_PATH || 'ffmpeg';
  const outputPattern = path.join(tempDir, FRAME_FILENAME_PATTERN);
  const args = buildFfmpegArgs(filePath, durationMs, outputPattern, startMs);

  try {
    await ffmpegPool(() =>
      execFileAsync(ffmpegPath, args, { timeout: getFfmpegTimeoutMs() })
    );
  } catch (err) {
    const detail = getErrorDetail(err);
    throw new Error(
      `Failed to extract frames from video file "${filePath}": ${detail}`
    );
  }

  const entries = await fs.promises.readdir(tempDir);
  const framePaths = entries
    .filter((name) => FRAME_FILENAME_REGEX.test(name))
    .sort()
    .map((name) => path.join(tempDir, name));

  if (framePaths.length === 0) {
    throw new Error(`ffmpeg produced no frames for video file "${filePath}"`);
  }

  return framePaths;
}

export function buildFfmpegArgs(
  filePath: string,
  durationMs: number,
  outputPattern: string,
  startMs?: number
): string[] {
  const isTrimmed = startMs !== undefined;
  const baseStartMs = startMs ?? 0;

  if (durationMs < MIDPOINT_THRESHOLD_MS) {
    const ssSeconds = ((baseStartMs + durationMs / 2) / 1000).toFixed(3);
    return [
      '-ss', ssSeconds,
      '-i', filePath,
      '-vframes', '1',
      '-vf', SCALE_FILTER,
      '-y',
      outputPattern
    ];
  }

  if (durationMs < FPS_THRESHOLD_MS) {
    const args = ['-i', filePath, '-vf', `fps=1/10,${SCALE_FILTER}`, '-vsync', 'vfr'];
    if (isTrimmed) {
      args.unshift('-ss', (baseStartMs / 1000).toFixed(3));
      args.push('-t', (durationMs / 1000).toFixed(3));
    }
    args.push('-y', outputPattern);
    return args;
  }

  const durationSeconds = durationMs / 1000;
  const stepSeconds = (durationSeconds / MAX_SELECT_FRAMES).toFixed(3);
  const args = [
    '-i', filePath,
    '-vf', `select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,${stepSeconds})',${SCALE_FILTER}`,
    '-vsync', 'vfr',
    '-frames:v', String(MAX_SELECT_FRAMES),
  ];
  if (isTrimmed) {
    args.unshift('-ss', (baseStartMs / 1000).toFixed(3));
    args.push('-t', durationSeconds.toFixed(3));
  }
  args.push('-y', outputPattern);
  return args;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/ingestion/videoExtract/extractFrames.test.ts`
Expected: PASS (all tests, including pre-existing ones)

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/videoExtract/extractFrames.ts tests/ingestion/videoExtract/extractFrames.test.ts
git commit -m "feat(video): thread optional trim startMs through extractFrames/buildFfmpegArgs"
```

---

### Task 4: `extractAudio` gains optional trim bound

**Files:**
- Modify: `src/ingestion/videoExtract/extractAudio.ts`
- Test: `tests/ingestion/videoExtract/extractAudio.test.ts`

**Interfaces:**
- Produces: `extractAudio(filePath: string, tempDir: string, trim?: { startMs: number; clipDurationMs: number }): Promise<string>`.

- [ ] **Step 1: Write failing tests**

```typescript
// append to extractAudio.test.ts
it('with no trim arg, produces the same args as today (no -ss/-t)', async () => {
  mockExecFile.mockImplementation(((cmd, args, options, cb: Function) => cb(null, { stdout: '', stderr: '' })) as any);
  await extractAudio('/in.mp4', '/tmp');
  const args = mockExecFile.mock.calls[0][1] as string[];
  expect(args).not.toContain('-ss');
  expect(args).not.toContain('-t');
});

it('with a trim arg, adds -ss before -i and -t bounding the clip', async () => {
  mockExecFile.mockImplementation(((cmd, args, options, cb: Function) => cb(null, { stdout: '', stderr: '' })) as any);
  await extractAudio('/in.mp4', '/tmp', { startMs: 900000, clipDurationMs: 600000 });
  const args = mockExecFile.mock.calls[0][1] as string[];
  expect(args[args.indexOf('-ss') + 1]).toBe('900.000');
  expect(args[args.indexOf('-t') + 1]).toBe('600.000');
  expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/ingestion/videoExtract/extractAudio.test.ts -t "trim"`
Expected: FAIL — third param not accepted / args unchanged

- [ ] **Step 3: Implement**

```typescript
// src/ingestion/videoExtract/extractAudio.ts -- replace extractAudio's signature and args build
export async function extractAudio(
  filePath: string,
  tempDir: string,
  trim?: { startMs: number; clipDurationMs: number }
): Promise<string> {
  const ffmpegPath = process.env.TRM_FFMPEG_PATH || 'ffmpeg';
  const outputPath = path.join(tempDir, AUDIO_FILENAME);

  const args = ['-i', filePath, '-map', '0:a:0', '-vn', '-ar', SAMPLE_RATE, '-ac', CHANNELS, '-f', 'wav', '-y', outputPath];
  if (trim) {
    args.unshift('-ss', (trim.startMs / 1000).toFixed(3));
    args.splice(args.indexOf('-y'), 0, '-t', (trim.clipDurationMs / 1000).toFixed(3));
  }

  try {
    await ffmpegPool(() =>
      execFileAsync(ffmpegPath, args, { timeout: getFfmpegAudioTimeoutMs() })
    );
  } catch (err) {
    const detail = getErrorDetail(err);
    throw new Error(
      `Failed to extract audio from video file "${filePath}": ${detail}`
    );
  }

  return outputPath;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/ingestion/videoExtract/extractAudio.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/videoExtract/extractAudio.ts tests/ingestion/videoExtract/extractAudio.test.ts
git commit -m "feat(video): thread optional trim bound through extractAudio"
```

---

### Task 5: Whisper segment parser + `transcribeAudioWithSegments`

**Files:**
- Modify: `src/ingestion/videoExtract/transcribe.ts`
- Test: `tests/ingestion/videoExtract/transcribe.test.ts`

**Interfaces:**
- Produces: `TranscriptSegment { startMs: number; endMs: number; text: string }`, `parseWhisperSegments(stdout: string): TranscriptSegment[]`, `transcribeAudioWithSegments(filePath: string, durationMs?: number): Promise<{ text: string; segments: TranscriptSegment[] }>`.

- [ ] **Step 1: Write failing mandatory parser unit tests (hand-built fixtures, no real whisper needed)**

```typescript
// append to transcribe.test.ts
import { parseWhisperSegments, transcribeAudioWithSegments } from '../../../src/ingestion/videoExtract/transcribe';

describe('parseWhisperSegments', () => {
  it('parses a single well-formed segment', () => {
    const stdout = '[00:00:00.000 --> 00:00:02.500]   Hello world\n';
    expect(parseWhisperSegments(stdout)).toEqual([
      { startMs: 0, endMs: 2500, text: 'Hello world' },
    ]);
  });

  it('parses multiple segments', () => {
    const stdout =
      '[00:00:00.000 --> 00:00:02.500]   Hello world\n' +
      '[00:00:02.500 --> 00:00:05.000]   How are you\n';
    expect(parseWhisperSegments(stdout)).toEqual([
      { startMs: 0, endMs: 2500, text: 'Hello world' },
      { startMs: 2500, endMs: 5000, text: 'How are you' },
    ]);
  });

  it('parses an hours component correctly', () => {
    const stdout = '[01:02:03.000 --> 01:02:05.000]   later on\n';
    const [seg] = parseWhisperSegments(stdout);
    expect(seg.startMs).toBe((1 * 3600 + 2 * 60 + 3) * 1000);
    expect(seg.endMs).toBe((1 * 3600 + 2 * 60 + 5) * 1000);
  });

  it('handles decimal precision variants and irregular spacing', () => {
    const stdout = '[00:00:01.010-->00:00:01.999]text with no leading space\n';
    expect(parseWhisperSegments(stdout)).toEqual([
      { startMs: 1010, endMs: 1999, text: 'text with no leading space' },
    ]);
  });

  it('skips unparseable lines rather than throwing', () => {
    const stdout =
      'whisper.cpp v1.5.0 loading model...\n' +
      '[00:00:00.000 --> 00:00:02.000]   real segment\n' +
      'system_info: n_threads = 4\n';
    expect(parseWhisperSegments(stdout)).toEqual([
      { startMs: 0, endMs: 2000, text: 'real segment' },
    ]);
  });

  it('accumulates continuation lines onto the most recently opened segment', () => {
    const stdout =
      '[00:00:00.000 --> 00:00:04.000]   a long segment that\n' +
      'wrapped across multiple\n' +
      'output lines\n';
    expect(parseWhisperSegments(stdout)).toEqual([
      { startMs: 0, endMs: 4000, text: 'a long segment that wrapped across multiple output lines' },
    ]);
  });

  it('returns an empty array for empty or fully-unparseable input', () => {
    expect(parseWhisperSegments('')).toEqual([]);
    expect(parseWhisperSegments('no segments here at all\n')).toEqual([]);
  });
});

describe('transcribeAudioWithSegments', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('omits -nt and returns joined text + parsed segments', async () => {
    mockExecFile.mockImplementation(
      ((cmd: string, args: any, options: any, cb: Function) => {
        cb(null, {
          stdout:
            '[00:00:00.000 --> 00:00:02.000]   Hello world\n' +
            '[00:00:02.000 --> 00:00:04.000]   Goodbye\n',
          stderr: '',
        });
      }) as any
    );

    const result = await transcribeAudioWithSegments('/path/to/audio.wav');

    expect(result.text).toBe('Hello world Goodbye');
    expect(result.segments).toHaveLength(2);
    const callArgs = mockExecFile.mock.calls[0][1] as string[];
    expect(callArgs).not.toContain('-nt');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/ingestion/videoExtract/transcribe.test.ts -t "parseWhisperSegments"`
Expected: FAIL — `parseWhisperSegments is not a function`

- [ ] **Step 3: Implement**

```typescript
// src/ingestion/videoExtract/transcribe.ts -- append below transcribeAudio()

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

const SEGMENT_LINE_PATTERN =
  /^\[(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})\]\s*(.*)$/;

function segmentTimestampToMs(h: string, m: string, s: string, ms: string): number {
  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(ms);
}

/**
 * Parses whisper.cpp's default timestamped stdout format into segments.
 * Defensive by design: skips any line that doesn't match the bracket
 * pattern (banner/log lines whisper.cpp also writes to stdout) rather than
 * throwing, and accumulates trailing non-bracket lines as continuation text
 * for the most recently opened segment (whisper wraps long segments across
 * multiple lines).
 */
export function parseWhisperSegments(stdout: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let current: TranscriptSegment | null = null;

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const match = SEGMENT_LINE_PATTERN.exec(line);
    if (match) {
      const [, h1, m1, s1, ms1, h2, m2, s2, ms2, text] = match;
      current = {
        startMs: segmentTimestampToMs(h1, m1, s1, ms1),
        endMs: segmentTimestampToMs(h2, m2, s2, ms2),
        text: text.trim(),
      };
      segments.push(current);
    } else if (current && line.trim().length > 0) {
      current.text = `${current.text} ${line.trim()}`.trim();
    }
  }

  return segments;
}

/**
 * Segment-aware sibling of transcribeAudio(), additive not a replacement --
 * only invoked when keyword filtering needs match windows. Omits whisper's
 * -nt flag so it emits timestamped segments instead of a plain string.
 */
export async function transcribeAudioWithSegments(
  filePath: string,
  durationMs?: number
): Promise<{ text: string; segments: TranscriptSegment[] }> {
  const whisperBin = process.env.TRM_WHISPER_BIN || DEFAULT_WHISPER_BIN;
  const modelPath = process.env.TRM_WHISPER_MODEL || getDefaultWhisperModelPath();
  const timeoutMs = computeTimeoutMs(durationMs);

  const args = ['-m', modelPath, '-f', filePath];

  let stdout: string;
  try {
    const result = await whisperPool(() =>
      execFileAsync(whisperBin, args, { timeout: timeoutMs })
    );
    stdout = result.stdout;
  } catch (err) {
    const detail = getErrorDetail(err);
    if (isTimeoutError(err)) {
      throw new Error(
        `Whisper transcription timed out after ${timeoutMs}ms for file "${filePath}": ${detail}`
      );
    }
    throw new Error(
      `Whisper transcription process failed for file "${filePath}": ${detail}`
    );
  }

  const segments = parseWhisperSegments(stdout);
  const text = segments.map((s) => s.text).join(' ').trim();
  return { text, segments };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/ingestion/videoExtract/transcribe.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/videoExtract/transcribe.ts tests/ingestion/videoExtract/transcribe.test.ts
git commit -m "feat(video): add whisper segment parser and transcribeAudioWithSegments"
```

**Note for a later real-binary smoke pass (not part of this plan's task list — track as a follow-up mirroring `tests/smoke/videoPipeline.smoke.test.ts`'s `TRM_SMOKE_VIDEO=1` opt-in pattern):** run `parseWhisperSegments` against genuine `whisper-cli` stdout from a short real fixture to confirm the hand-built fixtures above actually match real output shape.

---

### Task 6: Keyword normalization + match-window computation

**Files:**
- Create: `src/ingestion/videoExtract/keywordFilter.ts`
- Test: `tests/ingestion/videoExtract/keywordFilter.test.ts`

**Interfaces:**
- Consumes: `TranscriptSegment` (Task 5, from `transcribe.ts`).
- Produces: `KEYWORD_MATCH_PADDING_MS = 15000`, `normalizeKeywords(raw: string[]): string[]`, `computeKeywordWindows(segments: TranscriptSegment[], keywords: string[], clipDurationMs: number): { windows: Array<[number, number]>; matched: boolean }`, `frameInWindows(timestampMs: number, windows: Array<[number, number]>): boolean`.

- [ ] **Step 1: Write failing tests**

```typescript
// tests/ingestion/videoExtract/keywordFilter.test.ts
import {
  normalizeKeywords,
  computeKeywordWindows,
  frameInWindows,
  KEYWORD_MATCH_PADDING_MS,
} from '../../../src/ingestion/videoExtract/keywordFilter';
import { TranscriptSegment } from '../../../src/ingestion/videoExtract/transcribe';

describe('normalizeKeywords', () => {
  it('trims, lowercases, strips punctuation, drops empties, dedupes', () => {
    expect(normalizeKeywords([' Car ', 'CAR!', 'accident,', '', '   '])).toEqual(['car', 'accident']);
  });
});

describe('computeKeywordWindows', () => {
  const clipDurationMs = 100000;

  it('matches whole words only, case-folded (not substrings)', () => {
    const segments: TranscriptSegment[] = [
      { startMs: 20000, endMs: 22000, text: 'A car crashed here' },
      { startMs: 40000, endMs: 42000, text: 'This is scary and a cartoon' },
    ];
    const { windows, matched } = computeKeywordWindows(segments, ['car'], clipDurationMs);
    expect(matched).toBe(true);
    expect(windows).toEqual([[20000 - KEYWORD_MATCH_PADDING_MS, 22000 + KEYWORD_MATCH_PADDING_MS]]);
  });

  it('unions windows across multiple matched segments', () => {
    const segments: TranscriptSegment[] = [
      { startMs: 10000, endMs: 11000, text: 'car' },
      { startMs: 50000, endMs: 51000, text: 'accident' },
    ];
    const { windows, matched } = computeKeywordWindows(segments, ['car', 'accident'], clipDurationMs);
    expect(matched).toBe(true);
    expect(windows).toHaveLength(2);
  });

  it('clamps windows to [0, clipDurationMs]', () => {
    const segments: TranscriptSegment[] = [{ startMs: 1000, endMs: 2000, text: 'car' }];
    const { windows } = computeKeywordWindows(segments, ['car'], clipDurationMs);
    expect(windows[0][0]).toBe(0);
  });

  it('an empty keyword list matches nothing', () => {
    const segments: TranscriptSegment[] = [{ startMs: 1000, endMs: 2000, text: 'car' }];
    const { windows, matched } = computeKeywordWindows(segments, [], clipDurationMs);
    expect(matched).toBe(false);
    expect(windows).toEqual([]);
  });

  it('zero matches across a real transcript returns matched: false', () => {
    const segments: TranscriptSegment[] = [{ startMs: 1000, endMs: 2000, text: 'nothing relevant here' }];
    const { matched } = computeKeywordWindows(segments, ['car'], clipDurationMs);
    expect(matched).toBe(false);
  });
});

describe('frameInWindows', () => {
  it('true when inside a window, false outside', () => {
    expect(frameInWindows(5000, [[1000, 10000]])).toBe(true);
    expect(frameInWindows(15000, [[1000, 10000]])).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/ingestion/videoExtract/keywordFilter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```typescript
// src/ingestion/videoExtract/keywordFilter.ts
import { TranscriptSegment } from './transcribe';

export const KEYWORD_MATCH_PADDING_MS = 15000;

export function normalizeKeywords(raw: string[]): string[] {
  const set = new Set<string>();
  for (const entry of raw) {
    const cleaned = entry.trim().toLowerCase().replace(/^[^\w]+|[^\w]+$/g, '');
    if (cleaned.length > 0) set.add(cleaned);
  }
  return [...set];
}

export function computeKeywordWindows(
  segments: TranscriptSegment[],
  keywords: string[],
  clipDurationMs: number
): { windows: Array<[number, number]>; matched: boolean } {
  if (keywords.length === 0) return { windows: [], matched: false };

  const keywordSet = new Set(keywords);
  const windows: Array<[number, number]> = [];
  let matched = false;

  for (const segment of segments) {
    const words = segment.text.toLowerCase().split(/[^\w]+/).filter(Boolean);
    if (words.some((w) => keywordSet.has(w))) {
      matched = true;
      windows.push([
        Math.max(0, segment.startMs - KEYWORD_MATCH_PADDING_MS),
        Math.min(clipDurationMs, segment.endMs + KEYWORD_MATCH_PADDING_MS),
      ]);
    }
  }

  return { windows, matched };
}

export function frameInWindows(timestampMs: number, windows: Array<[number, number]>): boolean {
  return windows.some(([start, end]) => timestampMs >= start && timestampMs <= end);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/ingestion/videoExtract/keywordFilter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/videoExtract/keywordFilter.ts tests/ingestion/videoExtract/keywordFilter.test.ts
git commit -m "feat(video): add keyword normalization and match-window computation"
```

---

### Task 7: Auto-keyword derivation from `Fact.categories`

**Files:**
- Create: `src/ingestion/videoExtract/autoKeywords.ts`
- Test: `tests/ingestion/videoExtract/autoKeywords.test.ts`

**Interfaces:**
- Consumes: `manifestStore.listEntries(root, topicPath): ManifestEntry[]` and `manifestStore.readExtract<T>(root, topicPath, hash): T | null` (both existing, `src/core/manifestStore.ts`); `Fact` (`src/scoring/types.ts`).
- Produces: `deriveAutoKeywords(root: string, topicPath: string): string[]` — raw union, **not** normalized (normalization happens once at the call site alongside manual keywords, per Task 6's `normalizeKeywords`).

- [ ] **Step 1: Write failing tests**

```typescript
// tests/ingestion/videoExtract/autoKeywords.test.ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as manifestStore from '../../../src/core/manifestStore';
import { deriveAutoKeywords } from '../../../src/ingestion/videoExtract/autoKeywords';

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trm-autokeywords-'));
}

describe('deriveAutoKeywords', () => {
  it('unions Fact.categories across every done manifest entry for the topic', () => {
    const root = makeRoot();
    manifestStore.markDone(root, 'topic1', 'hash-a', '/a.mp4');
    manifestStore.writeExtract(root, 'topic1', 'hash-a', {
      facts: [{ id: 'FCT-1', text: 't', source_id: 'SRC-1', confidence: 0.9, categories: ['car', 'accident'] }],
      summary: '',
    });
    manifestStore.markDone(root, 'topic1', 'hash-b', '/b.mp4');
    manifestStore.writeExtract(root, 'topic1', 'hash-b', {
      facts: [
        { id: 'FCT-2', text: 't', source_id: 'SRC-2', confidence: 0.9, categories: ['accident', 'interview'] },
      ],
      summary: '',
    });

    expect(new Set(deriveAutoKeywords(root, 'topic1'))).toEqual(new Set(['car', 'accident', 'interview']));
  });

  it('excludes entries that are not status: done', () => {
    const root = makeRoot();
    manifestStore.markFailed(root, 'topic1', 'hash-c', '/c.mp4', 'boom');
    manifestStore.writeExtract(root, 'topic1', 'hash-c', {
      facts: [{ id: 'FCT-3', text: 't', source_id: 'SRC-3', confidence: 0.9, categories: ['should-not-appear'] }],
      summary: '',
    });

    expect(deriveAutoKeywords(root, 'topic1')).toEqual([]);
  });

  it('drops empty-string category entries', () => {
    const root = makeRoot();
    manifestStore.markDone(root, 'topic1', 'hash-d', '/d.mp4');
    manifestStore.writeExtract(root, 'topic1', 'hash-d', {
      facts: [{ id: 'FCT-4', text: 't', source_id: 'SRC-4', confidence: 0.9, categories: ['valid', ''] }],
      summary: '',
    });

    expect(deriveAutoKeywords(root, 'topic1')).toEqual(['valid']);
  });

  it('returns an empty array when the topic has no done entries at all', () => {
    const root = makeRoot();
    expect(deriveAutoKeywords(root, 'topic1')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/ingestion/videoExtract/autoKeywords.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```typescript
// src/ingestion/videoExtract/autoKeywords.ts
import * as manifestStore from '../../core/manifestStore';
import { Fact } from '../../scoring/types';

interface ExtractPayload {
  facts: Fact[];
  summary: string;
}

/**
 * Live-reads each done entry's per-hash extract payload (not extract.json,
 * which is a regenerated cache that can be stale relative to these).
 */
export function deriveAutoKeywords(root: string, topicPath: string): string[] {
  const doneEntries = manifestStore.listEntries(root, topicPath).filter((e) => e.status === 'done');
  const categories = new Set<string>();

  for (const entry of doneEntries) {
    const payload = manifestStore.readExtract<ExtractPayload>(root, topicPath, entry.hash);
    if (!payload) continue;
    for (const fact of payload.facts) {
      for (const category of fact.categories ?? []) {
        if (category.trim().length > 0) categories.add(category);
      }
    }
  }

  return [...categories];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/ingestion/videoExtract/autoKeywords.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ingestion/videoExtract/autoKeywords.ts tests/ingestion/videoExtract/autoKeywords.test.ts
git commit -m "feat(video): derive auto-keywords from live Fact.categories across a topic's done entries"
```

---

### Task 8: Extend persistence schemas — partial-progress fingerprint, failedStore videoOptions, videoMetricsLog fields, envelope videoProcessing

**Files:**
- Modify: `src/core/videoPartialProgress.ts`
- Modify: `src/core/failedStore.ts`
- Modify: `src/core/videoMetricsLog.ts`
- Modify: `src/core/rawSource.ts`
- Test: `tests/core/videoPartialProgress.test.ts` (extend existing file)
- Test: `tests/core/failedStore.test.ts` (create if it doesn't already exist)

**Interfaces:**
- Produces: `KeywordSource = 'manual' | 'auto' | 'manual+auto' | 'none'` (defined once, in `videoPartialProgress.ts`, imported by the other three), `computeOptionsFingerprint(input: { effectiveStartMs: number; effectiveEndMs: number; keywordsUsed: string[]; keywordSource: KeywordSource }): string`, `VideoPartialProgress { optionsFingerprint: string; transcript?: string; transcriptSegments?: TranscriptSegment[]; frameAnalyses?: FrameAnalysis[] }`, `VideoFailureOptions { startMs?: number; endMs?: number; keywords?: string[]; keywordSource?: KeywordSource }`, `FailedEntry.videoOptions?: VideoFailureOptions`, `appendFailure(root, topicPath, hash, sourcePath, error, videoOptions?: VideoFailureOptions): void`, `KeywordFilterOutcome = 'not-requested' | 'filtered' | 'fallback-no-match' | 'fallback-no-audio'`, extended `VideoMetricsEntry`, `VideoProcessingMetadata`, extended `RawSourceEnvelope`.

- [ ] **Step 1: Write failing tests for the fingerprint round-trip (update the existing `videoPartialProgress.test.ts`'s write/read test, since `optionsFingerprint` becomes a required field)**

```typescript
// tests/core/videoPartialProgress.test.ts -- replace the "writes and reads back progress for a given hash" test body
it('writes and reads back progress for a given hash', () => {
  const root = makeRoot();
  const progress = {
    optionsFingerprint: computeOptionsFingerprint({
      effectiveStartMs: 0,
      effectiveEndMs: 60000,
      keywordsUsed: [],
      keywordSource: 'none' as const,
    }),
    transcript: 'hello world',
    frameAnalyses: [{ timestampMs: 0, labels: [{ description: 'x', score: 0.5 }] }],
  };
  writeVideoPartialProgress(root, 'abc123', progress);

  expect(readVideoPartialProgress(root, 'abc123')).toEqual(progress);
});

// also update the two other writeVideoPartialProgress(...) calls in this file
// (the 'keys progress independently per hash' and 'returns null after clearing'
// tests) to include a computeOptionsFingerprint(...)-produced optionsFingerprint,
// same pattern as above.

// new describe block, appended to the file:
describe('computeOptionsFingerprint', () => {
  it('is stable regardless of keywordsUsed input ordering', () => {
    const a = computeOptionsFingerprint({
      effectiveStartMs: 0,
      effectiveEndMs: 1000,
      keywordsUsed: ['b', 'a'],
      keywordSource: 'manual',
    });
    const b = computeOptionsFingerprint({
      effectiveStartMs: 0,
      effectiveEndMs: 1000,
      keywordsUsed: ['a', 'b'],
      keywordSource: 'manual',
    });
    expect(a).toBe(b);
  });

  it('differs when effectiveStartMs/effectiveEndMs differ', () => {
    const a = computeOptionsFingerprint({ effectiveStartMs: 0, effectiveEndMs: 1000, keywordsUsed: [], keywordSource: 'none' });
    const b = computeOptionsFingerprint({ effectiveStartMs: 500, effectiveEndMs: 1000, keywordsUsed: [], keywordSource: 'none' });
    expect(a).not.toBe(b);
  });

  it('differs when keywordsUsed or keywordSource differ', () => {
    const base = { effectiveStartMs: 0, effectiveEndMs: 1000 };
    const a = computeOptionsFingerprint({ ...base, keywordsUsed: ['car'], keywordSource: 'manual' });
    const b = computeOptionsFingerprint({ ...base, keywordsUsed: ['car', 'accident'], keywordSource: 'manual' });
    const c = computeOptionsFingerprint({ ...base, keywordsUsed: ['car'], keywordSource: 'auto' });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});
```

Add the import at the top of the test file: `import { readVideoPartialProgress, writeVideoPartialProgress, clearVideoPartialProgress, computeOptionsFingerprint } from '../../src/core/videoPartialProgress';`

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/core/videoPartialProgress.test.ts`
Expected: FAIL — `computeOptionsFingerprint is not a function`, and the pre-existing tests now fail type-checking without `optionsFingerprint`

- [ ] **Step 3: Implement `videoPartialProgress.ts` changes**

```typescript
// src/core/videoPartialProgress.ts -- add near the top, above VideoPartialProgress
import { TranscriptSegment } from '../ingestion/videoExtract/transcribe';

export type KeywordSource = 'manual' | 'auto' | 'manual+auto' | 'none';

export interface VideoOptionsFingerprintInput {
  effectiveStartMs: number;
  effectiveEndMs: number;
  keywordsUsed: string[];
  keywordSource: KeywordSource;
}

export function computeOptionsFingerprint(input: VideoOptionsFingerprintInput): string {
  return JSON.stringify({
    effectiveStartMs: input.effectiveStartMs,
    effectiveEndMs: input.effectiveEndMs,
    keywordsUsed: [...input.keywordsUsed].sort(),
    keywordSource: input.keywordSource,
  });
}

// -- replace the existing VideoPartialProgress interface with:
export interface VideoPartialProgress {
  optionsFingerprint: string;
  transcript?: string;
  transcriptSegments?: TranscriptSegment[];
  frameAnalyses?: FrameAnalysis[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/core/videoPartialProgress.test.ts`
Expected: PASS

- [ ] **Step 5: Write failing tests for `failedStore`'s new `videoOptions` param (create `tests/core/failedStore.test.ts` if none exists — check first with `ls tests/core/failedStore.test.ts`)**

```typescript
// tests/core/failedStore.test.ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendFailure, readFailed } from '../../src/core/failedStore';

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trm-failedstore-'));
}

describe('failedStore videoOptions', () => {
  it('records videoOptions when provided', () => {
    const root = makeRoot();
    appendFailure(root, 'topic1', 'hash-a', '/a.mp4', 'boom', {
      startMs: 900000,
      endMs: 1500000,
      keywords: ['car', 'accident'],
      keywordSource: 'manual',
    });

    const [entry] = readFailed(root, 'topic1');
    expect(entry.videoOptions).toEqual({
      startMs: 900000,
      endMs: 1500000,
      keywords: ['car', 'accident'],
      keywordSource: 'manual',
    });
  });

  it('omits videoOptions when not provided (non-video failures unaffected)', () => {
    const root = makeRoot();
    appendFailure(root, 'topic1', 'hash-b', '/b.txt', 'boom');

    const [entry] = readFailed(root, 'topic1');
    expect(entry.videoOptions).toBeUndefined();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx jest tests/core/failedStore.test.ts`
Expected: FAIL — `appendFailure` doesn't accept a 6th argument yet (TS error / value silently dropped)

- [ ] **Step 7: Implement `failedStore.ts` changes**

```typescript
// src/core/failedStore.ts -- add near the top, extend FailedEntry, extend appendFailure
import { KeywordSource } from './videoPartialProgress';

export interface VideoFailureOptions {
  startMs?: number;
  endMs?: number;
  keywords?: string[];
  keywordSource?: KeywordSource;
}

export interface FailedEntry {
  hash: string;
  sourcePath: string;
  error: string;
  timestamp: string;
  videoOptions?: VideoFailureOptions;
}

export function appendFailure(
  root: string,
  topicPath: string,
  hash: string,
  sourcePath: string,
  error: string,
  videoOptions?: VideoFailureOptions
): void {
  const failedFile = readFailedFile(root, topicPath);
  failedFile.entries[hash] = {
    hash,
    sourcePath,
    error,
    timestamp: new Date().toISOString(),
    ...(videoOptions ? { videoOptions } : {}),
  };
  writeFileAtomic(failedPath(root, topicPath), JSON.stringify(failedFile, null, 2));
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx jest tests/core/failedStore.test.ts`
Expected: PASS

- [ ] **Step 9: Extend `videoMetricsLog.ts` and `rawSource.ts` (type-only additions, covered by Task 10/11's integration tests — no dedicated unit test needed for a plain interface extension)**

```typescript
// src/core/videoMetricsLog.ts -- add import and extend VideoMetricsEntry
import { KeywordSource } from './videoPartialProgress';

export type KeywordFilterOutcome = 'not-requested' | 'filtered' | 'fallback-no-match' | 'fallback-no-audio';

export interface VideoMetricsEntry {
  schema_version: 1;
  topic: string;
  file: string;
  outcome: 'success' | 'failure';
  ms: number;
  ts: string;
  durationMs?: number;
  hasAudioStream?: boolean;
  frameCount?: number;
  transcriptStatus?: 'transcribed' | 'empty' | 'no-audio';
  visionFailureCount?: number;
  error?: string;
  trimStartMs?: number;
  trimEndMs?: number;
  keywordsUsed?: string[];
  keywordSource?: KeywordSource;
  keywordFilterOutcome?: KeywordFilterOutcome;
  framesConsidered?: number;
  framesAnalyzed?: number;
}
```

```typescript
// src/core/rawSource.ts -- add import and VideoProcessingMetadata, extend RawSourceEnvelope
import { KeywordSource } from './videoPartialProgress';
import { KeywordFilterOutcome } from './videoMetricsLog';

export interface VideoProcessingMetadata {
  effectiveStartMs?: number;
  effectiveEndMs?: number;
  keywordsUsed?: string[];
  keywordSource?: KeywordSource;
  keywordFilterOutcome?: KeywordFilterOutcome;
}

export interface RawSourceEnvelope {
  sourceId: string;
  kind: 'text' | 'image' | 'video';
  capturedAt: string;
  text?: string;
  image?: RawImagePayload;
  ocrText?: string;
  frames?: { timestampMs: number; labels: Label[] }[];
  videoProcessing?: VideoProcessingMetadata;
}
```

- [ ] **Step 10: Run the full test suite to confirm no regressions**

Run: `npx jest tests/core/`
Expected: PASS (all core tests, including the two files just touched)

- [ ] **Step 11: Commit**

```bash
git add src/core/videoPartialProgress.ts src/core/failedStore.ts src/core/videoMetricsLog.ts src/core/rawSource.ts tests/core/videoPartialProgress.test.ts tests/core/failedStore.test.ts
git commit -m "feat(video): extend persistence schemas for trim/keyword options fingerprinting and observability"
```

---

### Task 9: CLI surface — new flags, Phase 1 wiring, exit code

**Files:**
- Modify: `src/cli/index.ts`
- Modify: `src/cli/commands/ingestDir.ts` (add fields to `IngestDirOptions` only — pipeline wiring is Tasks 10-11)
- Test: `tests/cli/ingestDirCli.test.ts` (new, mirrors `tests/cli/syncTreatmentCli.test.ts`'s real-subprocess pattern)

**Interfaces:**
- Consumes: `parseAndValidateTrimSyntax` (Task 1).
- Produces: `IngestDirOptions` gains `start?: string; end?: string; duration?: string; keywords?: string[]; autoKeywords?: boolean;`. `runIngestDir` throws synchronously (before any file/binary/network work) on: Phase 1 syntax violations, or any of the five new flags combined with `--retry-failed`.

- [ ] **Step 1: Write failing tests**

```typescript
// tests/cli/ingestDirCli.test.ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-ingestdir-cli-'));
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({ default_scoring_adapter: 'stub', promotion_threshold: 80, actor_source: 'cli-only', time_source: 'system' })
  );
  return root;
}

function runCli(args: string[], cwd: string): { status: number; output: string } {
  try {
    const output = execFileSync('ts-node', ['src/cli/index.ts', ...args], {
      cwd: path.resolve(__dirname, '..', '..'),
      encoding: 'utf-8',
      shell: true,
      env: { ...process.env, TRM_ALLOW_GIT_ROOT: '1' },
    });
    return { status: 0, output };
  } catch (err: any) {
    return { status: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('trm ingest-dir CLI -- trim/keyword flags', () => {
  it('rejects a malformed --start before touching any file (non-zero exit)', () => {
    const root = makeRoot();
    const dir = path.join(root, 'input-dir');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'doc.txt'), 'content', 'utf-8');

    const { status, output } = runCli(
      ['ingest-dir', 'topic1', '--dir', dir, '--stub', '--start', 'bogus'],
      root
    );

    expect(status).not.toBe(0);
    expect(output).toMatch(/Invalid time format/);
  });

  it('rejects --retry-failed combined with --start', () => {
    const root = makeRoot();
    const dir = path.join(root, 'input-dir');
    fs.mkdirSync(dir);

    const { status, output } = runCli(
      ['ingest-dir', 'topic1', '--dir', dir, '--stub', '--retry-failed', '--start', '00:10'],
      root
    );

    expect(status).not.toBe(0);
    expect(output).toMatch(/--retry-failed cannot be combined/);
  });

  it('exits non-zero when the batch has a failure', () => {
    const root = makeRoot();
    const dir = path.join(root, 'input-dir');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'bad.png'), 'not a real image', 'utf-8');

    const { status } = runCli(['ingest-dir', 'topic1', '--dir', dir, '--stub'], root);

    expect(status).not.toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/cli/ingestDirCli.test.ts`
Expected: FAIL — `--start`/`--retry-failed` combo not rejected yet; exit code stays 0 on a batch failure

- [ ] **Step 3: Implement**

```typescript
// src/cli/commands/ingestDir.ts -- extend IngestDirOptions
export interface IngestDirOptions {
  actor?: string;
  type?: string;
  title?: string;
  origin?: string;
  dir?: string;
  kind?: ImageKind;
  force?: boolean;
  retryFailed?: boolean;
  stub?: boolean;
  start?: string;
  end?: string;
  duration?: string;
  keywords?: string[];
  autoKeywords?: boolean;
}
```

```typescript
// src/cli/commands/ingestDir.ts -- add near the very top of runIngestDir's body, before any fs/network work
import { parseAndValidateTrimSyntax } from '../../core/videoTimeRange';

export async function runIngestDir(
  root: string,
  targetPath: string,
  cliArgs: IngestDirOptions = {},
  runnerOverride?: ExtractionRunner
): Promise<IngestDirSummary> {
  const hasNewVideoFlags =
    cliArgs.start !== undefined ||
    cliArgs.end !== undefined ||
    cliArgs.duration !== undefined ||
    cliArgs.keywords !== undefined ||
    !!cliArgs.autoKeywords;

  if (cliArgs.retryFailed && hasNewVideoFlags) {
    throw new Error(
      'trm ingest-dir: --retry-failed cannot be combined with --start/--end/--duration/--keywords/--auto-keywords (it always replays the options recorded at failure time)'
    );
  }

  const parsedTrim = parseAndValidateTrimSyntax({
    start: cliArgs.start,
    end: cliArgs.end,
    duration: cliArgs.duration,
  });

  // ... existing body continues unchanged (actor resolution, etc.) --
  // parsedTrim is threaded into the per-video loop in Task 10.
```

```typescript
// src/cli/index.ts -- extend the ingest-dir command
program
  .command('ingest-dir <path>')
  .option('--actor <actor>')
  .option('--type <type>')
  .option('--title <title>')
  .option('--origin <origin>')
  .option('--dir <dir>')
  .option('--kind <kind>')
  .option('--force')
  .option('--retry-failed')
  .option('--stub')
  .option('--start <time>', 'trim start, HH:MM:SS or MM:SS')
  .option('--end <time>', 'trim end, HH:MM:SS or MM:SS')
  .option('--duration <time>', 'trim duration, HH:MM:SS or MM:SS')
  .option('--keywords <list>', 'comma-separated', (v) => v.split(','))
  .option('--auto-keywords', 'derive keywords from the target topic\'s existing Fact.categories')
  .action(async (path, opts) => {
    try {
      const summary = await runIngestDir(root, path, opts);
      console.log(JSON.stringify(summary, null, 2));
      if (summary.failureCount > 0) process.exitCode = 1;
    } catch (err) {
      console.error(`[ingest-dir] ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/cli/ingestDirCli.test.ts`
Expected: PASS

- [ ] **Step 5: Run the existing `ingestDir.test.ts` suite to confirm no regression**

Run: `npx jest tests/cli/ingestDir.test.ts`
Expected: PASS (every existing test still passes unchanged — none of them pass the five new flags, so `hasNewVideoFlags` is always `false` and `parsedTrim` is always `{}`)

- [ ] **Step 6: Commit**

```bash
git add src/cli/index.ts src/cli/commands/ingestDir.ts tests/cli/ingestDirCli.test.ts
git commit -m "feat(video): wire --start/--end/--duration/--keywords/--auto-keywords CLI flags, Phase 1 validation, and ingest-dir exit code"
```

---

### Task 10: Wire trim into the video pipeline (legacy concurrent path only, no keyword fork yet)

**Files:**
- Modify: `src/cli/commands/ingestDir.ts`
- Test: `tests/cli/ingestDir.test.ts` (extend)

**Interfaces:**
- Consumes: `resolveTrimWindow` (Task 2), `extractFrames(..., startMs?)` (Task 3), `extractAudio(..., trim?)` (Task 4), `computeOptionsFingerprint` (Task 8), `VideoFailureOptions` (Task 8).
- Produces: per-video `videoOptions` (trim-only, `keywords`/`keywordSource` always omitted at this task) recorded on `failedStore.appendFailure`; `trimStartMs`/`trimEndMs` recorded on `videoMetricsLog`; `videoProcessing.effectiveStartMs`/`effectiveEndMs` recorded on the envelope. Keyword fields (`keywordsUsed`, `keywordSource`, `keywordFilterOutcome`, `framesConsidered`, `framesAnalyzed`) are set to their "not requested" defaults here and wired for real in Task 11.

This task deliberately keeps the **legacy fully-concurrent `Promise.allSettled` structure untouched** — trimming only changes *what* gets passed to `extractFrames`/`extractAudio`/the cap check, not *how* the two branches run.

- [ ] **Step 1: Write failing tests**

```typescript
// append inside describe('video pipeline (Task 5.3)', ...) in tests/cli/ingestDir.test.ts

it('--start/--end trims what reaches extractFrames/extractAudio/transcribeAudio, and the cap check applies to the clip not the full file', async () => {
  const root = makeRoot();
  runCreate(root, 'topic1', { actor: 'ACTOR-001' });
  const dir = path.join(root, 'input-dir');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'trimmed.mp4'), 'fake mp4 bytes', 'utf-8');

  process.env.TRM_VIDEO_MAX_DURATION_MS = String(15 * 60 * 1000); // 15 min cap
  const spies = mockVideoPipeline({
    durationMs: 60 * 60 * 1000, // 60 min source -- would fail the cap untrimmed
    hasAudioStream: true,
    transcript: 'clip transcript',
    framePaths: ['frame-000.jpg'],
    frameAnalyses: [{ timestampMs: 0, labels: [] }],
  });
  const { runner } = makeRunSpyRunner();

  try {
    const summary = await runIngestDir(
      root,
      'topic1',
      { actor: 'ACTOR-001', dir, stub: true, start: '15:00', end: '25:00' },
      runner
    );

    expect(summary.successCount).toBe(1);
    expect(spies.extractSpy).toHaveBeenCalledWith(
      path.join(dir, 'trimmed.mp4'),
      10 * 60 * 1000, // clipDurationMs
      expect.any(String),
      15 * 60 * 1000 // effectiveStartMs
    );
    expect(spies.extractAudioSpy).toHaveBeenCalledWith(
      path.join(dir, 'trimmed.mp4'),
      expect.any(String),
      { startMs: 15 * 60 * 1000, clipDurationMs: 10 * 60 * 1000 }
    );
    expect(spies.transcribeSpy).toHaveBeenCalledWith(expect.any(String), 10 * 60 * 1000);
  } finally {
    delete process.env.TRM_VIDEO_MAX_DURATION_MS;
    restoreVideoPipelineMocks(spies);
  }
});

it('a trim window beyond the video duration fails the video (Phase 2) without touching extractFrames/extractAudio', async () => {
  const root = makeRoot();
  runCreate(root, 'topic1', { actor: 'ACTOR-001' });
  const dir = path.join(root, 'input-dir');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'short.mp4'), 'fake mp4 bytes', 'utf-8');

  const spies = mockVideoPipeline({ durationMs: 60000, hasAudioStream: false });
  const { runner } = makeRunSpyRunner();

  const summary = await runIngestDir(
    root,
    'topic1',
    { actor: 'ACTOR-001', dir, stub: true, start: '05:00' },
    runner
  );

  expect(summary.failureCount).toBe(1);
  expect(spies.extractSpy).not.toHaveBeenCalled();
  expect(spies.extractAudioSpy).not.toHaveBeenCalled();

  const failed = failedStore.readFailed(root, 'topic1');
  expect(failed[0].error).toMatch(/beyond the video/);
  expect(failed[0].videoOptions).toEqual({ startMs: 5 * 60000 });

  restoreVideoPipelineMocks(spies);
});

it('records trimStartMs/trimEndMs on the success metrics entry and videoProcessing on the envelope', async () => {
  const root = makeRoot();
  runCreate(root, 'topic1', { actor: 'ACTOR-001' });
  const dir = path.join(root, 'input-dir');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'trimmed2.mp4'), 'fake mp4 bytes', 'utf-8');

  const spies = mockVideoPipeline({
    durationMs: 20 * 60000,
    hasAudioStream: false,
    framePaths: ['frame-000.jpg'],
    frameAnalyses: [{ timestampMs: 0, labels: [] }],
  });
  const { runner } = makeRunSpyRunner();

  await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true, start: '02:00', end: '05:00' }, runner);

  const metrics = readVideoMetrics(root);
  expect(metrics[0].trimStartMs).toBe(2 * 60000);
  expect(metrics[0].trimEndMs).toBe(5 * 60000);

  const envelope = readRawEnvelope(root, 'topic1', 'SRC-001');
  expect(envelope?.videoProcessing?.effectiveStartMs).toBe(2 * 60000);
  expect(envelope?.videoProcessing?.effectiveEndMs).toBe(5 * 60000);

  restoreVideoPipelineMocks(spies);
});

it('a fresh partial-progress cache under different trim options is not reused across a --force retry', async () => {
  const root = makeRoot();
  runCreate(root, 'topic1', { actor: 'ACTOR-001' });
  const dir = path.join(root, 'input-dir');
  fs.mkdirSync(dir);
  const filePath = path.join(dir, 'refingerprint.mp4');
  fs.writeFileSync(filePath, 'fake mp4 bytes', 'utf-8');

  const spies = mockVideoPipeline({
    durationMs: 60 * 60000,
    hasAudioStream: true,
    transcript: 'first-run transcript',
    frameAnalyses: [{ timestampMs: 0, labels: [] }],
  });
  spies.analyzeSpy.mockRejectedValueOnce(new Error('vision exploded'));
  const { runner } = makeRunSpyRunner();

  // First run (untrimmed) fails after transcript succeeded -- caches transcript
  // under the untrimmed fingerprint.
  await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true }, runner);
  expect(spies.transcribeSpy).toHaveBeenCalledTimes(1);

  // Retry with --force and a DIFFERENT trim -- must not reuse the cached
  // (differently-fingerprinted) transcript.
  const retrySummary = await runIngestDir(
    root,
    'topic1',
    { actor: 'ACTOR-001', dir, stub: true, force: true, start: '10:00', end: '20:00' },
    runner
  );

  expect(retrySummary.successCount).toBe(1);
  expect(spies.transcribeSpy).toHaveBeenCalledTimes(2); // rerun, not reused

  restoreVideoPipelineMocks(spies);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/cli/ingestDir.test.ts -t "trim"`
Expected: FAIL — `extractSpy`/`extractAudioSpy` called without trim args; no `trimStartMs`/`videoProcessing`/fingerprint behavior yet

- [ ] **Step 3: Implement — replace the `isVideo` block's setup and success/failure bookkeeping in `src/cli/commands/ingestDir.ts`**

```typescript
// src/cli/commands/ingestDir.ts -- new imports
import { parseAndValidateTrimSyntax, resolveTrimWindow } from '../../core/videoTimeRange';
import { computeOptionsFingerprint, KeywordSource } from '../../core/videoPartialProgress';
import { VideoFailureOptions } from '../../core/failedStore';
```

```typescript
// Inside runIngestDir, after parsedTrim is computed (Task 9) and after
// targetTopicPath is resolved, before the workItems.map(...) loop:
const keywordsFlagGiven = cliArgs.keywords !== undefined;
const autoKeywordsFlagGiven = !!cliArgs.autoKeywords;
let batchKeywordSource: KeywordSource = 'none';
if (keywordsFlagGiven && autoKeywordsFlagGiven) batchKeywordSource = 'manual+auto';
else if (autoKeywordsFlagGiven) batchKeywordSource = 'auto';
else if (keywordsFlagGiven) batchKeywordSource = 'manual';
// Auto-keyword derivation and normalizeKeywords() are wired in Task 11 --
// this task only needs keywordsUsed to exist as an empty array so the
// fingerprint/videoOptions plumbing below has a real (always-empty-for-now)
// value to record.
const batchKeywordsUsed: string[] = [];
```

```typescript
// Inside the isVideo block, replace the existing:
//   const { durationMs, hasAudioStream } = await probeVideo(filePath);
//   videoDurationMs = durationMs;
//   videoHasAudioStream = hasAudioStream;
//   const maxDurationMs = getVideoMaxDurationMs();
//   if (durationMs > maxDurationMs) { throw ... }
// with:

const { durationMs: probedDurationMs, hasAudioStream } = await probeVideo(filePath);
videoDurationMs = probedDurationMs;
videoHasAudioStream = hasAudioStream;

const trim = resolveTrimWindow(parsedTrim, probedDurationMs, getVideoMaxDurationMs());
videoEffectiveStartMs = trim.effectiveStartMs;
videoEffectiveEndMs = trim.effectiveEndMs;
if (trim.warning) {
  console.error(`[ingest-dir] ${path.basename(filePath)}: ${trim.warning}`);
}
const durationMs = trim.clipDurationMs; // clip-relative duration fed to the rest of the pipeline
const isTrimmed = trim.effectiveStartMs !== 0 || trim.effectiveEndMs !== probedDurationMs;

const optionsFingerprint = computeOptionsFingerprint({
  effectiveStartMs: trim.effectiveStartMs,
  effectiveEndMs: trim.effectiveEndMs,
  keywordsUsed: batchKeywordsUsed,
  keywordSource: batchKeywordSource,
});
```

```typescript
// Hoisted vars near the top of the per-file async fn (alongside
// videoDurationMs/videoHasAudioStream), so the outer catch can record
// whatever trim was resolved even if a later step fails:
let videoEffectiveStartMs: number | undefined;
let videoEffectiveEndMs: number | undefined;
```

```typescript
// The cachedProgress read/use must now respect the fingerprint:
const rawCachedProgress = readVideoPartialProgress(root, hash!);
const cachedProgress =
  rawCachedProgress?.optionsFingerprint === optionsFingerprint ? rawCachedProgress : null;
```

```typescript
// The two Promise.allSettled branches: thread startMs/trim through, and use
// the trimmed durationMs (clip length) everywhere durationMs was used before:
const [transcriptResult, frameResult] = await Promise.allSettled([
  cachedProgress?.transcript !== undefined
    ? Promise.resolve(cachedProgress.transcript)
    : hasAudioStream
    ? (async () => {
        await checkWhisperDeps();
        const audioPath = await extractAudio(
          filePath,
          tempDir,
          isTrimmed ? { startMs: trim.effectiveStartMs, clipDurationMs: durationMs } : undefined
        );
        return transcribeAudio(audioPath, durationMs);
      })()
    : Promise.resolve(''),
  cachedProgress?.frameAnalyses !== undefined
    ? Promise.resolve(cachedProgress.frameAnalyses)
    : (async () => {
        const framePaths = await extractFrames(
          filePath,
          durationMs,
          tempDir,
          isTrimmed ? trim.effectiveStartMs : undefined
        );
        const timestampsMs = computeFrameTimestamps(durationMs, framePaths.length);
        const analyzed = await analyzeFrames(framePaths, timestampsMs, analyzer);
        // Stored timestamps are original-video-relative -- offset exactly
        // once here, right after Vision analysis produces clip-relative
        // timestamps, before anything downstream (cache, envelope) sees them.
        return trim.effectiveStartMs === 0
          ? analyzed
          : analyzed.map((f) => ({ ...f, timestampMs: f.timestampMs + trim.effectiveStartMs }));
      })(),
]);
```

```typescript
// Where partial progress is written on rejection, include the fingerprint:
if (transcriptResult.status === 'rejected' || frameResult.status === 'rejected') {
  const progress: VideoPartialProgress = { optionsFingerprint };
  if (transcriptResult.status === 'fulfilled') progress.transcript = transcriptResult.value;
  if (frameResult.status === 'fulfilled') progress.frameAnalyses = frameResult.value;
  if (progress.transcript !== undefined || progress.frameAnalyses !== undefined) {
    writeVideoPartialProgress(root, hash!, progress);
  }
  if (transcriptResult.status === 'rejected') throw transcriptResult.reason;
  throw (frameResult as PromiseRejectedResult).reason;
}
```

```typescript
// appendVideoMetrics on success gains trim fields:
appendVideoMetrics(root, {
  schema_version: 1,
  topic: targetTopicPath,
  file: path.basename(filePath),
  outcome: 'success',
  ms: Date.now() - videoStartedAt,
  ts: new Date().toISOString(),
  durationMs: probedDurationMs,
  hasAudioStream,
  frameCount: frameAnalyses.length,
  transcriptStatus: !hasAudioStream ? 'no-audio' : transcript.trim().length > 0 ? 'transcribed' : 'empty',
  visionFailureCount: 0,
  trimStartMs: trim.effectiveStartMs,
  trimEndMs: trim.effectiveEndMs,
  keywordsUsed: batchKeywordsUsed,
  keywordSource: batchKeywordSource,
  keywordFilterOutcome: 'not-requested',
  framesConsidered: frameAnalyses.length,
  framesAnalyzed: frameAnalyses.length,
});
```

```typescript
// The envelope written on success gains videoProcessing:
const envelope: RawSourceEnvelope = {
  sourceId: entry.id,
  kind: 'video',
  capturedAt: new Date().toISOString(),
  text: composedText,
  frames: frameAnalyses,
  videoProcessing: {
    effectiveStartMs: trim.effectiveStartMs,
    effectiveEndMs: trim.effectiveEndMs,
    keywordsUsed: batchKeywordsUsed,
    keywordSource: batchKeywordSource,
    keywordFilterOutcome: 'not-requested',
  },
};
```

```typescript
// In the outer catch block, build videoOptions and pass it through to
// appendFailure -- only ever for isVideo, using whatever was learned before
// the failure (trim may be undefined if probeVideo/resolveTrimWindow itself
// threw):
} catch (err) {
  const errorMsg = (err as Error).message || String(err);
  console.error(`[ingest-dir] Error processing ${path.basename(filePath)}: ${errorMsg}`);

  let videoOptions: VideoFailureOptions | undefined;
  if (isVideo) {
    appendVideoMetrics(root, {
      schema_version: 1,
      topic: targetTopicPath,
      file: path.basename(filePath),
      outcome: 'failure',
      ms: Date.now() - videoStartedAt,
      ts: new Date().toISOString(),
      durationMs: videoDurationMs,
      hasAudioStream: videoHasAudioStream,
      error: errorMsg,
      trimStartMs: videoEffectiveStartMs,
      trimEndMs: videoEffectiveEndMs,
    });
    if (videoEffectiveStartMs !== undefined || videoEffectiveEndMs !== undefined) {
      videoOptions = { startMs: videoEffectiveStartMs, endMs: videoEffectiveEndMs };
    }
  }

  await storeLock(async () => {
    manifestStore.markFailed(root, targetTopicPath, hash!, filePath, errorMsg);
    failedStore.appendFailure(root, targetTopicPath, hash!, filePath, errorMsg, videoOptions);
  });

  failureCount++;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/cli/ingestDir.test.ts`
Expected: PASS (all existing + new tests in the file)

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/ingestDir.ts tests/cli/ingestDir.test.ts
git commit -m "feat(video): wire trim window into ingest-dir's legacy concurrent video pipeline"
```

---

### Task 11: Keyword pipeline fork (legacy vs staged) + fallback outcomes + retry-failed replay

**Files:**
- Modify: `src/cli/commands/ingestDir.ts`
- Test: `tests/cli/ingestDir.test.ts` (extend)

**Interfaces:**
- Consumes: `normalizeKeywords`, `computeKeywordWindows`, `frameInWindows`, `KEYWORD_MATCH_PADDING_MS` (Task 6); `deriveAutoKeywords` (Task 7); `transcribeAudioWithSegments`, `TranscriptSegment` (Task 5).
- Produces: real `keywordsUsed`/`keywordSource`/`keywordFilterOutcome` values (replacing Task 10's always-`'not-requested'` placeholders); the staged Stage A/B pipeline for the one case that needs it; `--retry-failed` replay of recorded `videoOptions.keywords`/`keywordSource` alongside the trim replay.

- [ ] **Step 1: Write failing tests**

```typescript
// append inside describe('video pipeline (Task 5.3)', ...) in tests/cli/ingestDir.test.ts

it('no keyword flags: legacy concurrent path, keywordFilterOutcome not-requested, framesConsidered === framesAnalyzed', async () => {
  const root = makeRoot();
  runCreate(root, 'topic1', { actor: 'ACTOR-001' });
  const dir = path.join(root, 'input-dir');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'plain.mp4'), 'fake mp4 bytes', 'utf-8');

  const spies = mockVideoPipeline({
    durationMs: 60000,
    hasAudioStream: true,
    transcript: 'plain transcript',
    framePaths: ['frame-000.jpg'],
    frameAnalyses: [{ timestampMs: 0, labels: [] }],
  });
  const { runner } = makeRunSpyRunner();

  await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true }, runner);

  expect(spies.transcribeSpy).toHaveBeenCalledTimes(1); // transcribeAudio, not transcribeAudioWithSegments
  const metrics = readVideoMetrics(root);
  expect(metrics[0].keywordFilterOutcome).toBe('not-requested');
  expect(metrics[0].framesConsidered).toBe(metrics[0].framesAnalyzed);

  restoreVideoPipelineMocks(spies);
});

it('--keywords normalizing to empty list: legacy concurrent path (no segments), fallback-no-match', async () => {
  const root = makeRoot();
  runCreate(root, 'topic1', { actor: 'ACTOR-001' });
  const dir = path.join(root, 'input-dir');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'emptykw.mp4'), 'fake mp4 bytes', 'utf-8');

  const spies = mockVideoPipeline({
    durationMs: 60000,
    hasAudioStream: true,
    transcript: 'irrelevant',
    framePaths: ['frame-000.jpg'],
    frameAnalyses: [{ timestampMs: 0, labels: [] }],
  });
  const { runner } = makeRunSpyRunner();

  await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true, keywords: ['', '   '] }, runner);

  expect(spies.transcribeSpy).toHaveBeenCalledTimes(1); // legacy transcribeAudio used, not segments
  const metrics = readVideoMetrics(root);
  expect(metrics[0].keywordFilterOutcome).toBe('fallback-no-match');
  expect(metrics[0].framesConsidered).toBe(metrics[0].framesAnalyzed);

  restoreVideoPipelineMocks(spies);
});

it('--keywords on a no-audio video: legacy concurrent path, fallback-no-audio', async () => {
  const root = makeRoot();
  runCreate(root, 'topic1', { actor: 'ACTOR-001' });
  const dir = path.join(root, 'input-dir');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'silentkw.mp4'), 'fake mp4 bytes', 'utf-8');

  const spies = mockVideoPipeline({
    durationMs: 60000,
    hasAudioStream: false,
    framePaths: ['frame-000.jpg'],
    frameAnalyses: [{ timestampMs: 0, labels: [] }],
  });
  const { runner } = makeRunSpyRunner();

  await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true, keywords: ['car'] }, runner);

  expect(spies.transcribeSpy).not.toHaveBeenCalled();
  const metrics = readVideoMetrics(root);
  expect(metrics[0].keywordFilterOutcome).toBe('fallback-no-audio');
  expect(metrics[0].framesConsidered).toBe(metrics[0].framesAnalyzed);

  restoreVideoPipelineMocks(spies);
});

it('--keywords with real segments and a match: staged pipeline, only matching frames reach analyzeFrames', async () => {
  const root = makeRoot();
  runCreate(root, 'topic1', { actor: 'ACTOR-001' });
  const dir = path.join(root, 'input-dir');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'matched.mp4'), 'fake mp4 bytes', 'utf-8');

  const probeSpy = jest.spyOn(videoProbe, 'probeVideo').mockResolvedValue({ durationMs: 100000, hasAudioStream: true });
  const whisperDepsSpy = jest.spyOn(videoDeps, 'checkWhisperDeps').mockResolvedValue();
  const extractAudioSpy = jest
    .spyOn(extractAudioModule, 'extractAudio')
    .mockImplementation(async (_f: string, tempDir: string) => path.join(tempDir, 'audio.wav'));
  const transcribeSegmentsSpy = jest
    .spyOn(transcribeModule, 'transcribeAudioWithSegments')
    .mockResolvedValue({
      text: 'a car passed by',
      segments: [{ startMs: 40000, endMs: 41000, text: 'a car passed by' }],
    });
  const extractSpy = jest
    .spyOn(extractFramesModule, 'extractFrames')
    .mockResolvedValue(['frame-far.jpg', 'frame-near.jpg']);
  const analyzeSpy = jest
    .spyOn(analyzeFramesModule, 'analyzeFrames')
    .mockImplementation(async (paths: string[], timestamps: number[]) =>
      paths.map((_, i) => ({ timestampMs: timestamps[i], labels: [] }))
    );

  const { runner } = makeRunSpyRunner();
  const summary = await runIngestDir(
    root,
    'topic1',
    { actor: 'ACTOR-001', dir, stub: true, keywords: ['car'] },
    runner
  );

  expect(summary.successCount).toBe(1);
  // analyzeFrames only receives frames the ingestDir code decided are inside
  // the match window -- assert it was called with a strict subset of the
  // full 2-frame extraction, not both.
  const analyzeCallArgs = analyzeSpy.mock.calls[0];
  expect((analyzeCallArgs[0] as string[]).length).toBeLessThan(2);

  const metrics = readVideoMetrics(root);
  expect(metrics[0].keywordFilterOutcome).toBe('filtered');
  expect(metrics[0].framesConsidered).toBe(2);
  expect(metrics[0].framesAnalyzed).toBeLessThan(2);
  expect(metrics[0].keywordsUsed).toEqual(['car']);
  expect(metrics[0].keywordSource).toBe('manual');

  probeSpy.mockRestore();
  whisperDepsSpy.mockRestore();
  extractAudioSpy.mockRestore();
  transcribeSegmentsSpy.mockRestore();
  extractSpy.mockRestore();
  analyzeSpy.mockRestore();
});

it('--keywords with real segments and zero matches: staged transcript ran, but fallback-no-match analyzes everything', async () => {
  const root = makeRoot();
  runCreate(root, 'topic1', { actor: 'ACTOR-001' });
  const dir = path.join(root, 'input-dir');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'nomatch.mp4'), 'fake mp4 bytes', 'utf-8');

  const probeSpy = jest.spyOn(videoProbe, 'probeVideo').mockResolvedValue({ durationMs: 60000, hasAudioStream: true });
  const whisperDepsSpy = jest.spyOn(videoDeps, 'checkWhisperDeps').mockResolvedValue();
  const extractAudioSpy = jest
    .spyOn(extractAudioModule, 'extractAudio')
    .mockImplementation(async (_f: string, tempDir: string) => path.join(tempDir, 'audio.wav'));
  const transcribeSegmentsSpy = jest
    .spyOn(transcribeModule, 'transcribeAudioWithSegments')
    .mockResolvedValue({ text: 'nothing relevant said here', segments: [{ startMs: 0, endMs: 5000, text: 'nothing relevant said here' }] });
  const extractSpy = jest.spyOn(extractFramesModule, 'extractFrames').mockResolvedValue(['a.jpg', 'b.jpg']);
  const analyzeSpy = jest
    .spyOn(analyzeFramesModule, 'analyzeFrames')
    .mockImplementation(async (paths: string[], timestamps: number[]) =>
      paths.map((_, i) => ({ timestampMs: timestamps[i], labels: [] }))
    );

  const { runner } = makeRunSpyRunner();
  await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true, keywords: ['spaceship'] }, runner);

  expect((analyzeSpy.mock.calls[0][0] as string[]).length).toBe(2); // all frames, not filtered
  const metrics = readVideoMetrics(root);
  expect(metrics[0].keywordFilterOutcome).toBe('fallback-no-match');
  expect(metrics[0].framesConsidered).toBe(2);
  expect(metrics[0].framesAnalyzed).toBe(2);

  probeSpy.mockRestore();
  whisperDepsSpy.mockRestore();
  extractAudioSpy.mockRestore();
  transcribeSegmentsSpy.mockRestore();
  extractSpy.mockRestore();
  analyzeSpy.mockRestore();
});

it('--auto-keywords derives from the topic\'s existing Fact.categories and unions with --keywords', async () => {
  const root = makeRoot();
  runCreate(root, 'topic1', { actor: 'ACTOR-001' });
  manifestStore.markDone(root, 'topic1', 'preexisting-hash', '/pre.txt');
  manifestStore.writeExtract(root, 'topic1', 'preexisting-hash', {
    facts: [{ id: 'FCT-1', text: 't', source_id: 'SRC-1', confidence: 0.9, categories: ['accident'] }],
    summary: '',
  });

  const dir = path.join(root, 'input-dir');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'auto.mp4'), 'fake mp4 bytes', 'utf-8');

  const probeSpy = jest.spyOn(videoProbe, 'probeVideo').mockResolvedValue({ durationMs: 60000, hasAudioStream: true });
  const whisperDepsSpy = jest.spyOn(videoDeps, 'checkWhisperDeps').mockResolvedValue();
  const extractAudioSpy = jest
    .spyOn(extractAudioModule, 'extractAudio')
    .mockImplementation(async (_f: string, tempDir: string) => path.join(tempDir, 'audio.wav'));
  const transcribeSegmentsSpy = jest
    .spyOn(transcribeModule, 'transcribeAudioWithSegments')
    .mockResolvedValue({ text: 'an accident happened', segments: [{ startMs: 0, endMs: 1000, text: 'an accident happened' }] });
  const extractSpy = jest.spyOn(extractFramesModule, 'extractFrames').mockResolvedValue(['a.jpg']);
  const analyzeSpy = jest.spyOn(analyzeFramesModule, 'analyzeFrames').mockResolvedValue([{ timestampMs: 0, labels: [] }]);

  const { runner } = makeRunSpyRunner();
  await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true, keywords: ['car'], autoKeywords: true }, runner);

  const metrics = readVideoMetrics(root);
  expect(metrics[0].keywordSource).toBe('manual+auto');
  expect(new Set(metrics[0].keywordsUsed)).toEqual(new Set(['car', 'accident']));

  probeSpy.mockRestore();
  whisperDepsSpy.mockRestore();
  extractAudioSpy.mockRestore();
  transcribeSegmentsSpy.mockRestore();
  extractSpy.mockRestore();
  analyzeSpy.mockRestore();
});

it('--retry-failed replays the recorded keywords/keywordSource from the failed attempt', async () => {
  const root = makeRoot();
  runCreate(root, 'topic1', { actor: 'ACTOR-001' });
  const dir = path.join(root, 'input-dir');
  fs.mkdirSync(dir);
  const filePath = path.join(dir, 'retrykw.mp4');
  fs.writeFileSync(filePath, 'fake mp4 bytes', 'utf-8');

  const probeSpy = jest.spyOn(videoProbe, 'probeVideo').mockResolvedValue({ durationMs: 60000, hasAudioStream: true });
  const whisperDepsSpy = jest.spyOn(videoDeps, 'checkWhisperDeps').mockResolvedValue();
  const extractAudioSpy = jest
    .spyOn(extractAudioModule, 'extractAudio')
    .mockImplementation(async (_f: string, tempDir: string) => path.join(tempDir, 'audio.wav'));
  const transcribeSegmentsSpy = jest
    .spyOn(transcribeModule, 'transcribeAudioWithSegments')
    .mockResolvedValue({ text: 'a car passed', segments: [{ startMs: 0, endMs: 1000, text: 'a car passed' }] });
  const extractSpy = jest.spyOn(extractFramesModule, 'extractFrames').mockResolvedValueOnce(['a.jpg']);
  extractSpy.mockRejectedValueOnce(new Error('ffmpeg exploded')); // first call fails
  const analyzeSpy = jest.spyOn(analyzeFramesModule, 'analyzeFrames').mockResolvedValue([{ timestampMs: 0, labels: [] }]);

  const { runner } = makeRunSpyRunner();
  await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, stub: true, keywords: ['car'] }, runner);

  const failed = failedStore.readFailed(root, 'topic1');
  expect(failed[0].videoOptions?.keywords).toEqual(['car']);
  expect(failed[0].videoOptions?.keywordSource).toBe('manual');

  extractSpy.mockResolvedValue(['a.jpg']); // fix the underlying problem
  const retrySummary = await runIngestDir(root, 'topic1', { actor: 'ACTOR-001', dir, retryFailed: true, stub: true }, runner);

  expect(retrySummary.successCount).toBe(1);
  expect(transcribeSegmentsSpy).toHaveBeenCalledTimes(2); // staged path used again on retry, per replayed keywordSource

  probeSpy.mockRestore();
  whisperDepsSpy.mockRestore();
  extractAudioSpy.mockRestore();
  transcribeSegmentsSpy.mockRestore();
  extractSpy.mockRestore();
  analyzeSpy.mockRestore();
});
```

Add `import * as transcribeModule from '../../src/ingestion/videoExtract/transcribe';` already exists; ensure `transcribeAudioWithSegments` is accessible on it (it is, since it's a named export of the same module already imported as `* as transcribeModule`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/cli/ingestDir.test.ts -t "keyword"`
Expected: FAIL — no pipeline fork yet, `transcribeAudioWithSegments` never called, all frames always analyzed

- [ ] **Step 3: Implement — pipeline fork in `src/cli/commands/ingestDir.ts`**

```typescript
// New imports
import { normalizeKeywords, computeKeywordWindows, frameInWindows } from '../../ingestion/videoExtract/keywordFilter';
import { deriveAutoKeywords } from '../../ingestion/videoExtract/autoKeywords';
import { transcribeAudioWithSegments } from '../../ingestion/videoExtract/transcribe';
```

```typescript
// Replace Task 10's placeholder batch-level keyword computation with the
// real thing (still before the workItems.map(...) loop):
const manualKeywords = cliArgs.keywords ?? [];
const autoKeywordsFlagGiven = !!cliArgs.autoKeywords;
const keywordsFlagGiven = cliArgs.keywords !== undefined;
let batchKeywordSource: KeywordSource = 'none';
if (keywordsFlagGiven && autoKeywordsFlagGiven) batchKeywordSource = 'manual+auto';
else if (autoKeywordsFlagGiven) batchKeywordSource = 'auto';
else if (keywordsFlagGiven) batchKeywordSource = 'manual';

const batchKeywordsUsed = normalizeKeywords([
  ...manualKeywords,
  ...(autoKeywordsFlagGiven ? deriveAutoKeywords(root, targetTopicPath) : []),
]);
```

```typescript
// IMPORTANT SCOPING NOTE: the outer per-file `catch` block (which builds
// videoOptions for appendFailure) needs to see these two values even when
// the failure happens before or during probeVideo/resolveTrimWindow. So --
// mirroring the existing videoDurationMs/videoHasAudioStream hoisting right
// after `const videoStartedAt = Date.now();`, near the top of the per-file
// async fn, OUTSIDE and BEFORE the `try { if (isVideo) { ... } }` block --
// hoist and assign these two right there (they don't need isVideo/hasAudioStream
// to be known yet; item.videoOptions is available for every work item):
const perVideoKeywordsUsed = cliArgs.retryFailed
  ? item.videoOptions?.keywords ?? []
  : batchKeywordsUsed;
const perVideoKeywordSource: KeywordSource = cliArgs.retryFailed
  ? item.videoOptions?.keywordSource ?? 'none'
  : batchKeywordSource;

// The rest of this task's code stays inside the isVideo block, immediately
// after the trim/fingerprint setup from Task 10 (which already computed
// durationMs = clip length, isTrimmed, hasAudioStream):
const useStagedPipeline = perVideoKeywordsUsed.length > 0 && hasAudioStream;
```

```typescript
// The per-video fingerprint (Task 10) must use the per-video values, not
// the raw batch ones -- replace:
//   keywordsUsed: batchKeywordsUsed, keywordSource: batchKeywordSource
// with:
const optionsFingerprint = computeOptionsFingerprint({
  effectiveStartMs: trim.effectiveStartMs,
  effectiveEndMs: trim.effectiveEndMs,
  keywordsUsed: perVideoKeywordsUsed,
  keywordSource: perVideoKeywordSource,
});
```

```typescript
// Replace the Promise.allSettled Stage A/B block entirely:
let keywordFilterOutcome: 'not-requested' | 'filtered' | 'fallback-no-match' | 'fallback-no-audio';
let framesConsidered = 0;
let transcript: string;
let frameAnalyses: FrameAnalysis[];

if (!useStagedPipeline) {
  // Legacy fully-concurrent path -- covers "not requested" and both
  // fallback rows (empty normalized list; no audio) decided up front.
  keywordFilterOutcome = !keywordsFlagGivenForThisVideo(perVideoKeywordSource)
    ? 'not-requested'
    : perVideoKeywordsUsed.length === 0
    ? 'fallback-no-match'
    : 'fallback-no-audio';

  const [transcriptResult, frameResult] = await Promise.allSettled([
    cachedProgress?.transcript !== undefined
      ? Promise.resolve(cachedProgress.transcript)
      : hasAudioStream
      ? (async () => {
          await checkWhisperDeps();
          const audioPath = await extractAudio(
            filePath,
            tempDir,
            isTrimmed ? { startMs: trim.effectiveStartMs, clipDurationMs: durationMs } : undefined
          );
          return transcribeAudio(audioPath, durationMs);
        })()
      : Promise.resolve(''),
    cachedProgress?.frameAnalyses !== undefined
      ? Promise.resolve(cachedProgress.frameAnalyses)
      : (async () => {
          const framePaths = await extractFrames(
            filePath,
            durationMs,
            tempDir,
            isTrimmed ? trim.effectiveStartMs : undefined
          );
          const timestampsMs = computeFrameTimestamps(durationMs, framePaths.length);
          const analyzed = await analyzeFrames(framePaths, timestampsMs, analyzer);
          return trim.effectiveStartMs === 0
            ? analyzed
            : analyzed.map((f) => ({ ...f, timestampMs: f.timestampMs + trim.effectiveStartMs }));
        })(),
  ]);

  if (transcriptResult.status === 'rejected' || frameResult.status === 'rejected') {
    const progress: VideoPartialProgress = { optionsFingerprint };
    if (transcriptResult.status === 'fulfilled') progress.transcript = transcriptResult.value;
    if (frameResult.status === 'fulfilled') progress.frameAnalyses = frameResult.value;
    if (progress.transcript !== undefined || progress.frameAnalyses !== undefined) {
      writeVideoPartialProgress(root, hash!, progress);
    }
    if (transcriptResult.status === 'rejected') throw transcriptResult.reason;
    throw (frameResult as PromiseRejectedResult).reason;
  }
  transcript = transcriptResult.value;
  frameAnalyses = frameResult.value;
  framesConsidered = frameAnalyses.length;
} else {
  // Staged pipeline -- the only case where a match window can change which
  // frames reach Vision.
  const [transcriptResult, frameResult] = await Promise.allSettled([
    cachedProgress?.transcript !== undefined && cachedProgress?.transcriptSegments !== undefined
      ? Promise.resolve({ text: cachedProgress.transcript, segments: cachedProgress.transcriptSegments })
      : (async () => {
          await checkWhisperDeps();
          const audioPath = await extractAudio(filePath, tempDir, { startMs: trim.effectiveStartMs, clipDurationMs: durationMs });
          return transcribeAudioWithSegments(audioPath, durationMs);
        })(),
    cachedProgress?.frameAnalyses !== undefined
      ? Promise.resolve({ framePaths: null, cached: cachedProgress.frameAnalyses })
      : (async () => {
          const framePaths = await extractFrames(filePath, durationMs, tempDir, trim.effectiveStartMs);
          return { framePaths, cached: null as FrameAnalysis[] | null };
        })(),
  ]);

  if (transcriptResult.status === 'rejected' || frameResult.status === 'rejected') {
    const progress: VideoPartialProgress = { optionsFingerprint };
    if (transcriptResult.status === 'fulfilled') {
      progress.transcript = transcriptResult.value.text;
      progress.transcriptSegments = transcriptResult.value.segments;
    }
    if (frameResult.status === 'fulfilled' && frameResult.value.cached) {
      progress.frameAnalyses = frameResult.value.cached;
    }
    if (progress.transcript !== undefined || progress.frameAnalyses !== undefined) {
      writeVideoPartialProgress(root, hash!, progress);
    }
    if (transcriptResult.status === 'rejected') throw transcriptResult.reason;
    throw (frameResult as PromiseRejectedResult).reason;
  }

  transcript = transcriptResult.value.text;
  const segments: TranscriptSegment[] = transcriptResult.value.segments;

  // Stage B: sequential, only reached once both Stage A branches fulfilled.
  if (frameResult.value.cached) {
    frameAnalyses = frameResult.value.cached;
    framesConsidered = frameAnalyses.length; // a cached full analysis was already fingerprint-matched
    keywordFilterOutcome = 'filtered'; // cache only ever holds a completed Stage B result under this fingerprint
  } else {
    const framePaths = frameResult.value.framePaths!;
    framesConsidered = framePaths.length;
    const allTimestampsMs = computeFrameTimestamps(durationMs, framePaths.length);
    const { windows, matched } = computeKeywordWindows(segments, perVideoKeywordsUsed, durationMs);

    let filteredPaths = framePaths;
    let filteredTimestamps = allTimestampsMs;
    if (matched) {
      const kept = allTimestampsMs
        .map((ts, i) => ({ ts, i }))
        .filter(({ ts }) => frameInWindows(ts, windows));
      filteredPaths = kept.map(({ i }) => framePaths[i]);
      filteredTimestamps = kept.map(({ ts }) => ts);
      keywordFilterOutcome = 'filtered';
    } else {
      keywordFilterOutcome = 'fallback-no-match';
    }

    const analyzed = await analyzeFrames(filteredPaths, filteredTimestamps, analyzer);
    frameAnalyses =
      trim.effectiveStartMs === 0
        ? analyzed
        : analyzed.map((f) => ({ ...f, timestampMs: f.timestampMs + trim.effectiveStartMs }));

    const progress: VideoPartialProgress = { optionsFingerprint, transcript, transcriptSegments: segments, frameAnalyses };
    writeVideoPartialProgress(root, hash!, progress);
  }
}

function keywordsFlagGivenForThisVideo(source: KeywordSource): boolean {
  return source !== 'none';
}
```

*(Note: `keywordsFlagGivenForThisVideo` is a tiny local helper — move it above `runIngestDir` alongside `computeFrameTimestamps`/`formatTimestamp` rather than declaring it inline inside the loop.)*

```typescript
// appendVideoMetrics / envelope's videoProcessing / keyword fields now use
// the real computed values instead of Task 10's placeholders:
appendVideoMetrics(root, {
  // ...same fields as Task 10...
  keywordsUsed: perVideoKeywordsUsed,
  keywordSource: perVideoKeywordSource,
  keywordFilterOutcome,
  framesConsidered,
  framesAnalyzed: frameAnalyses.length,
});

const envelope: RawSourceEnvelope = {
  // ...same fields as Task 10...
  videoProcessing: {
    effectiveStartMs: trim.effectiveStartMs,
    effectiveEndMs: trim.effectiveEndMs,
    keywordsUsed: perVideoKeywordsUsed,
    keywordSource: perVideoKeywordSource,
    keywordFilterOutcome,
  },
};
```

```typescript
// In the outer catch block, extend videoOptions to include keywords/source:
if (videoEffectiveStartMs !== undefined || videoEffectiveEndMs !== undefined || perVideoKeywordsUsed.length > 0 || perVideoKeywordSource !== 'none') {
  videoOptions = {
    startMs: videoEffectiveStartMs,
    endMs: videoEffectiveEndMs,
    keywords: perVideoKeywordsUsed.length > 0 ? perVideoKeywordsUsed : undefined,
    keywordSource: perVideoKeywordSource !== 'none' ? perVideoKeywordSource : undefined,
  };
}
```

```typescript
// FileWorkItem (near the top of runIngestDir) gains videoOptions so
// --retry-failed can replay it:
interface FileWorkItem {
  filePath: string;
  expectedHash?: string;
  videoOptions?: VideoFailureOptions;
}

// and the retryFailed branch that builds workItems:
if (cliArgs.retryFailed) {
  const failedEntries = failedStore.readFailed(root, targetTopicPath);
  workItems = failedEntries.map((e) => ({
    filePath: e.sourcePath,
    expectedHash: e.hash,
    videoOptions: e.videoOptions,
  }));
}
```

```typescript
// Per-video trim replay (extends Task 10's use of the batch-level
// parsedTrim): when retrying, use the item's recorded effective start/end
// directly as a start+end pair fed through resolveTrimWindow (re-validating
// against the current probe in case the file changed), instead of the
// batch-level parsedTrim (which is always {} during --retry-failed, per
// Task 9's mutual-exclusion check).
const perVideoParsedTrim = cliArgs.retryFailed
  ? item.videoOptions?.startMs !== undefined || item.videoOptions?.endMs !== undefined
    ? { startMs: item.videoOptions?.startMs ?? 0, endMs: item.videoOptions?.endMs }
    : {}
  : parsedTrim;

// ...and Task 10's `resolveTrimWindow(parsedTrim, ...)` call becomes:
const trim = resolveTrimWindow(perVideoParsedTrim, probedDurationMs, getVideoMaxDurationMs());
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/cli/ingestDir.test.ts`
Expected: PASS (every test in the file, including every pre-existing one from before this feature)

- [ ] **Step 5: Run the full test suite**

Run: `npx jest`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/ingestDir.ts tests/cli/ingestDir.test.ts
git commit -m "feat(video): fork keyword-filtered staged pipeline from the legacy concurrent path, wire fallback outcomes and --retry-failed replay"
```

---

### Task 12: Final spec-coverage pass

**Files:** none (verification only)

- [ ] **Step 1: Re-read the design doc's Testing section and confirm each bullet has a corresponding test**

Cross-check against `docs/superpowers/specs/2026-08-08-video-time-range-keyword-filter-design.md`'s `## Testing` section:
- Time-range normalization/clamping (all six shapes × boundary cases) — Task 2.
- Whisper segment parser (mandatory unit tests) — Task 5.
- Keyword matching (whole-word, case-folding, punctuation, empty-list, window union, clamping) — Task 6.
- Auto-keyword derivation (union, normalization, live-reads-not-extract.json) — Task 7.
- Integration tests (trim reduces pipeline inputs; keyword flags reduce analyzed frames; both fallback paths; `--retry-failed` + new flag rejected; `--retry-failed` alone replays; exit code 1) — Tasks 9, 10, 11.
- Pipeline fork routing (legacy path for fallback rows, not staged-then-discovered) — Task 11.
- Partial-progress fingerprint hit/miss — Task 10.

- [ ] **Step 2: Run the complete test suite one final time**

Run: `npx jest`
Expected: PASS, zero failures

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 4: Manually smoke-test `--help` output**

Run: `npx ts-node src/cli/index.ts ingest-dir --help`
Expected: lists `--start`, `--end`, `--duration`, `--keywords`, `--auto-keywords` alongside the existing flags

No commit for this task — it's a verification pass over work already committed in Tasks 1-11.