#!/usr/bin/env node
/**
 * regenerate-wiki-diagrams-cic.mjs
 *
 * Token-driven TRM wiki diagram regeneration — CIC Industrial READABLE mode.
 * Parchment/paper field + forge ink/borders + brass/ember accents.
 * NOT near-black (forge) node fills (illegible on GitHub wiki).
 *
 * Chris lock (readable CIC / Cathryn Lavery):
 *   page/field:  #F5F0E6 parchment cream
 *   node fills:  #FAF6F0 off-white
 *   ink/borders: #1A1410 forge black
 *   accents:     brass #B8922A, ember #C4501A (highlights / feedback arrows)
 *   no gradients, shadows, or rounded corners
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

/** CIC industrial + readable diagram field (Cathryn / Chris lock). */
const FALLBACK_PALETTE = {
  // CIC chrome tokens (forge = ink/borders only in wiki diagrams)
  background: '#1A1410',
  grid: '#2C2420',
  strokes: '#B8922A',
  ember: '#C4501A',
  text_primary: '#E8E0D4',
  text_secondary: '#9A9088',
  // Readable wiki diagram field
  paper: '#F5F0E6',
  node: '#FAF6F0',
  ink: '#1A1410',
  muted_ink: '#5C5349',
};

function loadPalette() {
  const loaded = { ...FALLBACK_PALETTE };
  let source = 'fallback:readable-cic';
  for (const p of DESIGN_SYSTEM_CANDIDATES) {
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, 'utf8');
    const pick = (label) => {
      const re = new RegExp(label + '[^#]*?(#[0-9A-Fa-f]{6})', 'i');
      const m = text.match(re);
      return m ? m[1].toUpperCase() : null;
    };
    const fromMd = {
      background: pick('BACKGROUND') || pick('forge black'),
      grid: pick('GRID') || pick('dark brass'),
      strokes: pick('STROKES') || pick('\(brass\)'),
      ember: pick('EMBER'),
      text_primary: pick('TEXT_PRIMARY') || pick('warm light'),
      text_secondary: pick('TEXT_SECONDARY') || pick('muted steel'),
      paper: pick('PAPER') || pick('parchment'),
      node: pick('NODE_FILL') || pick('off-white'),
      ink: pick('INK'),
      muted_ink: pick('MUTED_INK'),
    };
    for (const [k, v] of Object.entries(fromMd)) {
      if (v) loaded[k] = v.toUpperCase().replace(/^#([A-F0-9]{6})$/, (_, h) => '#' + h);
    }
    // Readable lock defaults when md omits parchment roles
    if (!fromMd.ink) loaded.ink = loaded.background;
    if (!fromMd.paper) loaded.paper = FALLBACK_PALETTE.paper;
    if (!fromMd.node) loaded.node = FALLBACK_PALETTE.node;
    if (!fromMd.muted_ink) loaded.muted_ink = FALLBACK_PALETTE.muted_ink;
    source = p;
    console.log(`[CIC] Loaded palette from ${p}`);
    break;
  }
  if (source === 'fallback:readable-cic') {
    console.log('[CIC] Design system md not found; using readable CIC fallback tokens');
  }
  for (const k of Object.keys(loaded)) {
    loaded[k] = String(loaded[k]).toUpperCase().replace(/^#([A-F0-9]{6})$/, (_, h) => '#' + h);
  }
  // Chris exemplar lock (wiki-style v1.2 / W13)
  loaded.paper = '#F5F0E6';
  loaded.node = '#FAF6F0';
  loaded.ink = '#1A1410';
  loaded.muted_ink = '#5C5349';
  return { palette: loaded, source };
}

function allowlist(palette) {
  return new Set(Object.values(palette).map((h) => h.toUpperCase()));
}

/** Mermaid classDefs: off-white fills, forge ink text, brass/ember strokes. */
function classDefFor(name, P) {
  const n = name.toLowerCase();
  const ink = P.ink;
  const muted = P.muted_ink;
  // fail / gate / lock / emphasis → off-white + ember stroke
  if (/fail|gate|lock|comp|deny|block/.test(n)) {
    return `fill:${P.node},stroke:${P.ember},stroke-width:2px,color:${ink}`;
  }
  // pack / cache / media / mcp / accent stages → off-white + ember
  if (/pack|cache|media|mcp/.test(n)) {
    return `fill:${P.node},stroke:${P.ember},stroke-width:2px,color:${ink}`;
  }
  // sync / out / export / pass / mode → parchment + ink, muted text
  if (/sync|out|export|pass|mode/.test(n)) {
    return `fill:${P.paper},stroke:${ink},stroke-width:2px,color:${muted}`;
  }
  // input / init / daemon / client → off-white + ink border
  if (/input|init|daemon|client/.test(n)) {
    return `fill:${P.node},stroke:${ink},stroke-width:2px,color:${ink}`;
  }
  // default stage → off-white + brass accent stroke
  return `fill:${P.node},stroke:${P.strokes},stroke-width:2px,color:${ink}`;
}

function rewriteMermaidClassDefs(content, P) {
  return content.replace(
    /classDef\s+(\w+)\s+fill:#[0-9A-Fa-f]{3,8},stroke:#[0-9A-Fa-f]{3,8},stroke-width:\d+px,color:#[0-9A-Fa-f]{3,8};/g,
    (_, name) => `classDef ${name} ${classDefFor(name, P)};`
  );
}

/** Map dark-CIC and legacy invents onto readable parchment roles. */
function buildHexRemap(P) {
  const map = new Map();
  const put = (from, to) => map.set(from.toLowerCase(), to);

  // Dark forge/grid fills → parchment / off-white (never keep as node fills)
  put('#1a1410', P.paper);
  put('#2c2420', P.node);

  // Light text-on-dark → forge ink
  put('#e8e0d4', P.ink);
  put('#9a9088', P.muted_ink);

  // Legacy / Chris parchment (canonicalize)
  put('#f5f0e6', P.paper);
  put('#f2ece2', P.paper);
  put('#faf6f0', P.node);
  put('#f8fafc', P.node);
  put('#ffffff', P.node);
  put('#fff', P.node);
  put('#eeeeee', P.node);
  put('#eee', P.node);

  // Original Cathryn muted ink
  put('#5c5349', P.muted_ink);
  put('#8a8078', P.muted_ink);

  // Accents stay
  put('#c4501a', P.ember);
  put('#b8922a', P.strokes);

  // Tailwind invents → brass or ember
  ['#059669', '#064e3b', '#34d399', '#10b981'].forEach((h) => put(h, P.strokes));
  ['#dc2626', '#450a0a', '#f87171', '#b91c1c'].forEach((h) => put(h, P.ember));
  ['#38bdf8', '#0f172a', '#1e293b', '#64748b'].forEach((h, i) =>
    put(h, i === 0 ? P.strokes : i < 3 ? P.node : P.muted_ink)
  );
  ['#a855f7', '#312e81', '#818cf8', '#1e1b4b'].forEach((h, i) =>
    put(h, i === 0 || i === 2 ? P.ember : P.node)
  );

  for (const v of Object.values(P)) put(v, v);

  // Readable overrides for light-on-dark leftovers.
  // Do NOT map forge/grid here — explicit fill replacements handle node/canvas;
  // strokes must keep forge ink through remapHexInText.
  put('#e8e0d4', P.ink);
  put('#9a9088', P.muted_ink);

  return map;
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function remapHexInText(text, hexMap, P) {
  text = text.replace(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([0-9.]+)\s*\)/gi, (full, r, g, b, a) => {
    const key = [r, g, b].map((n) => Number(n));
    const approx = (rr, gg, bb) =>
      Math.abs(key[0] - rr) + Math.abs(key[1] - gg) + Math.abs(key[2] - bb) < 30;
    let target = null;
    if (approx(26, 20, 16) || approx(44, 36, 32)) target = P.ink;
    else if (approx(196, 80, 26)) target = P.ember;
    else if (approx(184, 146, 42)) target = P.strokes;
    else if (approx(92, 83, 73) || approx(138, 128, 120) || approx(154, 144, 136)) target = P.muted_ink;
    else if (approx(6, 78, 59) || approx(5, 150, 105)) target = P.strokes;
    else if (approx(185, 28, 28) || approx(220, 38, 38)) target = P.ember;
    else if (approx(242, 236, 226) || approx(250, 246, 240) || approx(245, 240, 230)) target = P.paper;
    if (!target) return full;
    const { r: rr, g: gg, b: bb } = hexToRgb(target);
    const alpha = Math.min(0.35, Math.max(0.06, Number(a)));
    return `rgba(${rr},${gg},${bb},${alpha})`;
  });

  text = text.replace(/#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})\b/g, (m) => {
    const lower = m.toLowerCase();
    if (hexMap.has(lower)) return hexMap.get(lower);
    if (lower.length === 4) {
      const exp = '#' + lower[1] + lower[1] + lower[2] + lower[2] + lower[3] + lower[3];
      if (hexMap.has(exp)) return hexMap.get(exp);
    }
    console.warn(`[CIC] Unmapped hex ${m} → strokes`);
    return P.strokes;
  });

  return text;
}

function transformHtml(html, P, hexMap) {
  // CSS variables → readable parchment industrial
  html = html.replace(
    /:root\s*\{[\s\S]*?\}/,
    `:root {
      --color-bg:       ${P.paper};
      --color-paper:    ${P.paper};
      --color-node:     ${P.node};
      --color-grid:     ${P.grid};
      --color-stroke:   ${P.ink};
      --color-brass:    ${P.strokes};
      --color-ember:    ${P.ember};
      --color-text:     ${P.ink};
      --color-ink:      ${P.ink};
      --color-muted:    ${P.muted_ink};
      --font-sans:      'Barlow Condensed', system-ui, sans-serif;
      --font-serif:     'Playfair Display', serif;
      --font-sub:       'Libre Baskerville', serif;
    }`
  );

  html = html
    .replace(/var\(--color-paper\)/g, 'var(--color-bg)')
    .replace(/var\(--color-ink\)/g, 'var(--color-text)')
    .replace(/var\(--color-accent\)/g, 'var(--color-ember)')
    .replace(/var\(--font-mono\)/g, 'var(--font-sub)');

  html = html.replace(
    /<link href="https:\/\/fonts\.googleapis\.com\/css2\?[^"]+" rel="stylesheet">/,
    `<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Barlow+Condensed:wght@400;600;700&family=Libre+Baskerville:wght@400;700&display=swap" rel="stylesheet">`
  );

  html = html.replace(/'Geist Mono'/g, "'Libre Baskerville'");
  html = html.replace(/Geist Mono/g, 'Libre Baskerville');

  html = html.replace(/\s+rx="[^"]*"/g, '');
  html = html.replace(/\s+ry="[^"]*"/g, '');
  html = html.replace(/box-shadow:[^;}+]+;?/gi, '');
  html = html.replace(/drop-shadow\([^)]*\)/gi, 'none');
  html = html.replace(/linear-gradient\([^)]*\)/gi, P.paper);
  html = html.replace(/radial-gradient\([^)]*\)/gi, P.paper);

  // Protect text/marker fills so ink stays dark while rect fills go parchment
  const protectedFills = [];
  const protect = (full, pre, fill, post) => {
    const i = protectedFills.length;
    protectedFills.push(fill);
    return `${pre}@@PROTECTFILL${i}@@${post}`;
  };
  html = html.replace(/(<text\b[^>]*?\sfill=")([^"]*)(")/gi, protect);
  html = html.replace(/(<(?:polygon|path)\b[^>]*?\sfill=")([^"]*)(")/gi, protect);

  // Canvas + dark solid fills → parchment / off-white before generic remap
  html = html.replace(
    /<rect width="100%" height="100%" fill="[^"]*"/,
    `<rect width="100%" height="100%" fill="${P.paper}"`
  );
  html = html.replace(/\bfill="#1[Aa]1410"/g, `fill="${P.paper}"`);
  html = html.replace(/\bfill="#2[Cc]2420"/g, `fill="${P.node}"`);
  html = html.replace(/\bstroke="#2[Cc]2420"/g, `stroke="${P.ink}"`);
  html = html.replace(/\bstroke="#1[Aa]1410"/g, `stroke="${P.ink}"`);

  html = remapHexInText(html, hexMap, P);

  // Restore protected fills with ink-aware mapping
  html = html.replace(/@@PROTECTFILL(\d+)@@/g, (_, idx) => {
    const orig = protectedFills[Number(idx)];
    if (!orig) return P.ink;
    if (/^rgba?\(/i.test(orig)) return remapHexInText(orig, hexMap, P);
    const lower = orig.toLowerCase();
    if (['#e8e0d4', '#faf6f0', '#f5f0e6', '#f2ece2', '#fff', '#ffffff'].includes(lower)) return P.ink;
    if (lower === '#c4501a') return P.ember;
    if (lower === '#b8922a') return P.strokes;
    if (['#9a9088', '#5c5349', '#8a8078'].includes(lower)) return P.muted_ink;
    if (lower === '#1a1410' || lower === '#2c2420') return P.ink;
    if (hexMap.has(lower)) {
      const mapped = hexMap.get(lower);
      if (mapped === P.paper || mapped === P.node) return P.ink;
      return mapped;
    }
    return P.ink;
  });

  const banner =
    '<!-- Regenerated: CIC readable parchment (#F5F0E6 field, #FAF6F0 nodes, forge ink borders/text, brass/ember accents). No gradients, shadows, or rounded corners. -->';
  if (html.includes('CIC Industrial Design System') || html.includes('readable parchment') || html.includes('cic_design_system tokens')) {
    html = html.replace(/<!-- Regenerated[^>]*-->/, banner);
  } else {
    html = html.replace('<head>', `<head>\n  ${banner}`);
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
  if (/## CIC Industrial Design System/.test(content)) {
    return content.replace(
      /Cast Iron Charlie wiki diagrams[^.]*\./,
      'Cast Iron Charlie wiki diagrams follow the **CIC Industrial Design System** in readable parchment mode (cream field / off-white nodes / forge ink borders & text; brass & ember accents only; Playfair Display, Barlow Condensed, Libre Baskerville; no shadows, gradients, or rounded corners).'
    );
  }
  const block = `
---

## CIC Industrial Design System

Cast Iron Charlie wiki diagrams follow the **CIC Industrial Design System** in readable parchment mode (cream field / off-white nodes / forge ink borders & text; brass & ember accents only; Playfair Display, Barlow Condensed, Libre Baskerville; no shadows, gradients, or rounded corners).

- Spec (local): \`C:\\dev\\charlie-deep-research\\cic_design_system.md\`
- Enforcement checklist (local): \`C:\\dev\\charlie-deep-research\\docs\\CIC_DESIGN_SYSTEM_ENFORCEMENT.md\`
- GitHub: [cic_design_system.md](https://github.com/sorensencc-dotcom/charlie-deep-research/blob/main/cic_design_system.md) | [CIC_DESIGN_SYSTEM_ENFORCEMENT.md](https://github.com/sorensencc-dotcom/charlie-deep-research/blob/main/docs/CIC_DESIGN_SYSTEM_ENFORCEMENT.md)

When embedding or regenerating diagrams, prefer \`node scripts/regenerate-wiki-diagrams-cic.mjs\` (readable parchment tokens from cic_design_system) over ad-hoc styling.

`;
  // Insert after first horizontal rule following intro, or after first paragraph block
  if (content.includes('\n---\n')) {
    return content.replace('\n---\n', '\n---\n' + block + '\n---\n');
  }
  return content + '\n' + block;
}

function updateFooter(content) {
  const line =
    '*Diagrams: [CIC Industrial Design System](https://github.com/sorensencc-dotcom/charlie-deep-research/blob/main/cic_design_system.md) (readable parchment) | local `C:\\dev\\charlie-deep-research\\cic_design_system.md` / `docs\\CIC_DESIGN_SYSTEM_ENFORCEMENT.md`*';
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
  if (/classDef\s+\w+\s+fill:#1A1410/i.test(text) || /classDef\s+\w+\s+fill:#2C2420/i.test(text)) {
    effects.push('dark-node-fill');
  }
  return { off, effects };
}

function main() {
  const { palette: P, source } = loadPalette();
  const allowed = allowlist(P);
  const hexMap = buildHexRemap(P);
  console.log('[CIC] Allowlist:', [...allowed].join(', '));
  console.log('[CIC] Token source:', source);
  console.log('[CIC] Readable field: paper=' + P.paper + ' node=' + P.node + ' ink=' + P.ink + ' ember=' + P.ember + ' brass=' + P.strokes);

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
    mode: 'readable-parchment',
    tokenSource: source,
    allowlist: [...allowed],
    fills: { paper: P.paper, node: P.node, ink: P.ink, ember: P.ember, brass: P.strokes, muted_ink: P.muted_ink },
    mdChanged,
    htmlChanged,
    pngChanged,
    remainingDrift: still,
  };
  fs.writeFileSync(path.join(repoRoot, '.wiki-cic-regen-receipt.json'), JSON.stringify(receipt, null, 2));
  console.log('\n[CIC] Done.', { mdChanged, htmlChanged, pngChanged, drift: still.length });
}

main();
