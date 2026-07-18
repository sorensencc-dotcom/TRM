import { buildExtractPrompt, CATEGORY_VOCAB } from '../../src/extraction/prompts/extractFacts';

describe('buildExtractPrompt', () => {
  it('includes the source title', () => {
    const prompt = buildExtractPrompt('Beats 7.3-7.4: Empire of Sand');
    expect(prompt).toContain('Beats 7.3-7.4: Empire of Sand');
  });

  it('includes every category in the fixed vocabulary', () => {
    const prompt = buildExtractPrompt('Some Title');
    for (const category of CATEGORY_VOCAB) {
      expect(prompt).toContain(category);
    }
  });

  it('instructs the model not to include id or source_id fields', () => {
    const prompt = buildExtractPrompt('Some Title');
    expect(prompt).toMatch(/"id"/);
    expect(prompt).toMatch(/"source_id"/);
    expect(prompt).toMatch(/assigned by the caller/);
  });

  it('is deterministic for the same title', () => {
    const a = buildExtractPrompt('Some Title');
    const b = buildExtractPrompt('Some Title');
    expect(a).toBe(b);
  });
});
