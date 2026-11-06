import { PppGap } from './types';

export class PppGapRegistry {
  private gaps = new Map<string, PppGap>();
  private counter = 0;

  /**
   * Registers a new open gap with a strictly compliant PPP-GAP-xx identifier.
   * Throws if any alien gap ID format (e.g. Cast Iron Charlie GAP-06) is supplied.
   */
  public createGap(borrowerName: string, reason: string, explicitId?: string): PppGap {
    let id: string;
    if (explicitId) {
      this.assertValidGapId(explicitId);
      id = explicitId;
    } else {
      this.counter++;
      const padded = String(this.counter).padStart(2, '0');
      id = `PPP-GAP-${padded}`;
    }

    const gap: PppGap = {
      id,
      topic: 'trm-ppp',
      borrower_name: borrowerName,
      status: 'OPEN',
      reason,
      created_at: new Date().toISOString(),
    };

    this.gaps.set(id, gap);
    return gap;
  }

  public getGap(id: string): PppGap | undefined {
    return this.gaps.get(id);
  }

  public listGaps(): PppGap[] {
    return Array.from(this.gaps.values());
  }

  public listOpenGaps(): PppGap[] {
    return this.listGaps().filter((g) => g.status === 'OPEN');
  }

  /**
   * A gap may only be resolved by presenting an official public record.
   * Non-match in an exclusion list does NOT resolve a gap.
   */
  public resolveGap(id: string, publicRecordReference: string): PppGap {
    const gap = this.gaps.get(id);
    if (!gap) {
      throw new Error(`PPP Gap not found: "${id}"`);
    }
    if (!publicRecordReference || publicRecordReference.trim().length === 0) {
      throw new Error(`Cannot resolve PPP Gap "${id}" without an official public record reference.`);
    }

    gap.status = 'RESOLVED';
    gap.reason = `${gap.reason} | Resolved by: ${publicRecordReference}`;
    return gap;
  }

  private assertValidGapId(id: string): void {
    if (!/^PPP-GAP-\d+$/i.test(id)) {
      throw new Error(
        `Invalid PPP Gap ID "${id}": violates PPP-GAP-xx namespace and cannot reference other topic gap IDs (e.g. GAP-06).`
      );
    }
  }
}
