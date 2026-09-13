# NotebookLM push-research loop — design

**Date:** 2026-09-13
**Status:** Draft, pending review

## Problem

`trm mine-notebooklm` only asks a fixed question set against sources
already loaded in a NotebookLM notebook (`queryNotebook`). It never
asks NotebookLM to go find new material. When mining flags an answer
as urgent (`URGENCY_PATTERNS`: "needs verification", "recommend
investigating", "no source found"), that gap sits in
`trm/research-gaps/<slug>.md` and `TODOS.md` with no automated path to
resolution — a human has to notice it and manually run
`nlm research start` themselves.

`nlm` (the NotebookLM CLI already installed, `C:\Users\soren\.local\bin\nlm.exe`)
exposes exactly the missing capability:

```
nlm research start <query> --source web|drive --mode fast|deep
                    --notebook-id <id> [--auto-import]
nlm research status <notebook_id>
nlm research import <notebook_id> [task_id] [--cited-only] [--indices ...]
```

This design adds a closed loop: urgent gap → dispatch web research →
import cited sources → next mining pass sees the new sources and
(maybe) resolves the gap.

## Non-goals

- Not building the "hit the open internet directly via
  Firecrawl/Parallel" leg — that is a separate spec.
- Not changing `queryNotebook`/mining question semantics.
- Not adding a database. This extends the existing flat-JSON registry
  pattern (`notebooklm-registry.json`), consistent with the rest of
  `trm` — no SQLite, no new storage engine.

## Data model

Extend `src/notebooklm/registry.ts`.

```ts
export interface ResearchQueueEntry {
  question_hash: string;               // sha256 of question text
  question_text: string;
  mode: 'fast' | 'deep';
  attempt_count: number;               // completed dispatches only
  consecutive_dispatch_failures: number; // transient failures; resets on success
  last_researched_at: string | null;   // set only on a completed dispatch
  last_dispatch_error: string | null;
  status: 'PENDING' | 'EXECUTED' | 'STALLED_NEEDS_HUMAN' | 'INFRASTRUCTURE_BLOCKED';
}
```

`NotebookRegistryEntry` gains one field:

```ts
research_queue: Record<string /* question_hash */, ResearchQueueEntry>;
```

Existing `RegistryFile`/`readRegistry`/`writeRegistry`/`writeFileAtomic`
plumbing is reused as-is; no new file, no new read/write path.

## Config

Extend `TrmConfig` (`src/core/types.ts`) and `config.json`. Flat,
top-level, matching the existing shape (`default_scoring_adapter`,
`promotion_threshold`, etc. — no nested wrapper key):

```json
{
  "dispatch_limits": {
    "max_jobs_per_notebook": 3,
    "max_jobs_per_run_global": 5,
    "default_mode": "fast",
    "cooldown_days_fast": 14,
    "cooldown_days_deep": 30,
    "max_attempts_before_stall": 3,
    "max_consecutive_dispatch_failures": 5
  }
}
```

All fields optional with these values as defaults, so existing
`config.json` files without `dispatch_limits` keep working.

## Population — `mine-notebooklm` change

`mineNotebooklm.ts` already has a single point where an answer is
tested against `URGENCY_PATTERNS` (`appendTodoIfUrgent`). Add a
sibling call at that same point:

```ts
if (isUrgent) {
  upsertResearchQueueEntry(root, notebookId, question, mode: config.dispatch_limits.default_mode);
}
```

`upsertResearchQueueEntry` (new function in `registry.ts`):
- If no entry exists for `question_hash`, create one with
  `status: 'PENDING'`, zeroed counters.
- If an entry already exists, leave it untouched — this call only
  ensures the queue knows about the gap, it never resets progress or
  cooldowns.

This keeps `mine-notebooklm` read-only toward NotebookLM itself (it
still only calls `queryNotebook`); it does not call `nlm research
start`. Separation of concerns: mining reads and evaluates, dispatch
mutates.

## New command — `trm research-notebooklm [notebookId] [--force-research]`

New file `src/cli/commands/researchNotebooklm.ts`, wired into
`src/cli/index.ts` the same way `mine-notebooklm` is.

**Notebook selection:**
- `notebookId` given: operate on that notebook only, capped at
  `max_jobs_per_notebook`.
- omitted: iterate every notebook in the registry, applying the
  per-notebook cap to each and a running `max_jobs_per_run_global`
  cap across the whole invocation. Once the global cap is hit, stop
  dispatching — remaining eligible entries are untouched (no state
  penalty) and picked up next run.

**Per-queue-entry logic**, in question order within a notebook:

1. `status` is `STALLED_NEEDS_HUMAN` or `INFRASTRUCTURE_BLOCKED` →
   skip.
2. Not `--force-research` and inside the cooldown window
   (`now - last_researched_at < cooldown_days_fast|deep` based on
   `mode`) → skip.
3. Otherwise dispatch:
   ```
   nlm research start "<question_text>" --notebook-id <id>
       --source web --mode <mode> --wait-and-import --cited-only
   ```

**On success** (process exits 0, research completed and import ran):
- `attempt_count += 1`
- `last_researched_at = now`
- `consecutive_dispatch_failures = 0`
- `last_dispatch_error = null`
- if `attempt_count >= max_attempts_before_stall` **and** the question
  is still present as an urgent entry in the latest mining pass for
  this notebook → `status = 'STALLED_NEEDS_HUMAN'` and append a
  `TODOS.md` line tagged `[STALLED]`, same row format
  `appendTodoIfUrgent` already uses (idempotent on the same key).
  Otherwise `status = 'EXECUTED'`.

**On transient failure** (nonzero exit, network/quota/timeout, or a
conflicting already-pending research task without `--force`):
- `attempt_count` unchanged
- `consecutive_dispatch_failures += 1`
- `last_dispatch_error = <message>`
- `status` stays `PENDING` (cooldown is **not** started — this run
  is retried for free next eligible run)
- if `consecutive_dispatch_failures >= max_consecutive_dispatch_failures`
  → `status = 'INFRASTRUCTURE_BLOCKED'` and log a line to the
  scheduler's log output (stdout, captured by the wrapper script) —
  not `TODOS.md`, since this is an operational/CLI-health signal, not
  a research gap.

## Nightly wrapper chaining

`schedule-task-wrapper-TRM-Notebooklm-Mine.ps1` gains a second stage,
run after the existing mining step, same script:

```powershell
node dist/cli/index.js mine-notebooklm ...      # existing
node dist/cli/index.js research-notebooklm      # new, all notebooks
```

`ingest-notebooklm` needs no change — it already pulls whatever new
sources/notes exist in a notebook on its own cadence, which will now
include anything `research-notebooklm` imports.

## Error handling summary

| Condition | attempt_count | consecutive_dispatch_failures | cooldown started | status |
|---|---|---|---|---|
| Dispatch succeeds | +1 | reset to 0 | yes | EXECUTED (or STALLED_NEEDS_HUMAN at cap) |
| Transient failure | unchanged | +1 | no | PENDING (or INFRASTRUCTURE_BLOCKED at cap) |
| Skipped (cooldown/cap/blocked) | unchanged | unchanged | no | unchanged |

## Testing

Mirror `mineNotebooklm.test.ts` conventions: fake `spawnSync`/`nlm`
responses (success, transient failure, already-pending-task), tmpdir
registry fixture, assert state transitions:

- cooldown skip (inside window, not forced)
- `--force-research` bypasses cooldown but not stall/blocked status
- attempt increment + cooldown start on success
- stall transition at `max_attempts_before_stall`
- transient failure leaves `attempt_count`/cooldown untouched,
  increments `consecutive_dispatch_failures`
- `INFRASTRUCTURE_BLOCKED` transition at
  `max_consecutive_dispatch_failures`
- global cap stops dispatch across notebooks; per-notebook cap stops
  dispatch within one notebook
- `TODOS.md` append on stall is idempotent (same key not duplicated)

No test talks to the real `nlm` binary or a real NotebookLM notebook,
consistent with the existing suite.
