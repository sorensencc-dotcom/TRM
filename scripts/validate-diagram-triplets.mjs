import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const wikiDir = path.join(repoRoot, 'wiki');

if (!fs.existsSync(wikiDir)) {
  process.exit(0);
}

const files = fs.readdirSync(wikiDir);
const mdFiles = files.filter(f => f.endsWith('.md'));

let hasErrors = false;

for (const mdFile of mdFiles) {
  const mdPath = path.join(wikiDir, mdFile);
  const content = fs.readFileSync(mdPath, 'utf8');

  // Regex to find diagram image references: ![...](<diagram>.png)
  const imageRegex = /!\[([^\]]*)\]\(([^)]+\.png)\)/g;
  let match;

  while ((match = imageRegex.exec(content)) !== null) {
    const pngName = match[2];
    const baseName = path.basename(pngName, '.png');

    const pngPath = path.join(wikiDir, pngName);
    const htmlPath = path.join(wikiDir, `${baseName}.html`);

    const missing = [];
    if (!fs.existsSync(pngPath)) missing.push(pngName);
    if (!fs.existsSync(htmlPath)) missing.push(`${baseName}.html`);

    if (missing.length > 0) {
      console.error(`\n[GOVERNANCE ERROR] Rule 12 Violation in wiki/${mdFile}:`);
      console.error(`  Referenced diagram asset '${pngName}' is missing required companion files:`);
      missing.forEach(m => console.error(`    ❌ Missing: wiki/${m}`));
      hasErrors = true;
    }

    // Check for required <details><summary>Mermaid source...</summary> block
    if (!content.includes('<summary>Mermaid source') && !content.includes('<summary>Mermaid Source')) {
      console.error(`\n[GOVERNANCE ERROR] Rule 12 Violation in wiki/${mdFile}:`);
      console.error(`  Missing required <details><summary>Mermaid source...</summary></details> block for '${pngName}'.`);
      hasErrors = true;
    }
  }
}

if (hasErrors) {
  console.error(`\nCommit rejected under Technical Writing Rule 12 (Cathryn Lavery Diagram Standard).`);
  process.exit(1);
} else {
  console.log(`✓ Diagram triplets verification passed.`);
}
