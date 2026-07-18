import { buildExtractPrompt, CATEGORY_VOCAB } from '../../src/extraction/prompts/extractFacts';

describe('buildExtractPrompt', () => {
  it('describes the source-marker + title-line stdin format', () => {
    const prompt = buildExtractPrompt();
    expect(prompt).toMatch(/---SOURCE---/);
    expect(prompt).toMatch(/Source title: <title>/);
  });

  it('includes every category in the fixed vocabulary', () => {
    const prompt = buildExtractPrompt();
    for (const category of CATEGORY_VOCAB) {
      expect(prompt).toContain(category);
    }
  });

  it('instructs the model not to include id or source_id fields', () => {
    const prompt = buildExtractPrompt();
    expect(prompt).toMatch(/"id"/);
    expect(prompt).toMatch(/"source_id"/);
    expect(prompt).toMatch(/assigned by the caller/);
  });

  it('is deterministic (fully static, no interpolated content)', () => {
    const a = buildExtractPrompt();
    const b = buildExtractPrompt();
    expect(a).toBe(b);
  });
});
