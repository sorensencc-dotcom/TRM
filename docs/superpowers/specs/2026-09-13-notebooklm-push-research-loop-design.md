# NotebookLM push-research loop — design

**Date:** 2026-09-13
**Status:** Draft, revised post-review (2026-09-13)

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
                    --notebook-id <id> [--auto-import|--wait-and-import] [--force]
nlm research status <notebook_id> [--task-id] [--max-wait] [--poll-interval]
nlm research import <notebook_id> [task_id] [--cited-only] [--indices ...]
```

Verified live against the installed binary (`nlm research start/status/import
--help`, 2026-09-13): `--cited-only` exists **only** on `research import`,
not on `start`. `start --wait-and-import` waits and imports **all**
discovered sources with no cited-only filter. Dispatch therefore cannot be a
single `start --wait-and-import --cited-only` call — see the corrected
3-step sequence in "New command" below.

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
- Not building cross-process locking. `research-notebooklm` assumes a
  single running instance at a time, same assumption the existing
  Windows Task Scheduler wrapper already relies on for
  `mine-notebooklm` (default scheduler behavior does not overlap runs
  of the same task). If ever invoked concurrently, the last
  `writeFileAtomic` write wins and an in-flight dispatch could
  duplicate; not guarded against.
- Not garbage-collecting `research_queue` entries whose question text
  no longer exists in `config/mining-questions.json` (e.g. after a
  question is reworded). Orphaned entries sit inertly — bounded by
  question-set size (tens of entries, not unbounded growth) — and are
  simply never revisited. Acceptable dead weight, not cleaned up.

## Data model

Extend `src/notebooklm/registry.ts`.

```ts
export interface ResearchQueueEntry {
  question_hash: string;               // sha256 of question text
  question_text: string;
  question_id: string;                 // MiningQuestion.id, for gap_key rebuild
  gap_key: string;                     // mineNotebooklm.answerKey() value at
                                        // upsert time — same string
                                        // appendTodoIfUrgent already wrote to
                                        // TODOS.md, reused so a stall append
                                        // dedupes against it
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
  upsertResearchQueueEntry(root, notebookId, question, key, config.dispatch_limits.default_mode);
}
```

`key` here is the same `answerKey(notebookId, question.id, result.data)`
string already computed at `mineNotebooklm.ts:200` and passed to
`appendTodoIfUrgent` — reused verbatim as `gap_key`, not recomputed.

`upsertResearchQueueEntry` (new function in `registry.ts`):
- If no entry exists for `question_hash`, create one with
  `status: 'PENDING'`, zeroed counters, `question_id` and `gap_key` set
  from the arguments above.
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
- `notebookId` given: look it up with `findNotebook` (same helper
  `mineNotebooklm.ts:184` uses). Not found → throw, same as
  `runMineNotebooklm` does at `mineNotebooklm.ts:186`
  (`notebooklm-registry.json has no entry for notebook "<id>"`) — no
  silent skip.
- omitted: iterate every notebook in the registry ordered by
  soonest-starved-first: notebooks whose `research_queue` contains a
  `PENDING` entry with the oldest `last_researched_at`
  (`null` sorts before any timestamp — never-yet-researched notebooks
  go first) come first; tie-break by `notebookId` ascending for
  determinism. Apply the per-notebook cap to each and a running
  `max_jobs_per_run_global` cap across the whole invocation. Once the
  global cap is hit, stop dispatching — remaining eligible entries are
  untouched (no state penalty) and picked up next run.

**Per-queue-entry logic**, in question order within a notebook:

1. `status` is `STALLED_NEEDS_HUMAN` or `INFRASTRUCTURE_BLOCKED` →
   skip.
2. Not `--force-research` and inside the cooldown window
   (`now - last_researched_at < cooldown_days_fast|deep` based on
   `mode`) → skip.
3. Otherwise dispatch, as three sequential `nlm` calls (confirmed
   against the installed CLI's `--help` output 2026-09-13 — `start`
   has no `--cited-only`, and `--wait-and-import` imports every
   discovered source unfiltered, which would defeat the cited-only
   signal-to-noise requirement):
   ```
   nlm research start "<question_text>" --notebook-id <id>
       --source web --mode <mode> [--force]   # --force only if --force-research
   # capture task id from stdout
   nlm research status <id> --task-id <task_id> --max-wait 300
   # blocks (default poll-interval 30s) until the task completes or times out
   nlm research import <id> <task_id> --cited-only
   ```
   Any of the three steps failing nonzero is a transient failure for
   the whole attempt (see below) — there is no partial-success state.

**On success** (all three calls exit 0, `status` reports the task
completed rather than timed out):
- `attempt_count += 1`
- `last_researched_at = now`
- `consecutive_dispatch_failures = 0`
- `last_dispatch_error = null`
- Stall check: immediately re-run `queryNotebook(notebookId,
  question_text)` (the same call `mine-notebooklm` makes) against the
  now-updated notebook and re-test the answer against
  `URGENCY_PATTERNS`. This is the concrete mechanism for "still urgent
  after research" — it does not wait for the next scheduled mining
  pass, and does not read `TODOS.md` or the research-gaps doc as a
  proxy.
  - Still urgent **and** `attempt_count >= max_attempts_before_stall`
    → `status = 'STALLED_NEEDS_HUMAN'`, append a `TODOS.md` line
    tagged `[STALLED]` using the entry's stored `gap_key` as the
    idempotency key (same key format `appendTodoIfUrgent` already
    checked for/wrote at gap-creation time, so the existing "does
    content already include this key" guard in
    `appendTodoIfUrgent`-style logic dedupes correctly).
  - Still urgent, attempts remain → `status` stays `PENDING` (eligible
    again after cooldown).
  - No longer urgent → `status = 'EXECUTED'`.

**On transient failure** (any of the three calls exits nonzero —
network/quota/timeout, or `start` reports a conflicting already-pending
research task without `--force`):
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
- explicit `notebookId` not present in registry throws, matching
  `runMineNotebooklm`'s behavior
- success path re-queries the notebook for the stall check and
  transitions to `EXECUTED` when the re-query is no longer urgent,
  even if `attempt_count >= max_attempts_before_stall`
- global-cap notebook ordering picks the notebook with the oldest
  `last_researched_at` (including `null`) first, tie-broken by
  notebookId

No test talks to the real `nlm` binary or a real NotebookLM notebook,
consistent with the existing suite.
