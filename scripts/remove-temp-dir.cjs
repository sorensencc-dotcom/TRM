'use strict';
const fs = require('node:fs');
const path = require('node:path');

function makeWritable(target) {
  try {
    const stat = fs.lstatSync(target);
    fs.chmodSync(target, stat.isDirectory() ? 0o777 : 0o666);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target)) makeWritable(path.join(target, entry));
    }
  } catch {
    // best effort: removal below reports the real failure
  }
}

/**
 * Remove a temp directory without ever throwing. Git marks pack files read-only,
 * and on Windows that makes rmSync fail with EPERM. Clear the read-only flags and
 * retry once; if removal still fails, warn and return false so the caller keeps
 * its own exit status.
 */
function removeTempDir(dir, { rm = fs.rmSync, warn = console.warn } = {}) {
  if (!fs.existsSync(dir)) return true;
  const opts = { recursive: true, force: true, maxRetries: 3, retryDelay: 100 };
  try {
    rm(dir, opts);
    return true;
  } catch {
    makeWritable(dir);
  }
  try {
    rm(dir, opts);
    return true;
  } catch (error) {
    warn(`[WIKI-SYNC] Could not remove temp clone ${dir}: ${error.code ?? error.message}. Delete it by hand.`);
    return false;
  }
}

/**
 * Remove leftover clones from earlier runs whose own cleanup failed. Only touches
 * directories that start with `prefix` and are older than `minAgeMs`, so a run
 * that is still in progress is left alone.
 */
function sweepStaleTempDirs(root, prefix, { minAgeMs = 3600000, now = Date.now(), ...opts } = {}) {
  let removed = 0;
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const full = path.join(root, name);
    try {
      if (now - fs.statSync(full).mtimeMs < minAgeMs) continue;
    } catch {
      continue;
    }
    if (removeTempDir(full, opts)) removed += 1;
  }
  return removed;
}

module.exports = { removeTempDir, sweepStaleTempDirs };
