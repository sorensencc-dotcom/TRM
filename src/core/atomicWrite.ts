import * as fs from 'node:fs';
import * as path from 'node:path';

function tempPathFor(file: string): string {
  return `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Windows transiently EPERM/EBUSY-rejects a rename onto a path another
// process (e.g. a cloud-sync client) has open for reading. POSIX rename
// doesn't have this failure mode, so a short retry-with-backoff is safe
// there too -- it just never fires.
function renameSyncWithRetry(tmp: string, file: string): void {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code !== 'EPERM' && code !== 'EBUSY') || attempt === maxAttempts) {
        throw err;
      }
      const delayMs = 25 * 2 ** (attempt - 1);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
}

export function writeFileAtomic(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tempPathFor(file);
  fs.writeFileSync(tmp, contents);
  renameSyncWithRetry(tmp, file);
}

export function writeFileExclusive(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tempPathFor(file);
  fs.writeFileSync(tmp, contents);
  try {
    fs.linkSync(tmp, file);
  } finally {
    fs.unlinkSync(tmp);
  }
}

export function copyFileAtomic(srcPath: string, destPath: string): void {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmp = tempPathFor(destPath);
  fs.copyFileSync(srcPath, tmp);
  renameSyncWithRetry(tmp, destPath);
}
