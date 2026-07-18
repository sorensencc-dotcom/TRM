import * as fs from 'node:fs';
import * as path from 'node:path';

function hasConfiguredRemote(gitConfigPath: string): boolean {
  if (!fs.existsSync(gitConfigPath)) return false;
  const content = fs.readFileSync(gitConfigPath, 'utf-8');
  return /\[remote\s+"[^"]+"\]/.test(content);
}

function findEnclosingGitDir(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, '.git');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function assertSafeRoot(root: string): void {
  if (process.env.TRM_ALLOW_GIT_ROOT === '1') return;

  const gitDir = findEnclosingGitDir(root);
  if (!gitDir) return;

  const configPath = path.join(gitDir, 'config');
  if (!hasConfiguredRemote(configPath)) return;

  const repoDir = path.dirname(gitDir);
  throw new Error(
    `trm refuses to run: "${root}" is inside a git repository at "${repoDir}" ` +
      `that has a remote configured. TRM data must never risk being committed/pushed ` +
      `to a remote. Move the data outside this repo, or set TRM_ALLOW_GIT_ROOT=1 to override.`
  );
}
