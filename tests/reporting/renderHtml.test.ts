import { renderHtml } from '../../src/reporting/renderHtml';
import { ReportBundle } from '../../src/reporting/types';

function baseBundle(overrides: Partial<ReportBundle> = {}): ReportBundle {
  return {
    version: '1.0.0',
    topicPath: 'charlie/cuba',
    topicSlug: 'charlie-cuba',
    generatedAt: '2026-07-18T00:00:00.000Z',
    sourceCount: 0,
    factCount: 0,
    stats: { sourceCount: 0, factCount: 0 },
    facts: [],
    sources: [],
    theme: 'cic',
    ...overrides,
  };
}

describe('renderHtml', () => {
  it('renders topic name, fact text, and source citation', () => {
    const bundle = baseBundle({
      sourceCount: 1,
      factCount: 1,
      stats: { sourceCount: 1, factCount: 1 },
      sources: [{ id: 'SRC-001', type: 'pdf', title: 'Doc Title', origin: 'LOC', url: 'https://x', addedAt: '2026-07-18T00:00:00.000Z' }],
      facts: [{ text: 'A plain fact.', sourceId: 'SRC-001', confidence: 0.9, categories: ['biography'] }],
    });
    const html = renderHtml(bundle);
    expect(html).toContain('charlie/cuba');
    expect(html).toContain('A plain fact.');
    expect(html).toContain('Doc Title');
  });

  it('throws on an unsupported theme', () => {
    const bundle = baseBundle({ theme: 'not-cic' });
    expect(() => renderHtml(bundle)).toThrow(/theme/i);
  });

  it('renders cleanly with empty facts and sources', () => {
    const html = renderHtml(baseBundle());
    expect(html).toContain('charlie/cuba');
    expect(html).not.toContain('undefined');
  });

  it('escapes HTML special characters in fact text and source titles', () => {
    const bundle = baseBundle({
      sourceCount: 1,
      factCount: 1,
      stats: { sourceCount: 1, factCount: 1 },
      sources: [{ id: 'SRC-001', type: 'pdf', title: '<script>alert(1)</script>', origin: 'LOC', url: 'https://x', addedAt: '2026-07-18T00:00:00.000Z' }],
      facts: [{ text: 'A fact with <b>tags</b> & "quotes".', sourceId: 'SRC-001', confidence: 0.9, categories: [] }],
    });
    const html = renderHtml(bundle);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;b&gt;tags&lt;/b&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;quotes&quot;');
  });

  it('groups a multi-category fact under only its first category, never duplicated', () => {
    const bundle = baseBundle({
      factCount: 1,
      stats: { sourceCount: 0, factCount: 1 },
      facts: [{ text: 'Multi-cat fact.', sourceId: 'SRC-001', confidence: 0.9, categories: ['economics', 'geopolitics'] }],
    });
    const html = renderHtml(bundle);
    const occurrences = html.split('Multi-cat fact.').length - 1;
    expect(occurrences).toBe(1);
    expect(html).toContain('economics');
    expect(html.indexOf('economics')).toBeLessThan(html.indexOf('Multi-cat fact.'));
  });

  it('groups a no-category fact under "Uncategorized"', () => {
    const bundle = baseBundle({
      factCount: 1,
      stats: { sourceCount: 0, factCount: 1 },
      facts: [{ text: 'No-category fact.', sourceId: 'SRC-001', confidence: 0.9, categories: [] }],
    });
    const html = renderHtml(bundle);
    expect(html).toContain('Uncategorized');
  });

  it('renders "[Unknown Source]" for a fact whose sourceId has no match', () => {
    const bundle = baseBundle({
      factCount: 1,
      stats: { sourceCount: 0, factCount: 1 },
      facts: [{ text: 'Orphaned fact.', sourceId: 'SRC-999', confidence: 0.9, categories: [] }],
    });
    const html = renderHtml(bundle);
    expect(html).toContain('[Unknown Source]');
  });
});
