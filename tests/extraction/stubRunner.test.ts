import { stubRunner } from '../../src/extraction/stubRunner';

describe('stubRunner', () => {
  it('produces one fact per non-empty line, deterministically', () => {
    const source = { id: 'SRC-001', type: 'text', title: 'x', origin: 'x', url: 'x', added_at: 't', actor: 'ACTOR-001' };
    const result = stubRunner.run(source, 'First fact.\n\nSecond fact.\n');
    expect(result.facts).toHaveLength(2);
    expect(result.facts[0]).toEqual({ id: 'FCT-001', text: 'First fact.', source_id: 'SRC-001', confidence: 0.5, categories: [] });
    expect(result.facts[1].id).toBe('FCT-002');
    expect(result.summary).toContain('2 fact');
  });
});
