# Web search fallback/bypass for NotebookLM research loop — design

## Context

trm's push-research loop (separate spec: `2026-09-13-notebooklm-push-research-loop-design.md`, plan: `2026-09-13-notebooklm-push-research-loop.md`) dispatches gaps from a registry `research_queue` to `nlm research`. That spec explicitly scoped out direct Firecrawl/Parallel web search as a non-goal ("a separate spec"). This is that spec.

**Prerequisite:** this design assumes the other plan's `research_queue`/`ResearchQueueEntry` registry fields, `researchNotebooklm.ts` dispatch command, and status enum (`PENDING`, `EXECUTED`, `STALLED_NEEDS_HUMAN`, `INFRASTRUCTURE_BLOCKED`) exist. As of this writing that plan has not been implemented in the checkout — implement it first, or implement this spec's tasks as part of the same implementation effort in dependency order.

**Deferred (sub-project B, separate future spec):** a proactive "research consultant" track — independent cadence/topics, urgent-gap escalation as a challenge/second-opinion check, a 3-question contradiction-resolution retry loop, and human notification on unresolved contradictions or newly-discovered topics. That system is built on top of this one; brainstorm it separately once this ships.

## Decisions

- **Provider:** Parallel.ai search API only. Direct HTTP wrapper in trm, no Firecrawl, no runtime dependency on the `toolforge` repo's existing `parallel-search` skill — only the API key is shared.
- **Credential:** `PARALLEL_API_KEY`. Not currently loaded anywhere in trm's `src/core/config.ts` — add it there as a new required-for-web-search secret (see Error handling: lazy fail-fast, not unconditional). Value comes from the same key already provisioned at `C:\Users\soren\.secrets\parallel.env` for the `toolforge` project; no new key needed.
- **Trigger modes**, keyed off a new `web_strategy` field on `ResearchQueueEntry` (named to avoid colliding with that type's existing `mode: "fast" | "deep"` field):
  - `web_strategy === "web"` — bypass `nlm research` entirely, go straight to Parallel search on the entry's next eligible dispatch. Set at gap-creation time by whatever process files the gap (human or upstream).
  - `web_strategy === "auto"` or unset — run `nlm research`'s existing multi-attempt retry/cooldown loop exactly as the prerequisite plan defines it (`attempt_count`, `max_attempts_before_stall`, cooldowns). Do **not** fall back to Parallel on every weak attempt — only at the point the entry would otherwise transition to `STALLED_NEEDS_HUMAN` (i.e. `attempt_count >= max_attempts_before_stall` and `isUrgentAnswer` is still true on the re-query). At that last-resort point, attempt Parallel search instead of stalling immediately; only stall if the Parallel attempt also fails or returns zero hits.
  - `web_strategy === "notebook"` — today's existing behavior, unchanged. Not new code — this value simply means "never branch into this spec's logic," including no last-resort fallback.
- **Weak-result detection:** reuse `isUrgentAnswer` (exported by the prerequisite plan's Task 4 from `src/cli/commands/mineNotebooklm.ts`) — no new detection function. The prerequisite plan's `recordSuccess` in `researchNotebooklm.ts` already calls `isUrgentAnswer` on the post-dispatch re-query result; this spec's fallback branch hooks into that same call site rather than duplicating it.
- **Wire contract (verified against `parallel-web` SDK's bundled `.d.ts`, `beta.search`, in `toolforge`'s `skills/parallel-search/node_modules/parallel-web/resources/beta/beta.d.ts`, 2026-09-14):**
  - `POST https://api.parallel.ai/v1beta/search`, header `x-api-key: <PARALLEL_API_KEY>`.
  - Request body (`BetaSearchParams`): `{ objective?: string; search_queries?: string[]; excerpts?: boolean }`. At least one of `objective`/`search_queries` required — trm sends `{ search_queries: [gap.question], excerpts: true }`.
  - Response body (`SearchResult`): `{ results: WebSearchResult[]; search_id: string; usage?: unknown; warnings?: unknown }`, where `WebSearchResult = { url: string; title?: string | null; excerpts?: string[] | null; publish_date?: string | null }`.
  - trm's `WebSearchHit` maps 1:1 from `WebSearchResult`: `title` (fallback `"(untitled)"` if null), `url`, `snippet` (first entry of `excerpts`, or `""` if empty/null).
- **Output:** web search hits get written to a staged evidence markdown file, then ingested into NotebookLM as a new source via:
  ```
  nlm source add <notebook_id> --file <path> --title "TRM Evidence: {gap_id}" --wait
  ```
  Verified live 2026-09-14: `nlm source add` takes a positional `notebook_id` argument plus `--file`/`--title`/`--wait`/`--wait-timeout` flags. There is no `--notebook-id` flag and no `source create` subcommand. This keeps NotebookLM as the single source of truth — a later `mine-notebooklm` pass answers the gap's question normally, now grounded in the imported evidence.
- **Registry:** add `"EVIDENCE_IMPORTED"` as a new value in the existing `status` union on `ResearchQueueEntry` (the prerequisite plan's real field name is `status`, not `dispatch_status` — corrected here), plus optional `imported_source?: string` and `last_updated_at?: string` (ISO timestamp) — optional because they're absent until the first successful web-dispatch. Set together via `flushResearchQueueEntry` (the prerequisite plan's existing patch helper — not a new upsert call), only on full success (search + write + upload all succeed). On success, `attempt_count`, `consecutive_dispatch_failures`, and `last_dispatch_error` are reset the same way `recordSuccess` already resets them today. On failure at any step, leave `status` as `STALLED_NEEDS_HUMAN` (the prerequisite plan's existing last-resort transition fires as normal) plus append the existing stalled-TODO line via `appendStalledTodo` — this spec does not suppress that fallback path, it only inserts an extra attempt before it fires.

## Components

- **`src/research/webSearch.ts`** (new)
  - `interface WebSearchHit { title: string; url: string; snippet: string }`
  - `interface WebSearchResult { query: string; hits: WebSearchHit[] }`
  - `async function searchWeb(query: string): Promise<WebSearchResult>` — `POST https://api.parallel.ai/v1beta/search`, header `x-api-key: <PARALLEL_API_KEY>`, body `{ search_queries: [query], excerpts: true }` (see wire contract in Decisions above). Parses `SearchResult.results` into `WebSearchResult.hits`. Throws on non-2xx response, network failure, or a body missing/non-array `results`. Direct `fetch` call — no `parallel-web` SDK dependency, to keep trm's own dependency tree independent of `toolforge`'s. Pure function: no filesystem or registry access, independently testable via mocked `fetch`.
- **`src/research/evidenceWriter.ts`** (new)
  - `function writeEvidenceMarkdown(gapId: string, query: string, result: WebSearchResult): string` — validates `gapId` against the registry's existing id format (alphanumeric + dash only, max 64 chars — reject anything else before it touches a path; guards against the MAX_PATH issues this repo has hit before, see `project-notebooklm-ingest-live-bugs-2026-08-13`) and writes a markdown document (query, then each hit as `### {title}` / url / snippet) to `_kb-sync-staging/trm/gap-{gapId}-evidence.md`. Returns the absolute path. Overwrites any existing file at that path (no cross-attempt reuse — see Error handling).
- **`src/notebooklm/registry.ts`** (modify) — extend `ResearchQueueEntry` with `web_strategy?: "web" | "auto" | "notebook"`, add `"EVIDENCE_IMPORTED"` to the `status` union, add `imported_source?: string`, `last_updated_at?: string`. Update via the existing `flushResearchQueueEntry` helper — no new registry-mutation helper.
- **`src/core/config.ts`** (modify) — add `PARALLEL_API_KEY` to the loaded config shape. Loading happens unconditionally (cheap env read); *validation* (throwing if absent) happens lazily, only at the point a gap with `web_strategy !== "notebook"` is actually about to be dispatched — not at CLI startup, so notebook-only runs are unaffected by a missing key.
- **`src/cli/commands/researchNotebooklm.ts`** (modify, existing dispatch command from the other plan) — add the strategy branch inline in `dispatchCandidate`/`recordSuccess`. No new `router.ts` file; one command owns "what happens to a gap."

## Data flow

1. Dispatch loop selects a gap from `research_queue` (existing `selectDispatchPlan`/`orderedEligibleEntries` logic from the other plan).
2. `web_strategy === "web"` → skip straight to step 4 on this entry's next eligible dispatch (still subject to the same cooldown/eligibility gating as any other entry).
3. Else run `nlm research` through the existing `dispatchCandidate` → `recordSuccess` flow unchanged. `recordSuccess` already re-queries the notebook and checks `isUrgentAnswer`. If not urgent → `EXECUTED`, stop, nothing here fires. If still urgent and `attemptCount < max_attempts_before_stall` → `PENDING`, stop, nothing here fires (normal retry, waits for cooldown). If still urgent and `attemptCount >= max_attempts_before_stall` — this is the last-resort point — continue to step 4 instead of immediately calling `appendStalledTodo`/setting `STALLED_NEEDS_HUMAN`.
4. `searchWeb(gap.question_text)`.
5. `writeEvidenceMarkdown(gap.question_id, gap.question_text, result)` → local path (using `question_id`, the human-readable slug, not `question_hash`, for the filename).
6. `nlm source add <notebook_id> --file <path> --title "TRM Evidence: {question_id}" --wait`.
7. On success of both 4-6: `flushResearchQueueEntry` sets `status: "EVIDENCE_IMPORTED"`, `imported_source`, `last_updated_at`, and resets `consecutive_dispatch_failures`/`last_dispatch_error` the same way a normal success does.
8. On failure at step 4, 5, or 6 (search error, zero hits, invalid id, or upload failure): fall through to the prerequisite plan's existing stall behavior — `status: "STALLED_NEEDS_HUMAN"` and `appendStalledTodo` — unchanged from what the other plan already does today at this point.

## Error handling

- **`web_strategy === "web"` path (no existing fallback to fall through to):** `searchWeb`/`writeEvidenceMarkdown`/`nlm source add` failure is recorded via `recordTransientFailure` (the prerequisite plan's existing helper) — increments `consecutive_dispatch_failures`, stays `PENDING` until `max_consecutive_dispatch_failures` is reached, then `INFRASTRUCTURE_BLOCKED`. Same treatment as an `nlm research` transient failure gets today.
- **Last-resort fallback path (`auto` at stall point) failure:** search/write/upload failure here falls through to `STALLED_NEEDS_HUMAN` + `appendStalledTodo`, exactly what would have happened without this spec — this spec only delays that outcome by one extra attempt, never suppresses it.
- **`PARALLEL_API_KEY` missing:** thrown lazily at first web-dispatch attempt in a run, not at CLI startup. One clear error per run, not per-gap spam (log once, skip remaining web-strategy/fallback gaps for that run — they're treated as the failure cases above, not silently skipped-without-status-change).
- **Zero-hit Parallel result:** treated as failure, not staged/uploaded, same routing as above (transient-failure counter for `"web"`, straight-to-stall for last-resort `"auto"`).
- **Invalid `gapId` (using `question_id`) format:** `writeEvidenceMarkdown` throws before touching the filesystem; treated as a failure like any other step failure, same routing as above.
- **`nlm source add` non-zero exit / spawn failure / timeout:** treated as failure per the routing above. The staged evidence file from this attempt is left in place for debugging but is not reused by the next retry — next dispatch pass regenerates it fresh.
- **Accepted risk (non-goal, matches sibling spec's accepted concurrency/GC gaps):** because each retry re-runs the full search-write-upload sequence rather than resuming a partial attempt, a search-succeeds-but-upload-fails attempt followed by a successful retry can leave one orphaned/duplicate NotebookLM source from the failed attempt. No dedup/reconciliation against existing NotebookLM sources is built. Retries only happen on infra failure (search or upload erroring), not on a fixed schedule, so occurrence is bounded by failure rate, not routine; orphaned sources are harmless extra context, not incorrect answers.

## Non-goals

- Firecrawl support, multi-provider selection.
- The proactive research-consultant track (sub-project B — separate future spec).
- Rate limiting, per-run search budget, request retry/backoff beyond "try again next dispatch cycle."
- Sanitizing/validating untrusted search-result content beyond path-safe `gapId` handling — web content is trusted at the same level as any other NotebookLM source once imported.
- Atomic file writes / concurrent-writer protection — dispatch is single-process sequential, same accepted non-goal as the sibling spec.
- Deduplication of NotebookLM sources across retried failed uploads (see accepted risk above).

## Testing

- **`webSearch.test.ts`** — mock `fetch`: request shape (`search_queries`, `x-api-key` header) is correct; successful response parses `SearchResult.results` into `WebSearchResult.hits`; non-2xx response throws; malformed/unparseable 2xx body (missing/non-array `results`) throws; network failure throws.
- **`evidenceWriter.test.ts`** — valid input produces expected markdown content at the expected path (tmpdir fixture, mirrors `registry.test.ts` pattern); invalid id (path-traversal characters, non-alphanumeric-dash, over 64 chars) throws before any file write.
- **`researchNotebooklm.test.ts`** (extend, same file/fixtures as the prerequisite plan's Task 6 tests) — `jest.mock` `../../research/webSearch`, `../../research/evidenceWriter`, and the existing `nlmResearch`/`nlmCli` mocks:
  - `web_strategy: "web"` skips `researchStart`/`researchStatus`/`researchImport` entirely, calls `searchWeb` directly.
  - `web_strategy: "auto"` (or unset) with `attempt_count < max_attempts_before_stall` and still-urgent re-query result stays `PENDING` exactly as today — `searchWeb` is never called (regression check that the last-resort gating actually gates).
  - `web_strategy: "auto"` at `attempt_count >= max_attempts_before_stall` with still-urgent re-query result triggers the fallback chain (search → write → upload → registry update) instead of immediately stalling.
  - `web_strategy: "notebook"` behaves identically to today at every attempt count (no `searchWeb` call ever, including at what would be the stall point).
  - Successful fallback chain (either trigger) sets `status: "EVIDENCE_IMPORTED"`, `imported_source`, `last_updated_at`, resets `consecutive_dispatch_failures`/`last_dispatch_error`.
  - Failure at `searchWeb`, `writeEvidenceMarkdown`, or `nlm source add` (non-zero exit) during the last-resort `"auto"` path falls through to `status: "STALLED_NEEDS_HUMAN"` + `appendStalledTodo`, matching the prerequisite plan's existing stall test.
  - Failure at any of those three during a `web_strategy: "web"` dispatch routes through `recordTransientFailure` (`PENDING` then `INFRASTRUCTURE_BLOCKED` after `max_consecutive_dispatch_failures`), matching the prerequisite plan's existing transient-failure test.
  - Missing `PARALLEL_API_KEY` at dispatch time produces one logged error and is treated as a failure via the routing above for the gap(s) that needed it, without crashing dispatch of other, non-web gaps in the same run.
- No live Parallel or `nlm` calls in any test — everything mocked, matching existing convention (`nlm` CLI tests never call the live binary).
