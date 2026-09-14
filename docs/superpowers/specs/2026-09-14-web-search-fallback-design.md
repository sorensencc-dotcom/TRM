# Web search fallback/bypass for NotebookLM research loop — design

## Context

trm's push-research loop (separate spec: `2026-09-13-notebooklm-push-research-loop-design.md`, plan: `2026-09-13-notebooklm-push-research-loop.md`) dispatches gaps from a registry `research_queue` to `nlm research`. That spec explicitly scoped out direct Firecrawl/Parallel web search as a non-goal ("a separate spec"). This is that spec.

**Prerequisite:** this design assumes the other plan's `research_queue`/`ResearchQueueEntry` registry fields, `researchNotebooklm.ts` dispatch command, and status enum (`PENDING`, `EXECUTED`, `STALLED_NEEDS_HUMAN`, `INFRASTRUCTURE_BLOCKED`) exist. As of this writing that plan has not been implemented in the checkout — implement it first, or implement this spec's tasks as part of the same implementation effort in dependency order.

**Deferred (sub-project B, separate future spec):** a proactive "research consultant" track — independent cadence/topics, urgent-gap escalation as a challenge/second-opinion check, a 3-question contradiction-resolution retry loop, and human notification on unresolved contradictions or newly-discovered topics. That system is built on top of this one; brainstorm it separately once this ships.

## Decisions

- **Provider:** Parallel.ai search API only. Direct HTTP wrapper in trm, no Firecrawl, no runtime dependency on the `toolforge` repo's existing `parallel-search` skill — only the API key is shared.
- **Credential:** `PARALLEL_API_KEY`. Not currently loaded anywhere in trm's `src/core/config.ts` — add it there as a new required-for-web-search secret (see Error handling: lazy fail-fast, not unconditional). Value comes from the same key already provisioned at `C:\Users\soren\.secrets\parallel.env` for the `toolforge` project; no new key needed.
- **Trigger modes**, keyed off a new `web_strategy` field on `ResearchQueueEntry` (named to avoid colliding with that type's existing `mode: "fast" | "deep"` field):
  - `web_strategy === "web"` — bypass `nlm research` entirely, go straight to Parallel search. Set at gap-creation time by whatever process files the gap (human or upstream).
  - `web_strategy === "auto"` or unset — run `nlm research` as today; if the result is "weak" (see below), fall back to Parallel search.
  - `web_strategy === "notebook"` — today's existing behavior, unchanged. Not new code — this value simply means "never branch into this spec's logic."
- **Weak-result detection:** export the existing `URGENCY_PATTERNS` array from `src/cli/commands/mineNotebooklm.ts` and add `isWeakResearchResult(answerText: string): boolean`, which returns true if any pattern matches. `answerText` is whatever text the other plan's dispatch flow extracts from `nlm research import` output for a completed task (that plan defines the exact extraction; this spec consumes its result).
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
- **Registry:** add `"EVIDENCE_IMPORTED"` as a new value in the existing `dispatch_status` enum (not a separate field), plus optional `imported_source?: string` and `last_updated_at?: string` (ISO timestamp) on `ResearchQueueEntry` — optional because they're absent until the first successful web-dispatch. Set together, only on full success (search + write + upload all succeed). Any failure at any step leaves `dispatch_status` at whatever value it already had — the gap simply remains eligible for the next dispatch pass, same retry-by-doing-nothing pattern the other plan uses for `nlm research` failures.

## Components

- **`src/research/webSearch.ts`** (new)
  - `interface WebSearchHit { title: string; url: string; snippet: string }`
  - `interface WebSearchResult { query: string; hits: WebSearchHit[] }`
  - `async function searchWeb(query: string): Promise<WebSearchResult>` — `POST https://api.parallel.ai/v1beta/search`, header `x-api-key: <PARALLEL_API_KEY>`, body `{ search_queries: [query], excerpts: true }` (see wire contract in Decisions above). Parses `SearchResult.results` into `WebSearchResult.hits`. Throws on non-2xx response, network failure, or a body missing/non-array `results`. Direct `fetch` call — no `parallel-web` SDK dependency, to keep trm's own dependency tree independent of `toolforge`'s. Pure function: no filesystem or registry access, independently testable via mocked `fetch`.
- **`src/research/evidenceWriter.ts`** (new)
  - `function writeEvidenceMarkdown(gapId: string, query: string, result: WebSearchResult): string` — validates `gapId` against the registry's existing id format (alphanumeric + dash only, max 64 chars — reject anything else before it touches a path; guards against the MAX_PATH issues this repo has hit before, see `project-notebooklm-ingest-live-bugs-2026-08-13`) and writes a markdown document (query, then each hit as `### {title}` / url / snippet) to `_kb-sync-staging/trm/gap-{gapId}-evidence.md`. Returns the absolute path. Overwrites any existing file at that path (no cross-attempt reuse — see Error handling).
- **`isWeakResearchResult(answerText: string): boolean`** — added to `src/cli/commands/mineNotebooklm.ts` alongside the now-exported `URGENCY_PATTERNS`.
- **`src/notebooklm/registry.ts`** (modify) — extend `ResearchQueueEntry` with `web_strategy?: "web" | "auto" | "notebook"`, add `"EVIDENCE_IMPORTED"` to the `dispatch_status` union, add `imported_source?: string`, `last_updated_at?: string`. Update via the existing `upsertResearchQueueEntry` helper — no new registry-mutation helper.
- **`src/core/config.ts`** (modify) — add `PARALLEL_API_KEY` to the loaded config shape. Loading happens unconditionally (cheap env read); *validation* (throwing if absent) happens lazily, only at the point a gap with `web_strategy !== "notebook"` is actually about to be dispatched — not at CLI startup, so notebook-only runs are unaffected by a missing key.
- **`src/cli/commands/researchNotebooklm.ts`** (modify, existing dispatch command from the other plan) — add the strategy branch inline. No new `router.ts` file; one command owns "what happens to a gap."

## Data flow

1. Dispatch loop selects a gap from `research_queue` (existing selection logic from the other plan).
2. `web_strategy === "web"` → skip to step 4.
3. Else run `nlm research` as today; extract answer text and check it with `isWeakResearchResult()`. **Open dependency:** the answer-text extraction from `nlm research import` output is not yet defined by either this spec or the prerequisite NotebookLM plan — whichever plan is implemented first must define it concretely (a plain-text field pulled from `import`'s stdout/`--json` output once that plan resolves its own deferred parser-format question), and the other must consume that exact contract rather than re-deriving it. Strong → stop, existing behavior unchanged. Weak → continue.
4. `searchWeb(gap.question)`.
5. `writeEvidenceMarkdown(gap.id, gap.question, result)` → local path.
6. `nlm source add <notebook_id> --file <path> --title "TRM Evidence: {gap_id}" --wait`.
7. On success of both 4-6: `upsertResearchQueueEntry` sets `dispatch_status: "EVIDENCE_IMPORTED"`, `imported_source`, `last_updated_at`.

## Error handling

- **Parallel API failure/timeout:** `searchWeb` throws; dispatch catches, logs, leaves `dispatch_status` unchanged. Gap retried next dispatch cadence.
- **`PARALLEL_API_KEY` missing:** thrown lazily at first web-dispatch attempt in a run, not at CLI startup. One clear error per run, not per-gap spam (log once, skip remaining web-strategy gaps for that run).
- **Zero-hit Parallel result:** treated as failure, not staged/uploaded. Gap stays at its prior `dispatch_status`; a persistently zero-hit gap surfaces via the other plan's existing stall-check mechanism, same as any other stuck gap. No new alerting built here.
- **Invalid `gapId` format:** `writeEvidenceMarkdown` throws before touching the filesystem; treated as a dispatch failure like any other step failure.
- **`nlm source add` non-zero exit / spawn failure / timeout:** treated as failure; `dispatch_status` unchanged. The staged evidence file from this attempt is left in place for debugging but is not reused by the next retry (see below) — next dispatch pass regenerates it fresh.
- **Accepted risk (non-goal, matches sibling spec's accepted concurrency/GC gaps):** because each retry re-runs the full search-write-upload sequence rather than resuming a partial attempt, a search-succeeds-but-upload-fails attempt followed by a successful retry can leave one orphaned/duplicate NotebookLM source from the failed attempt. No dedup/reconciliation against existing NotebookLM sources is built. Retries only happen on infra failure (search or upload erroring), not on a fixed schedule, so occurrence is bounded by failure rate, not routine; orphaned sources are harmless extra context, not incorrect answers.

## Non-goals

- Firecrawl support, multi-provider selection.
- The proactive research-consultant track (sub-project B — separate future spec).
- Rate limiting, per-run search budget, request retry/backoff beyond "try again next dispatch cycle."
- Sanitizing/validating untrusted search-result content beyond path-safe `gapId` handling — web content is trusted at the same level as any other NotebookLM source once imported.
- Atomic file writes / concurrent-writer protection — dispatch is single-process sequential, same accepted non-goal as the sibling spec.
- Deduplication of NotebookLM sources across retried failed uploads (see accepted risk above).

## Testing

- **`webSearch.test.ts`** — mock `fetch`: request shape (query, `Authorization` header) is correct; successful response parses into `WebSearchResult`; non-2xx response throws; malformed/unparseable 2xx body throws; network failure throws.
- **`evidenceWriter.test.ts`** — valid input produces expected markdown content at the expected path (tmpdir fixture, mirrors `registry.test.ts` pattern); invalid `gapId` (path-traversal characters, non-alphanumeric-dash) throws before any file write.
- **`mineNotebooklm.test.ts`** (extend) — `isWeakResearchResult` returns true for each `URGENCY_PATTERNS` entry, false for a clean answer.
- **`researchNotebooklm.test.ts`** (extend) — `jest.mock` `webSearch`, `evidenceWriter`, `nlmCli`:
  - `web_strategy: "web"` skips `nlm research` entirely.
  - Weak `"auto"` result triggers the fallback chain in order (search → write → upload → registry update).
  - Strong `"auto"` result never calls `webSearch`.
  - `"notebook"` strategy behaves identically to today (no new calls).
  - Successful full chain sets `dispatch_status`/`imported_source`/`last_updated_at` correctly.
  - Failure at `searchWeb`, at `writeEvidenceMarkdown`, and at `nlm source add` (non-zero exit) each leave `dispatch_status` unchanged and don't throw uncaught out of the dispatch loop.
  - Missing `PARALLEL_API_KEY` at dispatch time produces one logged error and skips remaining web-strategy gaps that run, without crashing notebook-only gaps in the same run.
- No live Parallel or `nlm` calls in any test — everything mocked, matching existing convention (`nlm` CLI tests never call the live binary).
