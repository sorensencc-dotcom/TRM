---
title: "A successful wiki push no longer reports failure when the temp clone can't be deleted"
author: Chris
date: 2026-11-06
branch: fix/wiki-sync-cleanup-eperm
cost: { minutes: 1, tokens: 1118 }
id: l-9d12d6b0
scope: repo
status: active
src: agent
touches:
  - scripts/remove-temp-dir.cjs
  - scripts/sync-remote-wiki.mjs
---

## Decided
Cleanup of the temporary wiki clone must never change the publish result. It clears read-only flags, retries once, then warns and moves on. Each run also sweeps older leftover clones (over an hour old) from the temp folder, so a clone that could not be deleted is removed next time.

## Tried and ruled out
Plain recursive force delete: it still failed. Git marks pack files read-only, and on Windows that blocks the delete with EPERM. A run without a push cleaned up fine, so the failure showed up only after a push.

## Watch out
The script deletes its own temp clone, so you cannot inspect the staged wiki commit afterward. To diff it, clone the wiki by hand and copy wiki/ over it, then compare with git diff --cached --ignore-cr-at-eol. The 19-file, 10288-line wiki diff was line endings only.

In the code:
- scripts/remove-temp-dir.cjs: removeTempDir
- scripts/sync-remote-wiki.mjs: finally block
- tests/scripts/remove-temp-dir.test.ts
