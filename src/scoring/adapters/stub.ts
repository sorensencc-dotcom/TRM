import { Fact, ScoreResult, ScoringAdapter } from '../types';

const WEIGHTS = { relevance: 0.3, genealogy: 0.1, historical: 0.2, confidence: 0.3, novelty: 0.1 };

export const stubAdapter: ScoringAdapter = {
  score(facts: Fact[], _topic, config): ScoreResult[] {
    return facts.map((fact) => {
      const confidence = Math.round(fact.confidence * 100);
      const relevance = confidence;
      const genealogy = fact.categories.includes('genealogy') ? 80 : 20;
      const historical = fact.categories.includes('history') ? 80 : 20;
      const novelty = 50;
      const promotion_score =
        relevance * WEIGHTS.relevance +
        genealogy * WEIGHTS.genealogy +
        historical * WEIGHTS.historical +
        confidence * WEIGHTS.confidence +
        novelty * WEIGHTS.novelty;
      return {
        fact_id: fact.id,
        relevance,
        genealogy,
        historical,
        confidence,
        novelty,
        promotion_score: Math.round(promotion_score * 10) / 10,
        promoted: promotion_score >= config.promotion_threshold,
      };
    });
  },
};
