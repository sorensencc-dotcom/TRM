import { readTopicMeta } from '../../core/topicNode';
import { computeTagOverlapStrength, writeRelatedTopic } from '../../crosslinks/relatedTopics';
import { writeTreatmentLink } from '../../crosslinks/treatmentLink';
import { resolveActor } from '../../registry/actorRegistry';
import { appendOperation } from '../../lineage/hasher';

export function runCrosslink(
  root: string,
  topicPath: string,
  cliArgs: {
    actor?: string;
    relatedTopic?: string;
    relationship?: string;
    strength?: number;
    treatmentSections?: string[];
    promotionReason?: string;
    promotedFacts?: string[];
  }
): void {
  const actor = resolveActor(root, cliArgs.actor);
  const meta = readTopicMeta(root, topicPath);
  const now = new Date().toISOString();

  if (cliArgs.relatedTopic) {
    const otherMeta = readTopicMeta(root, cliArgs.relatedTopic);
    const strength = cliArgs.strength ?? computeTagOverlapStrength(meta.tags, otherMeta.tags);
    writeRelatedTopic(root, topicPath, {
      topic: cliArgs.relatedTopic,
      relationship: cliArgs.relationship ?? '',
      strength,
    });
    appendOperation(root, topicPath, { op: 'CROSSLINK', actor, timestamp: now, related_topic: cliArgs.relatedTopic }, { related_topic: cliArgs.relatedTopic });
  }

  if (cliArgs.treatmentSections) {
    writeTreatmentLink(root, topicPath, {
      promoted_facts: cliArgs.promotedFacts ?? [],
      promotion_reason: cliArgs.promotionReason ?? '',
      treatment_sections: cliArgs.treatmentSections,
    });
    appendOperation(root, topicPath, { op: 'TREATMENT_LINK', actor, timestamp: now, sections: cliArgs.treatmentSections }, { sections: cliArgs.treatmentSections });
  }
}
