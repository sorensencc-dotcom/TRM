import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

function makeVault(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-cli-vault-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ default_scoring_adapter: 'stub', promotion_threshold: 80, actor_source: 'cli-only', time_source: 'system' }));
  fs.mkdirSync(path.join(root, 'topics', 'charlie', 'willow-run', 'extracts'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'topics', 'charlie', 'willow-run', 'extracts', 'extract.json'),
    JSON.stringify({ facts: [{ id: 'FCT-001', text: 'Sorensen visits Willow Run.', source_id: 'SRC-001', confidence: 0.9, categories: ['biography'] }] })
  );
  return root;
}

function makeNarrative(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-cli-narrative-'));
  fs.mkdirSync(path.join(root, 'treatment'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'treatment', 'CIC_SOURCING_DEPENDENCY_MAP_v1.json'),
    JSON.stringify({ matchSchemaVersion: 1, items: [{ id: 'V-5.3', beat: '5.3', claim: 'Sorensen visits Willow Run' }] })
  );
  return root;
}

describe('trm sync-treatment CLI', () => {
  it('runs end-to-end via the CLI entrypoint and prints the report path to stdout', () => {
    const vaultRoot = makeVault();
    const narrativeRoot = makeNarrative();
    try {
      const output = execFileSync(
        'ts-node',
        ['src/cli/index.ts', 'sync-treatment', 'willow-run', '--vault-root', vaultRoot, '--narrative-root', narrativeRoot],
        { cwd: path.resolve(__dirname, '..', '..'), encoding: 'utf-8', shell: true, env: { ...process.env, TRM_ALLOW_GIT_ROOT: '1' } }
      );
      expect(output).toMatch(/TRM_SYNC_REPORT_willow-run_.*\.md/);
    } finally {
      fs.rmSync(vaultRoot, { recursive: true, force: true });
      fs.rmSync(narrativeRoot, { recursive: true, force: true });
    }
  });

  it('exits non-zero and prints clean error message when lock file exists and is unrecoverable', () => {
    const vaultRoot = makeVault();
    const narrativeRoot = makeNarrative();
    const lockPath = path.join(vaultRoot, '.sync-treatment.lock');

    // Create a stale lock file from a different host
    const staleLockInfo = {
      pid: 99999,
      hostname: 'other-host',
      runId: 'stale-run-id',
      startedAt: new Date().toISOString(),
    };
    fs.writeFileSync(lockPath, JSON.stringify(staleLockInfo, null, 2));

    try {
      execFileSync(
        'ts-node',
        ['src/cli/index.ts', 'sync-treatment', 'willow-run', '--vault-root', vaultRoot, '--narrative-root', narrativeRoot],
        { cwd: path.resolve(__dirname, '..', '..'), encoding: 'utf-8', shell: true, env: { ...process.env, TRM_ALLOW_GIT_ROOT: '1' } }
      );
      // Should not reach here
      expect(true).toBe(false);
    } catch (err) {
      // execFileSync throws when exit code is non-zero
      const error = err as any;
      expect(error.status).toBe(1);
      // stderr should contain the error message but NOT stack trace frames
      const stderr = error.stderr?.toString() ?? '';
      expect(stderr).toContain('is held by a different host');
      expect(stderr).not.toMatch(/at /); // No stack trace frames
    } finally {
      fs.rmSync(vaultRoot, { recursive: true, force: true });
      fs.rmSync(narrativeRoot, { recursive: true, force: true });
    }
  });
});
