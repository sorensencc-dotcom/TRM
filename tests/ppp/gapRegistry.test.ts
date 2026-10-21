import { PppGapRegistry } from '../../src/ppp/gapRegistry';

describe('PPP Texas - Gap Registry and Keep-Open Rules', () => {
  let registry: PppGapRegistry;

  beforeEach(() => {
    registry = new PppGapRegistry();
  });

  it('assigns strictly compliant PPP-GAP-xx identifiers', () => {
    const gap1 = registry.createGap('CYBERSOLVE IT INC', 'No match in current exclusion list; court records unverified.');
    const gap2 = registry.createGap('ACME VENTURES', 'Unresolved defendant link.');

    expect(gap1.id).toBe('PPP-GAP-01');
    expect(gap2.id).toBe('PPP-GAP-02');
    expect(gap1.status).toBe('OPEN');
  });

  it('rejects foreign gap IDs from other topics (e.g., Cast Iron Charlie GAP-06)', () => {
    expect(() => {
      registry.createGap('TEST BORROWER', 'Invalid ID reference', 'GAP-06');
    }).toThrow(/violates PPP-GAP-xx namespace/);

    expect(() => {
      registry.createGap('TEST BORROWER', 'Invalid ID reference', 'CIC-GAP-01');
    }).toThrow(/violates PPP-GAP-xx namespace/);
  });

  it('keeps gaps open and permits resolution only with official public records', () => {
    const gap = registry.createGap('SAMPLE BORROWER', 'Status unverified.');
    expect(gap.status).toBe('OPEN');

    // Attempting to resolve without public record reference fails
    expect(() => {
      registry.resolveGap(gap.id, '');
    }).toThrow(/without an official public record reference/);

    // Resolving with public record succeeds
    const resolved = registry.resolveGap(gap.id, 'PACER Docket 4:21-cr-00123 (SDTX)');
    expect(resolved.status).toBe('RESOLVED');
    expect(resolved.reason).toContain('PACER Docket');
  });
});
