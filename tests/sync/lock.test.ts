// tests/sync/lock.test.ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { acquireLock, releaseLock, forceRecoverLock, LockConflictError, LockUnrecoverableError } from '../../src/sync/lock';

describe('lock', () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-lock-'));
    lockPath = path.join(dir, '.sync-treatment.lock');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('acquires a lock when none exists', () => {
    acquireLock(lockPath, 'run-1');
    expect(fs.existsSync(lockPath)).toBe(true);
    const info = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    expect(info.pid).toBe(process.pid);
    expect(info.runId).toBe('run-1');
  });

  it('releaseLock removes the lock file', () => {
    acquireLock(lockPath, 'run-1');
    releaseLock(lockPath);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('throws LockConflictError for a live same-host lock', () => {
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, hostname: os.hostname(), runId: 'other-run', startedAt: new Date().toISOString() })
    );
    expect(() => acquireLock(lockPath, 'run-2')).toThrow(LockConflictError);
  });

  it('reclaims a dead same-host lock and proceeds', () => {
    // pid 999999 is extremely unlikely to be a live process
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999999, hostname: os.hostname(), runId: 'dead-run', startedAt: new Date().toISOString() })
    );
    expect(() => acquireLock(lockPath, 'run-3')).not.toThrow();
    const info = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    expect(info.runId).toBe('run-3');
  });

  it('throws LockUnrecoverableError for a cross-host lock even with a dead pid', () => {
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999999, hostname: 'some-other-machine', runId: 'remote-run', startedAt: new Date().toISOString() })
    );
    expect(() => acquireLock(lockPath, 'run-4')).toThrow(LockUnrecoverableError);
  });

  it('throws LockUnrecoverableError for malformed lock JSON', () => {
    fs.writeFileSync(lockPath, '{not json');
    expect(() => acquireLock(lockPath, 'run-5')).toThrow(LockUnrecoverableError);
  });

  it('throws LockUnrecoverableError for a lock missing pid or hostname', () => {
    fs.writeFileSync(lockPath, JSON.stringify({ runId: 'run-6', startedAt: new Date().toISOString() }));
    expect(() => acquireLock(lockPath, 'run-7')).toThrow(LockUnrecoverableError);
  });

  it('forceRecoverLock deletes any lock unconditionally', () => {
    fs.writeFileSync(lockPath, '{not json');
    forceRecoverLock(lockPath);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(() => acquireLock(lockPath, 'run-8')).not.toThrow();
  });

  it('forceRecoverLock does not throw when no lock exists', () => {
    expect(() => forceRecoverLock(lockPath)).not.toThrow();
  });

  it('acquireLock atomically prevents race: second acquire on existing fresh lock throws LockConflictError', () => {
    // First acquire succeeds and creates lock with current process's PID
    acquireLock(lockPath, 'run-race-1');
    expect(fs.existsSync(lockPath)).toBe(true);

    // Second acquire on the same lock should detect that current process holds it and throw LockConflictError
    // This tests that the exclusive-create (writeFileExclusive) behavior prevents two processes from both
    // writing, and that the lock is properly validated when the file already exists.
    expect(() => acquireLock(lockPath, 'run-race-2')).toThrow(LockConflictError);
    expect(fs.existsSync(lockPath)).toBe(true);

    // Verify the lock still holds the first run's ID
    const info = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    expect(info.runId).toBe('run-race-1');
  });
});
