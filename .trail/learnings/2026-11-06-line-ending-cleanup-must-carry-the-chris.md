---
title: Line-ending cleanup must carry the LF rule onto main before it can renormalize anything
author: Chris
date: 2026-11-06
branch: docs/wiki-entities
cost: { minutes: 1, tokens: 945 }
id: l-cce30726
scope: repo
status: active
src: agent
touches:
  - src/cli/index.ts
---

## Decided
Split the docs and line-ending commits off the mixed branch onto their own branch cut from main, with the LF rule added as the first commit.

## Tried and ruled out
Cherry-picking the renormalize commits straight onto main. The LF rule only exists on the old branch (it arrived with a mining commit), so on main the renormalize step changes nothing and the conflicted file stays mixed. Aborted and restarted with the rule first.

## Watch out
- Where a renormalize cherry-pick conflicts, take main's version and strip CRs with sed. git add --renormalize left it unmerged and mixed.
- Files main changed after the old branch (the NotebookLM mining files) still hold CRLF and need their own renormalize after the mining work is reconciled.

In the code: .gitattributes (text=auto eol=lf), src/cli/index.ts, branch docs/wiki-entities in .worktrees/trm-wiki-entities; backup tag backup/footer-parchment-pre-split-2026-11-05.
