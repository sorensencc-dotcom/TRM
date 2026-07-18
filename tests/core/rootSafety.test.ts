import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { assertSafeRoot } from '../../src/core/rootSafety';

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trm-rootsafety-'));
}

function initGitRepo(dir: string, withRemote: boolean): void {
  const gitDir = path.join(dir, '.git');
  fs.mkdirSync(gitDir, { recursive: true });
  const config = withRemote
    ? '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://github.com/example/example.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n'
    : '[core]\n\trepositoryformatversion = 0\n';
  fs.writeFileSync(path.join(gitDir, 'config'), config, 'utf-8');
}

describe('assertSafeRoot', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkTmpDir();
    delete process.env.TRM_ALLOW_GIT_ROOT;
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.TRM_ALLOW_GIT_ROOT;
  });

  it('passes silently when no .git is found anywhere above root', () => {
    const dataDir = path.join(tmpRoot, 'no-git-here');
    fs.mkdirSync(dataDir, { recursive: true });
    expect(() => assertSafeRoot(dataDir)).not.toThrow();
  });

  it('passes silently when .git exists at root with no remote configured', () => {
    initGitRepo(tmpRoot, false);
    expect(() => assertSafeRoot(tmpRoot)).not.toThrow();
  });

  it('passes silently when .git with no remote is found in an ancestor directory', () => {
    initGitRepo(tmpRoot, false);
    const nested = path.join(tmpRoot, 'topics', 'charlie', 'cuba');
    fs.mkdirSync(nested, { recursive: true });
    expect(() => assertSafeRoot(nested)).not.toThrow();
  });

  it('throws when .git at root has a remote configured', () => {
    initGitRepo(tmpRoot, true);
    expect(() => assertSafeRoot(tmpRoot)).toThrow(/remote/i);
  });

  it('throws when .git with a remote is found in an ancestor directory', () => {
    initGitRepo(tmpRoot, true);
    const nested = path.join(tmpRoot, 'trm-data', 'topics', 'charlie', 'cuba');
    fs.mkdirSync(nested, { recursive: true });
    expect(() => assertSafeRoot(nested)).toThrow(/remote/i);
  });

  it('does not throw when a remote is configured but TRM_ALLOW_GIT_ROOT=1 is set', () => {
    initGitRepo(tmpRoot, true);
    process.env.TRM_ALLOW_GIT_ROOT = '1';
    expect(() => assertSafeRoot(tmpRoot)).not.toThrow();
  });

  it('error message names the offending path and the override env var', () => {
    initGitRepo(tmpRoot, true);
    try {
      assertSafeRoot(tmpRoot);
      throw new Error('expected assertSafeRoot to throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain(tmpRoot);
      expect(message).toContain('TRM_ALLOW_GIT_ROOT');
    }
  });
});
