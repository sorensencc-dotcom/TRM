import { assertTopicIsolation, TopicPayload } from '../../src/ppp/topicIsolation';
import { PppClaim } from '../../src/ppp/types';

describe('PPP Texas - Topic Isolation', () => {
  it('passes when PPP payload is strictly isolated to trm-ppp staging and namespace', () => {
    const validPppPayload: TopicPayload = {
      topic: 'trm-ppp',
      topicSlug: 'ppp-texas',
      outputPath: '_kb-sync-staging/trm-ppp/facts.nlm_pack.md',
      claims: [
        {
          id: 'PPP-CLAIM-4491747703',
          topic: 'trm-ppp',
          claim_type: 'PUBLIC_RECORD_FACT',
          verification_status: 'VERIFIED',
          text: 'SBA Loan 4491747703 to CYBERSOLVE IT INC',
          subject: 'CYBERSOLVE IT INC',
          status_as_of: '2024-09-30',
          span_hash: 'abc123hash',
          source_file: 'ppp_foia_tx.csv',
        },
      ],
      gaps: [
        {
          id: 'PPP-GAP-01',
          topic: 'trm-ppp',
          borrower_name: 'CYBERSOLVE IT INC',
          status: 'OPEN',
          reason: 'Unresolved court record gap',
          created_at: new Date().toISOString(),
        },
      ],
    };

    expect(() => assertTopicIsolation(validPppPayload)).not.toThrow();
  });

  it('fails if PPP content is staged in another topic staging folder', () => {
    const invalidPayload: TopicPayload = {
      topic: 'trm-ppp',
      outputPath: '_kb-sync-staging/cic/facts.nlm_pack.md',
    };

    expect(() => assertTopicIsolation(invalidPayload)).toThrow(
      /Topic Isolation Violation: PPP content attempted staging outside of _kb-sync-staging\/trm-ppp/
    );
  });

  it('fails if PPP gap cites Cast Iron Charlie gap ID like GAP-06', () => {
    const invalidGapPayload: TopicPayload = {
      topic: 'trm-ppp',
      gaps: [
        {
          id: 'GAP-06',
          topic: 'trm-ppp',
          borrower_name: 'CYBERSOLVE IT INC',
          status: 'OPEN',
          reason: 'Alien ID used',
          created_at: new Date().toISOString(),
        },
      ],
    };

    expect(() => assertTopicIsolation(invalidGapPayload)).toThrow(
      /violates PPP-GAP-xx namespace/
    );
  });

  it('fails if PPP claims leak into a Cast Iron Charlie or Sorensen report', () => {
    const pppClaim: PppClaim = {
      id: 'PPP-CLAIM-001',
      topic: 'trm-ppp',
      claim_type: 'PUBLIC_RECORD_FACT',
      verification_status: 'VERIFIED',
      text: 'Loan fact',
      subject: 'Test Subject',
      status_as_of: '2024-09-30',
      span_hash: 'hash',
      source_file: 'ppp.csv',
    };

    const alienPayload: TopicPayload = {
      topic: 'cast-iron-charlie',
      claims: [pppClaim],
    };

    expect(() => assertTopicIsolation(alienPayload)).toThrow(
      /PPP claim "PPP-CLAIM-001" leaked into non-PPP topic "cast-iron-charlie"/
    );
  });
});
