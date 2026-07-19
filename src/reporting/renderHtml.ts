import { ReportBundle, ReportBundleFact, ReportBundleSource } from './types';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CIC_CSS = `
:root {
  --ink: #1a1a1a; --muted: #555; --rule: #c8b89a; --accent: #8b3a2a;
  --bg: #fdfaf6; --font-body: 'Crimson Pro', Georgia, serif; --font-ui: 'Source Sans 3', system-ui, sans-serif;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: var(--font-body); font-size: 11.5pt; line-height: 1.65; color: var(--ink); background: var(--bg); max-width: 820px; margin: 0 auto; }
.cover { min-height: 40vh; display: flex; flex-direction: column; justify-content: center; padding: 60px; border-bottom: 3px solid var(--rule); }
.cover-label { font-family: var(--font-ui); font-size: 9pt; letter-spacing: .18em; text-transform: uppercase; color: var(--accent); margin-bottom: 20px; }
.cover h1 { font-size: 30pt; font-weight: 600; margin-bottom: 12px; }
.cover-subtitle { font-size: 13pt; font-style: italic; color: var(--muted); }
.section { padding: 40px 60px; border-bottom: 1px solid var(--rule); }
h2 { font-family: var(--font-ui); font-size: 9pt; letter-spacing: .16em; text-transform: uppercase; color: var(--accent); margin-bottom: 16px; padding-bottom: 6px; border-bottom: 1px solid var(--rule); }
h3 { font-size: 13pt; font-weight: 600; margin: 20px 0 8px; }
.stats-bar { display: flex; gap: 30px; flex-wrap: wrap; }
.stat-item { display: flex; flex-direction: column; }
.stat-value { font-size: 22pt; font-weight: 600; color: var(--accent); }
.stat-label { font-family: var(--font-ui); font-size: 8.5pt; color: var(--muted); text-transform: uppercase; }
.evidence-item { margin-bottom: 14px; padding-left: 14px; border-left: 2px solid var(--rule); }
.ev-citation { font-size: 10.5pt; }
.ev-meta { font-family: var(--font-ui); font-size: 8.5pt; color: var(--muted); }
.fact-item { margin-bottom: 12px; padding-left: 14px; border-left: 2px solid var(--rule); }
.fact-meta { font-family: var(--font-ui); font-size: 8.5pt; color: var(--muted); display: block; margin-top: 2px; }
`;

function titleCase(value: string): string {
  return value.replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1));
}

function groupFactsByCategory(facts: ReportBundleFact[]): Map<string, ReportBundleFact[]> {
  const groups = new Map<string, ReportBundleFact[]>();
  for (const fact of facts) {
    const category = fact.categories[0] ?? 'Uncategorized';
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category)!.push(fact);
  }
  return groups;
}

function citationFor(sourceId: string, sources: ReportBundleSource[]): string {
  const source = sources.find((s) => s.id === sourceId);
  if (!source) return '[Unknown Source]';
  return `${escapeHtml(source.title)} (${escapeHtml(source.origin)})`;
}

function renderStatsBar(bundle: ReportBundle): string {
  return `
<div class="section">
  <h2>Research at a Glance</h2>
  <div class="stats-bar">
    <div class="stat-item"><span class="stat-value">${bundle.stats.sourceCount}</span><span class="stat-label">Sources</span></div>
    <div class="stat-item"><span class="stat-value">${bundle.stats.factCount}</span><span class="stat-label">Facts</span></div>
  </div>
</div>`;
}

function renderNarrative(bundle: ReportBundle): string {
  return `
<div class="section">
  <h2>Narrative Research Summary</h2>
  <p>[Manual narrative summary for ${escapeHtml(bundle.topicPath)} goes here.]</p>
</div>`;
}

function renderEvidenceRegister(bundle: ReportBundle): string {
  const items = bundle.sources
    .map(
      (s, i) => `
<div class="evidence-item">
  <div class="ev-citation">[${i + 1}] "${escapeHtml(s.title)}" — ${escapeHtml(s.origin)}. ${escapeHtml(s.url)}</div>
  <div class="ev-meta">Type: ${escapeHtml(s.type)} · Added: ${escapeHtml(s.addedAt)}</div>
</div>`
    )
    .join('');
  return `
<div class="section">
  <h2>Evidence Register</h2>
  ${items}
</div>`;
}

function renderFactsList(bundle: ReportBundle): string {
  const groups = groupFactsByCategory(bundle.facts);
  const sections = [...groups.entries()]
    .map(([category, facts]) => {
      const items = facts
        .map(
          (fact) => `
<div class="fact-item">
  <p>${escapeHtml(fact.text)}</p>
  <span class="fact-meta">confidence: ${fact.confidence} · source: ${citationFor(fact.sourceId, bundle.sources)}</span>
</div>`
        )
        .join('');
      return `<h3>${escapeHtml(category)}</h3>${items}`;
    })
    .join('');
  return `
<div class="section">
  <h2>Facts</h2>
  ${sections}
</div>`;
}

export function renderHtml(bundle: ReportBundle): string {
  if (bundle.theme !== 'cic') {
    throw new Error(`renderHtml: unsupported theme "${bundle.theme}" (only "cic" is implemented)`);
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(bundle.topicPath)} — Research Report</title>
<style>${CIC_CSS}</style>
</head>
<body>
<div class="cover">
  <div class="cover-label">TRM Research Report</div>
  <h1>${escapeHtml(bundle.topicPath)}</h1>
  <div class="cover-subtitle">Generated ${escapeHtml(bundle.generatedAt)}</div>
</div>
${renderStatsBar(bundle)}
${renderNarrative(bundle)}
${renderFactsList(bundle)}
${renderEvidenceRegister(bundle)}
</body>
</html>`;
}
