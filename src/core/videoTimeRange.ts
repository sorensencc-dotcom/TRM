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