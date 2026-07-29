import * as fs from 'node:fs';
import * as os from 'node:os';

export interface LockInfo {
  pid: number;
  hostname: string;
  runId: string;
  startedAt: string;
}

export class LockConflictError extends Error {}
export class LockUnrecoverableError extends Error {}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockInfo(lockPath: string): LockInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
  } catch {
    return null;
  }
  const candidate = parsed as Partial<LockInfo>;
  if (typeof candidate.pid !== 'number' || typeof candidate.hostname !== 'string') return null;
  return {
    pid: candidate.pid,
    hostname: candidate.hostname,
    runId: typeof candidate.runId === 'string' ? candidate.runId : '',
    startedAt: typeof candidate.startedAt === 'string' ? candidate.startedAt : '',
  };
}

function writeLock(lockPath: string, runId: string): void {
  const info: LockInfo = { pid: process.pid, hostname: os.hostname(), runId, startedAt: new Date().toISOString() };
  fs.writeFileSync(lockPath, JSON.stringify(info, null, 2));
}

export function acquireLock(lockPath: string, runId: string): void {
  if (!fs.existsSync(lockPath)) {
    writeLock(lockPath, runId);
    return;
  }

  const info = readLockInfo(lockPath);
  if (!info) {
    throw new LockUnrecoverableError(
      `"${lockPath}" is malformed or missing required fields (pid/hostname) — use --force-recover-lock after confirming no other process is running against this vault`
    );
  }

  if (info.hostname !== os.hostname()) {
    throw new LockUnrecoverableError(
      `"${lockPath}" is held by a different host ("${info.hostname}", pid ${info.pid}, run "${info.runId}") — ` +
        `cross-host locks are never auto-reclaimed; use --force-recover-lock after confirming no other process is running against this vault`
    );
  }

  if (isPidAlive(info.pid)) {
    throw new LockConflictError(`"${lockPath}" is held by pid ${info.pid} (run "${info.runId}") on this host`);
  }

  writeLock(lockPath, runId);
}

export function releaseLock(lockPath: string): void {
  if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
}

export function forceRecoverLock(lockPath: string): void {
  if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
}
