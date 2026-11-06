import { PppClaim, PppGap } from './types';

export interface TopicPayload {
  topic: string;
  topicSlug?: string;
  outputPath?: string;
  claims?: PppClaim[];
  gaps?: PppGap[];
  facts?: Array<{ id?: string; text?: string }>;
}

const ALIEN_TOPIC_IDENTIFIERS = [
  'cast iron charlie',
  'cic',
  'sorensen',
  'sorensencc',
  'charlie-deep-research',
];

const PPP_TOPIC_IDENTIFIERS = [
  'trm-ppp',
  'ppp-texas',
  'ppp-tx',
];

/**
 * Validates that topic boundaries are strictly preserved.
 * Throws an error if any data or path cross-contamination is detected.
 */
export function assertTopicIsolation(payload: TopicPayload): void {
  const isPppTopic = PPP_TOPIC_IDENTIFIERS.includes(payload.topic.toLowerCase()) ||
    (payload.topicSlug && PPP_TOPIC_IDENTIFIERS.includes(payload.topicSlug.toLowerCase()));

  if (isPppTopic) {
    // 1. Output path must be within trm-ppp staging or worktree
    if (payload.outputPath) {
      const normalizedPath = payload.outputPath.replace(/\\/g, '/');
      if (normalizedPath.includes('_kb-sync-staging') && !normalizedPath.includes('_kb-sync-staging/trm-ppp')) {
        throw new Error(
          `Topic Isolation Violation: PPP content attempted staging outside of _kb-sync-staging/trm-ppp: "${payload.outputPath}"`
        );
      }
    }

    // 2. No alien gap IDs (e.g., GAP-06 without PPP- prefix)
    if (payload.gaps) {
      for (const gap of payload.gaps) {
        if (!gap.id.startsWith('PPP-GAP-')) {
          throw new Error(
            `Topic Isolation Violation: PPP gap ID "${gap.id}" violates PPP-GAP-xx namespace.`
          );
        }
      }
    }

    // 3. No alien topic contamination in claim texts or subjects
    if (payload.claims) {
      for (const claim of payload.claims) {
        if (claim.topic !== 'trm-ppp') {
          throw new Error(
            `Topic Isolation Violation: Claim "${claim.id}" has invalid topic "${claim.topic}". Expected "trm-ppp".`
          );
        }
        for (const alien of ALIEN_TOPIC_IDENTIFIERS) {
          if (claim.subject.toLowerCase() === alien || claim.text.toLowerCase().includes(`topic:${alien}`)) {
            throw new Error(
              `Topic Isolation Violation: Alien topic reference "${alien}" detected in PPP claim "${claim.id}".`
            );
          }
        }
      }
    }
  } else {
    // Non-PPP topic must never contain PPP claims or PPP gap IDs
    if (payload.claims) {
      for (const claim of payload.claims) {
        if (claim.topic === 'trm-ppp' || claim.id.startsWith('PPP-')) {
          throw new Error(
            `Topic Isolation Violation: PPP claim "${claim.id}" leaked into non-PPP topic "${payload.topic}".`
          );
        }
      }
    }

    if (payload.gaps) {
      for (const gap of payload.gaps) {
        if (gap.id.startsWith('PPP-GAP-') || gap.topic === 'trm-ppp') {
          throw new Error(
            `Topic Isolation Violation: PPP gap "${gap.id}" leaked into non-PPP topic "${payload.topic}".`
          );
        }
      }
    }
  }
}
