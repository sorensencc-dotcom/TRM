import { stubAdapter } from '../../src/scoring/adapters/stub';
import { TopicMeta, TrmConfig } from '../../src/core/types';

const topic: TopicMeta = {
  topic: 'cuba', path: 'cuba', parent: null, children: [], version: '1.0.0',
  created_at: 't', updated_at: 't', actors: ['ACTOR-001'], description: '', tags: [],
  status: 'active', node_type: 'project',
};
const config: TrmConfig = { default_scoring_adapter: 'stub', promotion_threshold: 80, actor_source: 'env', time_source: 'system' };

describe('stubAdapter', () => {
  it('scores a fact deterministically', () => {
    const facts = [{ id: 'FCT-001', text: 'x', source_id: 'SRC-001', confidence: 0.92, categories: ['history', 'genealogy'] }];
    const [result] = stubAdapter.score(facts, topic, config);
    expect(result.fact_id).toBe('FCT-001');
    expect(result.confidence).toBe(92);
    expect(result.genealogy).toBe(80);
    expect(result.historical).toBe(80);
    expect(result.relevance).toBe(92);
    expect(result.novelty).toBe(50);
  });

  it('is deterministic across repeated calls', () => {
    const facts = [{ id: 'FCT-001', text: 'x', source_id: 'SRC-001', confidence: 0.5, categories: [] }];
    const a = stubAdapter.score(facts, topic, config);
    const b = stubAdapter.score(facts, topic, config);
    expect(a).toEqual(b);
  });

  it('sets promoted true only when promotion_score meets threshold', () => {
    const facts = [{ id: 'FCT-001', text: 'x', source_id: 'SRC-001', confidence: 0.95, categories: ['history', 'genealogy'] }];
    const [high] = stubAdapter.score(facts, topic, { ...config, promotion_threshold: 80 });
    const [tooHigh] = stubAdapter.score(facts, topic, { ...config, promotion_threshold: 100 });
    expect(high.promoted).toBe(true);
    expect(tooHigh.promoted).toBe(false);
  });
});
