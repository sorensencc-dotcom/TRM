import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import os from 'node:os';

const repoRoot = process.cwd();
const wikiDir = path.join(repoRoot, 'wiki');

console.log('[WIKI-SYNC] Step 1: Validating local diagram triplets...');
execSync('node scripts/validate-diagram-triplets.mjs', { stdio: 'inherit', cwd: repoRoot });

const remoteWikiUrl = 'https://github.com/sorensencc-dotcom/TRM.wiki.git';
const tempDir = path.join(os.tmpdir(), `trm-wiki-sync-${Date.now()}`);

try {
  console.log(`[WIKI-SYNC] Step 2: Cloning remote wiki (${remoteWikiUrl})...`);
  execSync(`git clone ${remoteWikiUrl} "${tempDir}"`, { stdio: ['pipe', 'pipe', 'inherit'] });

  console.log('[WIKI-SYNC] Step 3: Copying wiki assets...');
  fs.cpSync(wikiDir, tempDir, { recursive: true, force: true });

  console.log('[WIKI-SYNC] Step 4: Staging, committing, and pushing to remote wiki...');
  execSync('git add -A', { cwd: tempDir, stdio: 'inherit' });

  const status = execSync('git status --porcelain', { cwd: tempDir, encoding: 'utf8' });
  if (status.trim().length === 0) {
    console.log('✓ Remote wiki is already synchronized with local wiki/.');
  } else {
    execSync('git commit -m "docs(wiki): automated sync of wiki markdown and diagram assets"', {
      cwd: tempDir,
      stdio: 'inherit'
    });
    execSync('git push origin master', { cwd: tempDir, stdio: 'inherit' });
    console.log('✓ Remote GitHub Wiki successfully updated and published.');
  }
} finally {
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
