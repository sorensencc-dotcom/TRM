# research-notebooklm --limit / --dry-run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `--limit <n>` and `--dry-run` flags to the real `trm research-notebooklm` CLI command.

**Architecture:** Both flags are additive options on the existing `runResearchNotebooklm()` orchestrator in `src/cli/commands/researchNotebooklm.ts` — no new files, no changes to strategy routing, registry schema, or `nlm`/Parallel call sites. `--limit` truncates the already-computed dispatch plan before the loop. `--dry-run` short-circuits before the loop entirely and reports the plan instead of executing it — it does not fake `nlm`/Parallel responses or thread a flag into `dispatchCandidate`.

**Tech Stack:** TypeScript, Jest (`npm test` runs `jest`), Commander (`program.command()` in `src/cli/index.ts`).

**Spec:** This plan supersedes the flag list in `trm-research-notebooklm-spec.md` (`--strategy`, `--limit`, `--cited-only`, `--dry-run`) — only `--limit` and `--dry-run` are being built; `--strategy` and `--cited-only` are rejected (see review in conversation history, 2026-09-15: strategy is per-gap `web_strategy` on `ResearchQueueEntry`, and `--cited-only` is already hardcoded `true` in `researchImport()`).

## Global Constraints

- `--force-research` already requires an explicit `notebook-id` ([index.ts:257-259](../../../src/cli/index.ts#L257-L259)) — do not weaken that guard.
- Real dispatch caps (`max_jobs_per_notebook`, `max_jobs_per_run_global`) stay authoritative; `--limit` is an additional ceiling on top, never a replacement.
- `--dry-run` must make zero calls into `nlmResearch`, `nlmCli`, `webSearch`, `evidenceWriter`, and zero writes to `notebooklm-registry.json`.
- All new tests colocate in `src/cli/commands/researchNotebooklm.test.ts` (existing file), matching this repo's colocated-test convention — not `test/unit/...` or `test/integration/...`.

---

### Task 1: Add `--limit` to `runResearchNotebooklm`

**Files:**
- Modify: `src/cli/commands/researchNotebooklm.ts:98-105` (interface), `:274-315` (function body)
- Test: `src/cli/commands/researchNotebooklm.test.ts`

**Interfaces:**
- Consumes: existing `selectDispatchPlan(registry, notebookId, limits, forceResearch, now): DispatchCandidate[]` — unchanged signature.
- Produces: `runResearchNotebooklm(root, notebookId, opts: { forceResearch: boolean; limit?: number })` — `opts.limit` is a new optional field consumed by Task 2 (CLI wiring) and Task 3 (`dryRun`, which reuses the same bounded plan).

- [ ] **Step 1: Write failing test — `--limit` truncates the plan below what dispatch caps alone would allow**

Add to `src/cli/commands/researchNotebooklm.test.ts` inside the `describe('runResearchNotebooklm', ...)` block (after the existing tests, before the closing `});` of that describe):

```ts
  it('--limit truncates the plan even when more entries are eligible', async () => {
    fs.writeFileSync(
      registryPath(root),
      JSON.stringify({
        version: 1,
        notebooks: [
          {
            notebook_id: 'nb-1',
            title: 'T',
            url: 'https://x',
            last_pulled_hashes: {},
            quarantined: {},
            last_ingested_at: null,
            last_mined_at: null,
            last_mined_answer_keys: [],
            research_queue: {
              [questionHash('question one')]: baseEntry({
                question_hash: questionHash('question one'),
                question_text: 'question one',
                question_id: 'q1',
                gap_key: 'nb-1:q1:x',
              }),
              [questionHash('question two')]: baseEntry({
                question_hash: questionHash('question two'),
                question_text: 'question two',
                question_id: 'q2',
                gap_key: 'nb-1:q2:x',
              }),
            },
          },
        ],
      })
    );
    (nlmResearch.researchStart as jest.Mock).mockReturnValue({ ok: true, data: { taskId: 'rt-1' } });
    (nlmResearch.researchStatus as jest.Mock).mockReturnValue({ ok: true, data: { completed: true } });
    (nlmResearch.researchImport as jest.Mock).mockReturnValue({ ok: true, data: undefined });
    (nlmCli.queryNotebook as jest.Mock).mockReturnValue({ ok: true, data: 'Fully resolved, well-sourced now.' });

    const result = await runResearchNotebooklm(root, 'nb-1', { forceResearch: false, limit: 1 });

    expect(result.dispatched).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.skipped).toBe(1);
    expect(nlmResearch.researchStart as jest.Mock).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/cli/commands/researchNotebooklm.test.ts -t "limit truncates"`
Expected: FAIL — `runResearchNotebooklm` dispatches both entries (`dispatched: 2`), `researchStart` called twice, because `opts.limit` is not read anywhere yet.

- [ ] **Step 3: Implement minimal code to make the test pass**

In `src/cli/commands/researchNotebooklm.ts`, change the `runResearchNotebooklm` signature and body:

```ts
export async function runResearchNotebooklm(
  root: string,
  notebookId: string | undefined,
  opts: { forceResearch: boolean; limit?: number }
): Promise<ResearchNotebooklmResult> {
  const config = loadConfig(root);
  const registry = readRegistry(root);
  if (notebookId && !findNotebook(registry, notebookId)) {
    throw new Error(`notebooklm-registry.json has no entry for notebook "${notebookId}"`);
  }

  const now = new Date();
  const plan = selectDispatchPlan(registry, notebookId, config.dispatch_limits, opts.forceResearch, now);
  const boundedPlan = opts.limit !== undefined ? plan.slice(0, opts.limit) : plan;
  const nowIso = now.toISOString();

  const parallelKeyMissing = !process.env.PARALLEL_API_KEY;
  if (parallelKeyMissing) {
    console.error(
      `research-notebooklm: ${MISSING_PARALLEL_API_KEY_ERROR}; skipping web-strategy/fallback dispatch for this run`
    );
  }

  const result: ResearchNotebooklmResult = { dispatched: 0, succeeded: 0, transientFailures: 0, stalled: 0, infrastructureBlocked: 0, skipped: 0 };
  result.skipped = countAllEligible(registry, notebookId, config.dispatch_limits, opts.forceResearch, now) - boundedPlan.length;

  for (const candidate of boundedPlan) {
    result.dispatched++;
    const outcome = await dispatchCandidate(root, candidate, config.dispatch_limits, opts.forceResearch, nowIso, parallelKeyMissing);
    if (outcome === 'succeeded') result.succeeded++;
    else if (outcome === 'stalled') result.stalled++;
    else if (outcome === 'infrastructureBlocked') result.infrastructureBlocked++;
    else result.transientFailures++;
  }

  return result;
}
```

(Only the signature, the `boundedPlan` line, and the two references to `plan` → `boundedPlan` are new — everything else is unchanged from the current body.)

Update the four other call sites of `runResearchNotebooklm(root, notebookId, { forceResearch: ... })` in the existing test file — they pass an object literal, so TypeScript's optional `limit?` field means **no changes needed** to those call sites; confirm this by running the full suite in Step 4.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/cli/commands/researchNotebooklm.test.ts`
Expected: PASS, all tests including the new one.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/researchNotebooklm.ts src/cli/commands/researchNotebooklm.test.ts
git commit -m "feat(research-notebooklm): add opts.limit to bound dispatch plan size"
```

---

### Task 2: Add `--dry-run` to `runResearchNotebooklm`

**Files:**
- Modify: `src/cli/commands/researchNotebooklm.ts:98-105` (interface), function body from Task 1
- Test: `src/cli/commands/researchNotebooklm.test.ts`

**Interfaces:**
- Consumes: `boundedPlan: DispatchCandidate[]` from Task 1.
- Produces: `ResearchNotebooklmResult.plan?: Array<{ notebookId: string; questionId: string; webStrategy?: 'web' | 'auto' | 'notebook' }>` — new optional field, populated only when `opts.dryRun` is true. Task 3 (CLI wiring) reads `opts.dryRun` off the parsed flag and passes it straight through unchanged.

- [ ] **Step 1: Write failing test — `--dry-run` makes zero external calls and zero registry writes**

Add to the same `describe('runResearchNotebooklm', ...)` block:

```ts
  it('--dry-run reports the plan without calling nlm/Parallel or writing the registry', async () => {
    seedRunRegistry(root, baseEntry());
    const registryBefore = fs.readFileSync(registryPath(root), 'utf-8');

    const result = await runResearchNotebooklm(root, 'nb-1', { forceResearch: false, dryRun: true });

    expect(result.dispatched).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(result.plan).toEqual([
      { notebookId: 'nb-1', questionId: 'open-contradictions', webStrategy: undefined },
    ]);
    expect(nlmResearch.researchStart as jest.Mock).not.toHaveBeenCalled();
    expect(nlmCli.queryNotebook as jest.Mock).not.toHaveBeenCalled();
    expect(webSearch.searchWeb as jest.Mock).not.toHaveBeenCalled();
    expect(evidenceWriter.writeEvidenceMarkdown as jest.Mock).not.toHaveBeenCalled();
    expect(fs.readFileSync(registryPath(root), 'utf-8')).toBe(registryBefore);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/cli/commands/researchNotebooklm.test.ts -t "dry-run reports"`
Expected: FAIL — TypeScript error or runtime call to `researchStart`, since `opts.dryRun` doesn't exist and the loop always dispatches.

- [ ] **Step 3: Implement minimal code to make the test pass**

In `src/cli/commands/researchNotebooklm.ts`, update the interface (currently lines 98-105):

```ts
export interface ResearchNotebooklmResult {
  dispatched: number;
  succeeded: number;
  transientFailures: number;
  stalled: number;
  infrastructureBlocked: number;
  skipped: number;
  plan?: Array<{ notebookId: string; questionId: string; webStrategy?: 'web' | 'auto' | 'notebook' }>;
}
```

Update the signature and insert the dry-run short-circuit before the dispatch loop:

```ts
export async function runResearchNotebooklm(
  root: string,
  notebookId: string | undefined,
  opts: { forceResearch: boolean; limit?: number; dryRun?: boolean }
): Promise<ResearchNotebooklmResult> {
  const config = loadConfig(root);
  const registry = readRegistry(root);
  if (notebookId && !findNotebook(registry, notebookId)) {
    throw new Error(`notebooklm-registry.json has no entry for notebook "${notebookId}"`);
  }

  const now = new Date();
  const plan = selectDispatchPlan(registry, notebookId, config.dispatch_limits, opts.forceResearch, now);
  const boundedPlan = opts.limit !== undefined ? plan.slice(0, opts.limit) : plan;

  const result: ResearchNotebooklmResult = { dispatched: 0, succeeded: 0, transientFailures: 0, stalled: 0, infrastructureBlocked: 0, skipped: 0 };
  result.skipped = countAllEligible(registry, notebookId, config.dispatch_limits, opts.forceResearch, now) - boundedPlan.length;

  if (opts.dryRun) {
    result.dispatched = boundedPlan.length;
    result.plan = boundedPlan.map((c) => ({
      notebookId: c.notebookId,
      questionId: c.entry.question_id,
      webStrategy: c.entry.web_strategy,
    }));
    return result;
  }

  const nowIso = now.toISOString();
  const parallelKeyMissing = !process.env.PARALLEL_API_KEY;
  if (parallelKeyMissing) {
    console.error(
      `research-notebooklm: ${MISSING_PARALLEL_API_KEY_ERROR}; skipping web-strategy/fallback dispatch for this run`
    );
  }

  for (const candidate of boundedPlan) {
    result.dispatched++;
    const outcome = await dispatchCandidate(root, candidate, config.dispatch_limits, opts.forceResearch, nowIso, parallelKeyMissing);
    if (outcome === 'succeeded') result.succeeded++;
    else if (outcome === 'stalled') result.stalled++;
    else if (outcome === 'infrastructureBlocked') result.infrastructureBlocked++;
    else result.transientFailures++;
  }

  return result;
}
```

Note: the `parallelKeyMissing` check moves below the dry-run return so a dry run never logs the missing-key warning either — dry run makes no external calls, so the warning would be misleading noise.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/cli/commands/researchNotebooklm.test.ts`
Expected: PASS, all tests including the two new ones from Task 1 and Task 2.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/researchNotebooklm.ts src/cli/commands/researchNotebooklm.test.ts
git commit -m "feat(research-notebooklm): add opts.dryRun to preview dispatch plan with zero side effects"
```

---

### Task 3: Wire `--limit` and `--dry-run` into the CLI command

**Files:**
- Modify: `src/cli/index.ts:252-266`
- Test: manual verification (this repo has no CLI-parsing test harness for `src/cli/index.ts`; Commander option parsing is exercised end-to-end by running the built CLI, not unit-tested)

**Interfaces:**
- Consumes: `runResearchNotebooklm(root, notebookId, opts: { forceResearch: boolean; limit?: number; dryRun?: boolean })` from Task 2.
- Produces: nothing consumed by later tasks — this is the last task in the plan.

- [ ] **Step 1: Modify the command definition**

In `src/cli/index.ts`, replace the `research-notebooklm` block (currently lines 252-266):

```ts
program
  .command('research-notebooklm [notebook-id]')
  .option('--force-research', 'bypass cooldown for eligible entries (does not bypass STALLED/BLOCKED status)')
  .option('--limit <n>', 'cap gaps processed this run, on top of config dispatch limits', (value) => {
    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      throw new Error(`--limit must be a positive integer, got "${value}"`);
    }
    return parsed;
  })
  .option('--dry-run', 'preview the dispatch plan without calling nlm/Parallel or writing the registry')
  .action(async (notebookId, opts) => {
    try {
      if (opts.forceResearch && !notebookId) {
        throw new Error('--force-research requires an explicit notebook-id (refusing to bypass cooldown across an unbounded sweep)');
      }
      const result = await runResearchNotebooklm(root, notebookId, {
        forceResearch: !!opts.forceResearch,
        limit: opts.limit,
        dryRun: !!opts.dryRun,
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });
```

(The `--limit` parser throwing on a bad value matches Commander's convention of custom option-parser functions throwing `InvalidArgumentError`-style errors — Commander catches and reports them before `.action()` runs.)

- [ ] **Step 2: Build and manually verify**

Run: `npm run build`
Expected: compiles with no TypeScript errors.

Run against a real (or scratch) registry:
```bash
node dist/cli/index.js research-notebooklm nb-1 --dry-run
```
Expected: JSON output with `"dispatched"` equal to the eligible count (or less, if capped by config), a `"plan"` array of `{notebookId, questionId, webStrategy}`, zero `nlm`/Parallel process spawns (no network activity), and `notebooklm-registry.json` unchanged (`git diff` or file mtime confirms no write).

Run with `--limit`:
```bash
node dist/cli/index.js research-notebooklm nb-1 --dry-run --limit 1
```
Expected: `"plan"` array has at most 1 entry even if more are eligible.

- [ ] **Step 3: Run the full test suite**

Run: `npx jest`
Expected: PASS, no regressions in unrelated suites.

- [ ] **Step 4: Commit**

```bash
git add src/cli/index.ts
git commit -m "feat(research-notebooklm): wire --limit and --dry-run CLI flags"
```

---

## Self-Review

**Spec coverage:** Task 1 covers `--limit`. Task 2 covers `--dry-run`'s core behavior (zero side effects, plan preview). Task 3 covers CLI wiring for both. `--strategy` and `--cited-only` are explicitly out of scope per the Spec section above — no task builds them, which is intentional, not a gap.

**Placeholder scan:** No TBD/TODO markers; every step has runnable code and exact expected output.

**Type consistency:** `opts.limit?: number`, `opts.dryRun?: boolean` introduced in Task 1/2 match the object literal built in Task 3's `.action()` handler. `ResearchNotebooklmResult.plan` field shape (`{notebookId, questionId, webStrategy}`) is identical between its Task 2 definition and the Task 2 test assertion. `DispatchCandidate` (`{notebookId, entry}`) already exists at `researchNotebooklm.ts:17-20` and is unchanged.
