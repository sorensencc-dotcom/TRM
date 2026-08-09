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