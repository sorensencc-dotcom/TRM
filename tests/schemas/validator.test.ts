import { validateAgainstSchema } from '../../src/schemas/validator';

describe('validateAgainstSchema', () => {
  it('accepts a valid score.json', () => {
    const result = validateAgainstSchema('score', {
      scores: [
        {
          fact_id: 'FCT-001',
          relevance: 88,
          genealogy: 10,
          historical: 90,
          confidence: 92,
          novelty: 40,
          promotion_score: 83.4,
          promoted: true,
        },
      ],
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a score.json with extra fields (closed schema)', () => {
    const result = validateAgainstSchema('score', {
      scores: [
        {
          fact_id: 'FCT-001',
          relevance: 88,
          genealogy: 10,
          historical: 90,
          confidence: 92,
          novelty: 40,
          promotion_score: 83.4,
          promoted: true,
          extra_field: 'nope',
        },
      ],
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a score.json missing a required field', () => {
    const result = validateAgainstSchema('score', { scores: [{ fact_id: 'FCT-001' }] });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('accepts a valid topic.json', () => {
    const result = validateAgainstSchema('topic', {
      topic: 'automotive',
      path: 'cuba/industry/automotive',
      parent: 'cuba/industry',
      children: [],
      version: '1.0.0',
      created_at: '2026-07-17T16:50:00',
      updated_at: '2026-07-17T16:50:00',
      actors: ['ACTOR-001'],
      description: 'x',
      tags: ['history'],
      status: 'active',
      node_type: 'subtopic',
    });
    expect(result.valid).toBe(true);
  });

  it('rejects an extract.json fact with a category outside the fixed vocabulary', () => {
    const result = validateAgainstSchema('extract', {
      facts: [
        {
          id: 'FCT-001',
          text: 'x',
          source_id: 'SRC-001',
          confidence: 0.5,
          categories: ['not-a-real-category'],
        },
      ],
    });
    expect(result.valid).toBe(false);
  });

  it('accepts an extract.json fact with categories from the fixed vocabulary', () => {
    const result = validateAgainstSchema('extract', {
      facts: [
        {
          id: 'FCT-001',
          text: 'x',
          source_id: 'SRC-001',
          confidence: 0.5,
          categories: ['history', 'genealogy'],
        },
      ],
    });
    expect(result.valid).toBe(true);
  });

  describe('metadata.json', () => {
    const baseSource = {
      id: 'SRC-001',
      type: 'image',
      title: 'test title',
      origin: 'test origin',
      url: 'local:test.jpg',
      added_at: '2026-07-27T00:00:00.000Z',
      actor: 'ACTOR-001',
    };

    it('accepts a source with no contentHash (plain `trm ingest` shape)', () => {
      const result = validateAgainstSchema('metadata', { sources: [baseSource] });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('accepts a source with contentHash (regression: `trm ingest-dir` image shape, previously rejected)', () => {
      const result = validateAgainstSchema('metadata', {
        sources: [{ ...baseSource, contentHash: 'a'.repeat(64) }],
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('rejects a source missing a required field', () => {
      const { actor: _actor, ...missingActor } = baseSource;
      const result = validateAgainstSchema('metadata', { sources: [missingActor] });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('rejects a source with an unknown extra property (closed schema)', () => {
      const result = validateAgainstSchema('metadata', {
        sources: [{ ...baseSource, notInSchema: 'nope' }],
      });
      expect(result.valid).toBe(false);
    });

    it('rejects a metadata.json missing the top-level sources array', () => {
      const result = validateAgainstSchema('metadata', {});
      expect(result.valid).toBe(false);
    });

    it('accepts an empty sources array', () => {
      const result = validateAgainstSchema('metadata', { sources: [] });
      expect(result.valid).toBe(true);
    });
  });
});
