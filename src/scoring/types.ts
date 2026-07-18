import { TopicMeta, TrmConfig } from '../core/types';

export interface Fact {
  id: string;
  text: string;
  source_id: string;
  confidence: number;
  categories: string[];
}

export interface ScoreResult {
  fact_id: string;
  relevance: number;
  genealogy: number;
  historical: number;
  confidence: number;
  novelty: number;
  promotion_score: number;
  promoted: boolean;
}

export interface ScoringAdapter {
  score(facts: Fact[], topic: TopicMeta, config: TrmConfig): ScoreResult[];
}
