const TIME_PART_PATTERN = /^\d+$/;

function formatMsAsClock(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

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