import { parseTimeString, parseAndValidateTrimSyntax, resolveTrimWindow } from '../../src/core/videoTimeRange';

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