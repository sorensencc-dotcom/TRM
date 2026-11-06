---
name: lineage-integrity
description: Formally check TRM lineage append integrity when changing `src/lineage/hasher.ts`, its callers, or persistence behavior. Use this before shipping changes that could alter append ordering, concurrent execution, failure recovery, or the lineage file format.
compatibility: Codex with the pstack statechart skill and Bun or another TypeScript runtime
---

# Lineage integrity

The verified promise is that every successful `appendOperation` call remains in the persisted lineage. The harm from breaking it is an audit chain that silently omits a successful ingest, extract, score, crosslink, or version operation.

## Run the check

1. Run the real-code replay from the repository root.

   ```text
   node -r ts-node/register/transpile-only verification/lineage/replay-concurrency.ts
   ```

   The replay must print `concurrent append was rejected` and exit successfully. It proves that the lock rejects the conflicting append and preserves the successful operation.

2. Run `/statechart` on `verification/lineage/LineageAppend.tla` with `verification/lineage/LineageAppend.cfg` and `verification/lineage/view.mjs`.

3. Read every result with `/statechart`. Treat `NoLostSuccessfulAppend` as the user-facing rule. A counterexample means the per-topic lock no longer protects the complete read, hash, and write sequence. A `ChainShape` failure means the model or the code's persisted chain shape no longer matches its contract.

## Model coverage

The model covers two independent processes, one topic, an initially empty chain, and every interleaving of lock acquisition, snapshot, compute, and write steps. It abstracts SHA-256 to a deterministic predecessor-and-actor value because the failure is the lost update, not hash collision behavior. It assumes each modeled write returns successfully and does not model process crashes, filesystem durability, stale-lock recovery, multiple topics, or more than two concurrent processes.

The model describes `acquireLock`, `readLineage`, operation-id derivation, `computeHash`, `lineage.operations.push`, top-level hash assignment, `fs.writeFileSync`, and `releaseLock` in `src/lineage/hasher.ts` and `src/sync/lock.ts`. Callers currently include `src/core/sourceIngest.ts`, `src/core/topicNode.ts`, `src/cli/commands/extract.ts`, `src/cli/commands/score.ts`, `src/cli/commands/crosslink.ts`, and `src/cli/commands/versionBump.ts`.

## Keeping it synchronized

The model was synchronized against the working-tree lock fix on 2026-11-06. The last committed source baseline is `b1982e30ffbfd6248e15663e73c7c6dd3c92ad6a`; move the sync marker to the commit containing this fix only after rerunning the model and replay. If the append protocol changes again, update the model and this skill before treating a passing run as evidence.

Do not weaken `NoLostSuccessfulAppend` to make a run pass. If the current code fails it, report the counterexample in the code's terms and ask for a product fix separately. Use `/maintain-formal-verification-skill` after changes that affect the covered behavior without a fresh synchronization check.
