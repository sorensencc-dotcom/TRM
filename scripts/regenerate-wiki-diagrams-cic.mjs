#!/usr/bin/env node
/**
 * regenerate-wiki-diagrams-cic.mjs
 *
 * Token-driven TRM wiki diagram regeneration from CIC Industrial Design System.
 * Reads palette from charlie-deep-research/cic_design_system.md (fallback: same
 * tokens as generate_diagrams.py). Updates mermaid classDefs, remaps HTML/SVG
 * fills/strokes to the allowlist, strips rounded corners, re-rasters PNGs via
 * Chrome headless.
 *
 * Usage (from C:\dev\trm): node scripts/regenerate-wiki-diagrams-cic.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const wikiDir = path.join(repoRoot, 'wiki');

const DESIGN_SYSTEM_CANDIDATES = [
  path.resolve(repoRoot, '..', 'charlie-deep-research', 'cic_design_system.md'),
  'C:\\dev\\charlie-deep-research\\cic_design_system.md',
];

/** Fallback = generate_diagrams.py PALETTE */
const FALLBACK_PALETTE = {
  background: '#1A1410',
  grid: '#2C2420',
  strokes: '#B8922A',
  ember: '#C4501A',
  text_primary: '#E8E0D4',
  text_secondary: '#9A9088',
};

function loadPalette() {
  for (const p of DESIGN_SYSTEM_CANDIDATES) {
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, 'utf8');
    const pick = (label) => {
      const re = new RegExp(label + '[^#]*?(#[0-9A-Fa-f]{6})', 'i');
      const m = text.match(re);
      return m ? m[1].toUpperCase() : null;
    };
    const loaded = {
      background: pick('BACKGROUND') || pick('forge black'),
      grid: pick('GRID') || pick('dark brass'),
      strokes: pick('STROKES') || pick('\\(brass\\)'),
      ember: pick('EMBER'),
      text_primary: pick('TEXT_PRIMARY') || pick('warm light'),
      text_secondary: pick('TEXT_SECONDARY') || pick('muted steel'),
    };
    for (const [k, v] of Object.entries(FALLBACK_PALETTE)) {
      if (!loaded[k]) loaded[k] = v;
      else loaded[k] = loaded[k].toUpperCase().replace(/^#([A-F0-9]{6})$/, (_, h) => '#' + h);
    }
    console.log(`[CIC] Loaded palette from ${p}`);
    return { palette: loaded, source: p };
  }
  console.log('[CIC] Design system md not found; using generate_diagrams.py fallback tokens');
  return { palette: { ...FALLBACK_PALETTE }, source: 'fallback:generate_diagrams.py' };
}

function allowlist(palette) {
  return new Set(Object.values(palette).map((h) => h.toUpperCase()));
}

/** Role → classDef body using only allowlisted tokens (matches prior CIC-aligned wiki commit). */
function classDefFor(name, P) {
  const n = name.toLowerCase();
  // fail / gate / lock / emphasis → forge + ember
  if (/fail|gate|lock|comp|deny|block/.test(n)) {
    return `fill:${P.background},stroke:${P.ember},stroke-width:2px,color:${P.text_primary}`;
  }
  // pack / cache / media / mcp / accent stages → grid + ember
  if (/pack|cache|media|mcp/.test(n)) {
    return `fill:${P.grid},stroke:${P.ember},stroke-width:2px,color:${P.text_primary}`;
  }
  // sync / out / export / pass / mode / muted terminal → grid + brass, secondary text
  if (/sync|out|export|pass|mode/.test(n)) {
    return `fill:${P.grid},stroke:${P.strokes},stroke-width:2px,color:${P.text_secondary}`;
  }
  // input / init / daemon / client → forge + brass
  if (/input|init|daemon|client/.test(n)) {
    return `fill:${P.background},stroke:${P.strokes},stroke-width:2px,color:${P.text_primary}`;
  }
  // default stage / proc / engine / check / exec → grid + brass
  return `fill:${P.grid},stroke:${P.strokes},stroke-width:2px,color:${P.text_primary}`;
}

function rewriteMermaidClassDefs(content, P) {
  return content.replace(
    /classDef\s+(\w+)\s+fill:#[0-9A-Fa-f]{3,8},stroke:#[0-9A-Fa-f]{3,8},stroke-width:\d+px,color:#[0-9A-Fa-f]{3,8};/g,
    (_, name) => `classDef ${name} ${classDefFor(name, P)};`
  );
}

/** Map any off-palette hex (and known paper-theme invents) onto CIC roles. */
function buildHexRemap(P) {
  const map = new Map();
  const put = (from, to) => map.set(from.toLowerCase(), to);

  // Paper / cream fills → forge or grid (never invent new hex)
  put('#f2ece2', P.background);
  put('#faf6f0', P.grid);
  put('#f8fafc', P.text_primary);
  put('#ffffff', P.background);
  put('#fff', P.background);
  put('#eeeeee', P.grid);
  put('#eee', P.grid);

  // Ink / dark paper strokes that were "ink on paper" → text or brass on forge
  put('#2c2420', P.strokes); // was ink; on dark canvas use brass stroke
  put('#5c5349', P.text_secondary);
  put('#8a8078', P.text_secondary);

  // Keep ember when already correct
  put('#c4501a', P.ember);

  // Tailwind / invent greens, reds, blues, purples → brass or ember
  ['#059669', '#064e3b', '#34d399', '#10b981'].forEach((h) => put(h, P.strokes));
  ['#dc2626', '#450a0a', '#f87171', '#b91c1c'].forEach((h) => put(h, P.ember));
  ['#38bdf8', '#0f172a', '#1e293b', '#64748b'].forEach((h, i) =>
    put(h, i === 0 ? P.strokes : i < 3 ? P.background : P.text_secondary)
  );
  ['#a855f7', '#312e81', '#818cf8', '#1e1b4b'].forEach((h, i) =>
    put(h, i === 0 || i === 2 ? P.ember : P.grid)
  );

  // Ensure allowlisted tokens map to themselves (canonical casing)
  for (const v of Object.values(P)) put(v, v);

  return map;
}

function remapHexInText(text, hexMap, P) {
  // rgba(r,g,b,a) paper/invent remaps
  text = text.replace(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([0-9.]+)\s*\)/gi, (full, r, g, b, a) => {
    const key = [r, g, b].map((n) => Number(n));
    // known invents
    const approx = (rr, gg, bb) =>
      Math.abs(key[0] - rr) + Math.abs(key[1] - gg) + Math.abs(key[2] - bb) < 30;
    let target = null;
    if (approx(44, 36, 32)) target = P.grid; // was ink wash
    else if (approx(196, 80, 26)) target = P.ember;
    else if (approx(92, 83, 73) || approx(138, 128, 120)) target = P.text_secondary;
    else if (approx(6, 78, 59) || approx(5, 150, 105)) target = P.strokes;
    else if (approx(185, 28, 28) || approx(220, 38, 38)) target = P.ember;
    else if (approx(242, 236, 226) || approx(250, 246, 240)) target = P.background;
    if (!target) return full;
    const hex = target.replace('#', '');
    const rr = parseInt(hex.slice(0, 2), 16);
    const gg = parseInt(hex.slice(2, 4), 16);
    const bb = parseInt(hex.slice(4, 6), 16);
    // keep low opacity washes readable on forge
    const alpha = Math.min(0.35, Math.max(0.08, Number(a)));
    return `rgba(${rr},${gg},${bb},${alpha})`;
  });

  text = text.replace(/#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})\b/g, (m) => {
    const lower = m.toLowerCase();
    if (hexMap.has(lower)) return hexMap.get(lower);
    // expand 3-digit
    if (lower.length === 4) {
      const exp = '#' + lower[1] + lower[1] + lower[2] + lower[2] + lower[3] + lower[3];
      if (hexMap.has(exp)) return hexMap.get(exp);
    }
    // unknown → brass (do not invent)
    console.warn(`[CIC] Unmapped hex ${m} → strokes`);
    return P.strokes;
  });

  return text;
}

function transformHtml(html, P, hexMap) {
  // CSS variables → industrial
  html = html.replace(
    /:root\s*\{[\s\S]*?\}/,
    `:root {
      --color-bg:       ${P.background};
      --color-grid:     ${P.grid};
      --color-stroke:   ${P.strokes};
      --color-ember:    ${P.ember};
      --color-text:     ${P.text_primary};
      --color-muted:    ${P.text_secondary};
      --font-sans:      'Barlow Condensed', system-ui, sans-serif;
      --font-serif:     'Playfair Display', serif;
      --font-sub:       'Libre Baskerville', serif;
    }`
  );

  // Point old var usages at new tokens
  html = html
    .replace(/var\(--color-paper\)/g, 'var(--color-bg)')
    .replace(/var\(--color-ink\)/g, 'var(--color-text)')
    .replace(/var\(--color-accent\)/g, 'var(--color-ember)')
    .replace(/var\(--font-mono\)/g, 'var(--font-sub)');

  // Fonts link: only allowlisted families
  html = html.replace(
    /<link href="https:\/\/fonts\.googleapis\.com\/css2\?[^"]+" rel="stylesheet">/,
    `<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Barlow+Condensed:wght@400;600;700&family=Libre+Baskerville:wght@400;700&display=swap" rel="stylesheet">`
  );

  html = html.replace(/'Geist Mono'/g, "'Libre Baskerville'");
  html = html.replace(/Geist Mono/g, 'Libre Baskerville');

  // Strip rounded corners (rx / ry)
  html = html.replace(/\s+rx="[^"]*"/g, '');
  html = html.replace(/\s+ry="[^"]*"/g, '');

  // No gradients / shadows leftover
  html = html.replace(/box-shadow:[^;}+]+;?/gi, '');
  html = html.replace(/drop-shadow\([^)]*\)/gi, 'none');
  html = html.replace(/linear-gradient\([^)]*\)/gi, P.background);
  html = html.replace(/radial-gradient\([^)]*\)/gi, P.background);

  html = remapHexInText(html, hexMap, P);

  // Ensure body/svg background is forge black
  if (!/fill="${P.background}"/.test(html) && /<rect width="100%" height="100%" fill=/.test(html)) {
    html = html.replace(
      /<rect width="100%" height="100%" fill="[^"]*"/,
      `<rect width="100%" height="100%" fill="${P.background}"`
    );
  }

  // Annotation comment
  if (!html.includes('CIC Industrial Design System')) {
    html = html.replace(
      '<head>',
      `<head>\n  <!-- Regenerated from cic_design_system tokens (forge/brass/ember). No gradients, shadows, or rounded corners. -->`
    );
  }

  return html;
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('Chrome/Edge not found for PNG rasterization');
}

function rasterizeHtmlToPng(chrome, htmlPath, pngPath) {
  const absHtml = path.resolve(htmlPath);
  const absPng = path.resolve(pngPath);
  const tmpPng = path.join(os.tmpdir(), `cic-diagram-${path.basename(pngPath)}`);
  const fileUrl = 'file:///' + absHtml.replace(/\\/g, '/');
  execFileSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--window-size=1400,920`,
      `--screenshot=${tmpPng}`,
      fileUrl,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  if (!fs.existsSync(tmpPng)) throw new Error(`Screenshot missing for ${htmlPath}`);
  fs.copyFileSync(tmpPng, absPng);
  fs.unlinkSync(tmpPng);
}

function ensureHomeCicSection(content) {
  if (/## CIC Industrial Design System/.test(content)) return content;
  const block = `
---

## CIC Industrial Design System

Cast Iron Charlie wiki diagrams and treatment visuals follow the **CIC Industrial Design System** (forge black / brass / ember; Playfair Display, Barlow Condensed, Libre Baskerville; no shadows, gradients, or rounded corners).

- Spec (local): \`C:\\dev\\charlie-deep-research\\cic_design_system.md\`
- Enforcement checklist (local): \`C:\\dev\\charlie-deep-research\\docs\\CIC_DESIGN_SYSTEM_ENFORCEMENT.md\`
- GitHub: [cic_design_system.md](https://github.com/sorensencc-dotcom/charlie-deep-research/blob/main/cic_design_system.md) | [CIC_DESIGN_SYSTEM_ENFORCEMENT.md](https://github.com/sorensencc-dotcom/charlie-deep-research/blob/main/docs/CIC_DESIGN_SYSTEM_ENFORCEMENT.md)

When embedding or regenerating diagrams, prefer \`node scripts/regenerate-wiki-diagrams-cic.mjs\` (tokens from cic_design_system / generate_diagrams.py palette) over ad-hoc styling.

`;
  // Insert after first horizontal rule following intro, or after first paragraph block
  if (content.includes('\n---\n')) {
    return content.replace('\n---\n', '\n---\n' + block + '\n---\n');
  }
  return content + '\n' + block;
}

function updateFooter(content) {
  const line =
    '*Diagrams: [CIC Industrial Design System](https://github.com/sorensencc-dotcom/charlie-deep-research/blob/main/cic_design_system.md) | local `C:\\dev\\charlie-deep-research\\cic_design_system.md` / `docs\\CIC_DESIGN_SYSTEM_ENFORCEMENT.md`*';
  if (content.includes('CIC Industrial Design System')) {
    return content.replace(/\*Diagrams:.*\*/s, line).replace(/Design system:.*$/m, line);
  }
  return content.trimEnd() + '\n' + line + '\n';
}

function auditFile(filePath, allowed) {
  const text = fs.readFileSync(filePath, 'utf8');
  const hexes = [...text.matchAll(/#([0-9A-Fa-f]{6})\b/g)].map((m) => ('#' + m[1]).toUpperCase());
  const off = [...new Set(hexes)].filter((h) => !allowed.has(h));
  const effects = [];
  if (/rx="|ry="/.test(text)) effects.push('rounded-corners(rx/ry)');
  if (/linear-gradient|radial-gradient/i.test(text)) effects.push('gradient');
  if (/box-shadow|drop-shadow/i.test(text)) effects.push('shadow');
  return { off, effects };
}

function main() {
  const { palette: P, source } = loadPalette();
  const allowed = allowlist(P);
  const hexMap = buildHexRemap(P);
  console.log('[CIC] Allowlist:', [...allowed].join(', '));
  console.log('[CIC] Token source:', source);

  const mdFiles = fs.readdirSync(wikiDir).filter((f) => f.endsWith('.md'));
  let mdChanged = 0;
  for (const f of mdFiles) {
    const fp = path.join(wikiDir, f);
    let content = fs.readFileSync(fp, 'utf8');
    const before = content;
    content = rewriteMermaidClassDefs(content, P);
    if (f === 'Home.md') content = ensureHomeCicSection(content);
    if (f === '_Footer.md') content = updateFooter(content);
    if (content !== before) {
      fs.writeFileSync(fp, content, 'utf8');
      mdChanged++;
      console.log(`[CIC] Updated mermaid/tokens: ${f}`);
    }
  }

  const htmlFiles = fs.readdirSync(wikiDir).filter((f) => f.endsWith('.html'));
  const chrome = findChrome();
  console.log('[CIC] Chrome:', chrome);

  let htmlChanged = 0;
  let pngChanged = 0;
  for (const f of htmlFiles) {
    const fp = path.join(wikiDir, f);
    const before = fs.readFileSync(fp, 'utf8');
    const after = transformHtml(before, P, hexMap);
    if (after !== before) {
      fs.writeFileSync(fp, after, 'utf8');
      htmlChanged++;
      console.log(`[CIC] Regenerated HTML: ${f}`);
    }
    const png = path.join(wikiDir, f.replace(/\.html$/, '.png'));
    try {
      rasterizeHtmlToPng(chrome, fp, png);
      pngChanged++;
      console.log(`[CIC] Rasterized PNG: ${path.basename(png)}`);
    } catch (err) {
      console.error(`[CIC] PNG failed for ${f}:`, err.message);
    }
  }

  console.log('\n[CIC] Re-scan drift:');
  const still = [];
  for (const f of [...mdFiles, ...htmlFiles]) {
    if (f.endsWith('.md') && !fs.readFileSync(path.join(wikiDir, f), 'utf8').includes('classDef') && !f.endsWith('.html')) {
      // still audit all md for stray hex in mermaid-ish content
    }
    const fp = path.join(wikiDir, f);
    const { off, effects } = auditFile(fp, allowed);
    if (off.length || effects.length) {
      still.push({ f, off, effects });
      console.log(`  DRIFT ${f}: hex=[${off.join(', ')}] effects=[${effects.join(', ')}]`);
    }
  }
  if (!still.length) console.log('  none');

  const receipt = {
    at: new Date().toISOString(),
    tokenSource: source,
    allowlist: [...allowed],
    mdChanged,
    htmlChanged,
    pngChanged,
    remainingDrift: still,
  };
  fs.writeFileSync(path.join(repoRoot, '.wiki-cic-regen-receipt.json'), JSON.stringify(receipt, null, 2));
  console.log('\n[CIC] Done.', { mdChanged, htmlChanged, pngChanged, drift: still.length });
}

main();
