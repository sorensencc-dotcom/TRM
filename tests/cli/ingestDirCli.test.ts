import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-ingestdir-cli-'));
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({ default_scoring_adapter: 'stub', promotion_threshold: 80, actor_source: 'cli-only', time_source: 'system' })
  );
  return root;
}

function runCli(args: string[], cwd: string): { status: number; output: string } {
  try {
    const output = execFileSync('ts-node', ['src/cli/index.ts', ...args], {
      cwd: path.resolve(__dirname, '..', '..'),
      encoding: 'utf-8',
      shell: true,
      env: { ...process.env, TRM_ALLOW_GIT_ROOT: '1' },
    });
    return { status: 0, output };
  } catch (err: any) {
    return { status: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('trm ingest-dir CLI -- trim/keyword flags', () => {
  it('rejects a malformed --start before touching any file (non-zero exit)', () => {
    const root = makeRoot();
    const dir = path.join(root, 'input-dir');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'doc.txt'), 'content', 'utf-8');

    const { status, output } = runCli(
      ['ingest-dir', 'topic1', '--dir', dir, '--stub', '--start', 'bogus'],
      root
    );

    expect(status).not.toBe(0);
    expect(output).toMatch(/Invalid time format/);
  });

  it('rejects --retry-failed combined with --start', () => {
    const root = makeRoot();
    const dir = path.join(root, 'input-dir');
    fs.mkdirSync(dir);

    const { status, output } = runCli(
      ['ingest-dir', 'topic1', '--dir', dir, '--stub', '--retry-failed', '--start', '00:10'],
      root
    );

    expect(status).not.toBe(0);
    expect(output).toMatch(/--retry-failed cannot be combined/);
  });

  it('exits non-zero when the batch has a failure', () => {
    const root = makeRoot();
    const dir = path.join(root, 'input-dir');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'bad.png'), 'not a real image', 'utf-8');

    const { status } = runCli(['ingest-dir', 'topic1', '--dir', dir, '--stub'], root);

    expect(status).not.toBe(0);
  });
});
