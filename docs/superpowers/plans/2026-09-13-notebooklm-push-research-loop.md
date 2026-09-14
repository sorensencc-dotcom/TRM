# NotebookLM push-research loop implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the loop from "mining flags an urgent gap" to "NotebookLM dispatches web research and imports cited sources" via a new `trm research-notebooklm` command, so urgent gaps stop sitting inert in `TODOS.md`.

**Architecture:** Extend the existing flat-JSON `notebooklm-registry.json` with a per-notebook `research_queue` map populated by `mine-notebooklm` whenever an answer trips `URGENCY_PATTERNS`. A new `research-notebooklm` command reads that queue, applies cooldown/attempt/cap rules from a new `dispatch_limits` config block, and drives the real `nlm research start/status/import` CLI through a new thin wrapper module. The nightly PowerShell wrapper chains the new command after the existing mining step.

**Tech Stack:** TypeScript (strict, CommonJS, Node 20), Jest + ts-jest, Commander CLI, `nlm.exe` (NotebookLM CLI, no `--json` support on `research *` subcommands), PowerShell 5.1 scheduler wrapper.

**Spec:** `docs/superpowers/specs/2026-09-13-notebooklm-push-research-loop-design.md`

## Global Constraints

- No database, no new storage engine — extend `notebooklm-registry.json` via the existing `writeFileAtomic`/`readRegistry`/`writeRegistry` plumbing only.
- No cross-process locking — single-instance-at-a-time assumption, same as the existing Windows Task Scheduler wrapper relies on for `mine-notebooklm`.
- No garbage collection of orphaned `research_queue` entries (question reworded/removed from `config/mining-questions.json`) — they sit inert, bounded by question-set size.
- `mine-notebooklm` stays read-only toward NotebookLM (`queryNotebook` only) — it must never call `nlm research start`. Only `research-notebooklm` mutates via `nlm`.
- All `dispatch_limits` config fields are optional with spec-defined defaults; a `config.json` without `dispatch_limits` must keep working unchanged.
- `nlm research start|status|import` have no `--json` flag (confirmed live against the installed binary's `--help` output, 2026-09-13) — parsing is regex-based against freeform stdout. Task 1 below is a mandatory live-calibration step before any other task consumes its output.
- Dispatch is always exactly 3 sequential `nlm` calls per attempt (`start` → `status` → `import --cited-only`); there is no partial-success state — any of the three failing (nonzero exit, or `status` reporting a timeout on exit 0) is a transient failure for the whole attempt.

---

### Task 1: `nlmResearch.ts` — live-calibrated wrapper around `nlm research start/status/import`

**Files:**
- Create: `src/notebooklm/nlmResearch.ts`
- Test: `src/notebooklm/nlmResearch.test.ts`

**Interfaces:**
- Consumes: nothing from this plan (wraps the external `nlm` binary directly, mirrors the `spawnSync` + `cmd.exe /d /s /c` Windows-wrapping convention already used in `src/cli/commands/mineNotebooklm.ts:137-139,156-162,168,172`).
- Produces (used by Task 6):
  - `export type ResearchCallResult<T> = { ok: true; data: T } | { ok: false; error: string };`
  - `export function researchStart(notebookId: string, query: string, mode: 'fast' | 'deep', force: boolean): ResearchCallResult<{ taskId: string }>`
  - `export function researchStatus(notebookId: string, taskId: string, maxWaitSeconds: number): ResearchCallResult<{ completed: boolean }>`
  - `export function researchImport(notebookId: string, taskId: string): ResearchCallResult<void>`

**Why this needs a live probe first:** `nlm research start/status/import --help` (run 2026-09-13) has no `--json` option on any of the three subcommands, unlike `nlm source list`/`nlm query notebook` which do support `--json`. That means task-id extraction (from `start`'s stdout) and completed-vs-timed-out detection (from `status`'s stdout) are regex-based against human-readable text whose exact wording has not been observed against a real completed research task. Confirmed live so far (safe, no real dispatch — bogus notebook ID against all three subcommands):

```
$ nlm research status bogus-notebook-id --max-wait 0
Error: Failed to poll research: API error (code 5): NOT_FOUND
exit 1

$ nlm research import bogus-notebook-id
Error: API error (code 5): NOT_FOUND
exit 1

$ nlm research start "" --notebook-id bogus-id
Error: API error (code 5): NOT_FOUND
exit 1
```

This confirms the **failure** shape: nonzero exit, message on the line starting `Error: `. It does **not** confirm the **success** shape (what `start`'s stdout looks like when it actually queues a task, or what `status`'s stdout looks like on completion vs. timeout) — that requires a real dispatch against a real notebook, which is out of scope to run un-approved. Step 1 below is that calibration, done by whoever executes this task, against a disposable/low-stakes notebook they control.

- [ ] **Step 1: Live-calibrate the parsing patterns**

Run against a real, disposable NotebookLM notebook (not a production `trm` notebook):

```
nlm research start "test query for parser calibration" --notebook-id <disposable-notebook-id> --source web --mode fast
```

Record the raw stdout verbatim. Then run:

```
nlm research status <disposable-notebook-id> --task-id <task-id-from-above> --max-wait 60
```

Record the raw stdout verbatim for both the in-progress and completed states (re-run with `--max-wait 0` partway through to see an in-progress snapshot if the first call already blocked to completion). If a timeout is observed instead (unlikely at `fast` mode, ~30s), record that stdout too.

Compare the captured text against `TASK_ID_PATTERN` and `TIMED_OUT_PATTERN` defined in Step 3 below. If the real wording differs, edit both patterns and the fixture strings used in Step 2's tests to match the real captured text before proceeding — the patterns below are a best-effort starting point built from the CLI's own `--help` vocabulary ("Task", "times out"), not a confirmed observation.

- [ ] **Step 2: Write the failing tests**

```typescript
// src/notebooklm/nlmResearch.test.ts
import { spawnSync } from 'node:child_process';
import { researchStart, researchStatus, researchImport } from './nlmResearch';

jest.mock('node:child_process');

function mockSpawn(status: number | null, stdout: string, stderr = ''): void {
  (spawnSync as jest.Mock).mockReturnValue({ status, stdout, stderr });
}

describe('nlmResearch', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('researchStart extracts the task id from a successful start', () => {
    mockSpawn(0, 'Research task started.\nTask ID: rt-abc123\nMode: fast\n');
    const result = researchStart('nb-1', 'what is X', 'fast', false);
    expect(result).toEqual({ ok: true, data: { taskId: 'rt-abc123' } });
  });

  it('researchStart returns a transient failure on nonzero exit', () => {
    mockSpawn(1, '', 'Error: API error (code 5): NOT_FOUND');
    const result = researchStart('nb-1', 'what is X', 'fast', false);
    expect(result).toEqual({ ok: false, error: 'Error: API error (code 5): NOT_FOUND' });
  });

  it('researchStart returns a failure when no task id can be found in stdout', () => {
    mockSpawn(0, 'Something unexpected happened but exit was 0.\n');
    const result = researchStart('nb-1', 'what is X', 'fast', false);
    expect(result.ok).toBe(false);
  });

  it('researchStart passes --force only when requested', () => {
    mockSpawn(0, 'Task ID: rt-1\n');
    researchStart('nb-1', 'q', 'deep', true);
    const args = (spawnSync as jest.Mock).mock.calls[0][1] as string[];
    expect(args).toContain('--force');
    expect(args).toContain('--mode');
    expect(args).toContain('deep');
  });

  it('researchStatus reports completed when the CLI reports success', () => {
    mockSpawn(0, 'Research task completed. Found 12 sources, 5 cited.\n');
    const result = researchStatus('nb-1', 'rt-abc123', 300);
    expect(result).toEqual({ ok: true, data: { completed: true } });
  });

  it('researchStatus reports not-completed when the CLI reports a timeout', () => {
    mockSpawn(0, 'Polling timed out after 300s. Task rt-abc123 still in progress.\n');
    const result = researchStatus('nb-1', 'rt-abc123', 300);
    expect(result).toEqual({ ok: true, data: { completed: false } });
  });

  it('researchStatus returns a transient failure on nonzero exit', () => {
    mockSpawn(1, '', 'Error: Failed to poll research: API error (code 5): NOT_FOUND');
    const result = researchStatus('nb-1', 'rt-abc123', 300);
    expect(result).toEqual({ ok: false, error: 'Error: Failed to poll research: API error (code 5): NOT_FOUND' });
  });

  it('researchImport succeeds on exit 0', () => {
    mockSpawn(0, 'Imported 5 sources.\n');
    const result = researchImport('nb-1', 'rt-abc123');
    expect(result).toEqual({ ok: true, data: undefined });
  });

  it('researchImport returns a transient failure on nonzero exit', () => {
    mockSpawn(1, '', 'Error: import failed');
    const result = researchImport('nb-1', 'rt-abc123');
    expect(result).toEqual({ ok: false, error: 'Error: import failed' });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx jest src/notebooklm/nlmResearch.test.ts`
Expected: FAIL with "Cannot find module './nlmResearch'"

- [ ] **Step 4: Implement `nlmResearch.ts`**

```typescript
// src/notebooklm/nlmResearch.ts
import { spawnSync } from 'node:child_process';

export type ResearchCallResult<T> = { ok: true; data: T } | { ok: false; error: string };

interface RawSpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

// nlm research start/status/import have no --json output (confirmed via
// `nlm research start/status/import --help`, 2026-09-13) unlike source/query
// subcommands. These patterns are calibrated against real CLI stdout by
// Task 1, Step 1 of the implementation plan -- adjust here if the real
// wording differs from what the tests assert.
const TASK_ID_PATTERN = /task[\s_-]*id[:\s]+([A-Za-z0-9._-]+)/i;
const TIMED_OUT_PATTERN = /timed?\s*out/i;

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

function runNlm(args: string[]): RawSpawnResult {
  const result =
    process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'nlm', ...args], { encoding: 'utf-8' })
      : spawnSync('nlm', args, { encoding: 'utf-8' });
  return result as unknown as RawSpawnResult;
}

function failureFrom(result: RawSpawnResult, fallback: string): { ok: false; error: string } {
  if (result.error) return { ok: false, error: result.error.message };
  const message = stripAnsi(result.stderr || result.stdout || fallback).trim();
  return { ok: false, error: message.length > 0 ? message : fallback };
}

export function researchStart(
  notebookId: string,
  query: string,
  mode: 'fast' | 'deep',
  force: boolean
): ResearchCallResult<{ taskId: string }> {
  const args = ['research', 'start', query, '--notebook-id', notebookId, '--source', 'web', '--mode', mode];
  if (force) args.push('--force');

  const result = runNlm(args);
  if (result.error || result.status !== 0) {
    return failureFrom(result, `nlm research start exited with status ${result.status}`);
  }

  const match = stripAnsi(result.stdout).match(TASK_ID_PATTERN);
  if (!match) {
    return { ok: false, error: `could not find a task id in nlm research start output: ${result.stdout.trim()}` };
  }
  return { ok: true, data: { taskId: match[1] } };
}

export function researchStatus(
  notebookId: string,
  taskId: string,
  maxWaitSeconds: number
): ResearchCallResult<{ completed: boolean }> {
  const args = ['research', 'status', notebookId, '--task-id', taskId, '--max-wait', String(maxWaitSeconds)];

  const result = runNlm(args);
  if (result.error || result.status !== 0) {
    return failureFrom(result, `nlm research status exited with status ${result.status}`);
  }

  const timedOut = TIMED_OUT_PATTERN.test(stripAnsi(result.stdout));
  return { ok: true, data: { completed: !timedOut } };
}

export function researchImport(notebookId: string, taskId: string): ResearchCallResult<void> {
  const args = ['research', 'import', notebookId, taskId, '--cited-only'];

  const result = runNlm(args);
  if (result.error || result.status !== 0) {
    return failureFrom(result, `nlm research import exited with status ${result.status}`);
  }
  return { ok: true, data: undefined };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/notebooklm/nlmResearch.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 6: Commit**

```bash
git add src/notebooklm/nlmResearch.ts src/notebooklm/nlmResearch.test.ts
git commit -m "feat(notebooklm): add nlm research start/status/import CLI wrapper"
```

---

### Task 2: Registry — `research_queue` data model

**Files:**
- Modify: `src/notebooklm/registry.ts`
- Modify: `src/notebooklm/registry.test.ts`

**Interfaces:**
- Consumes: `writeFileAtomic` (`../core/atomicWrite`), existing `mutateNotebook`/`readRegistry`/`writeRegistry` internals.
- Produces (used by Task 4 and Task 5/6):
  - `export interface ResearchQueueEntry { question_hash: string; question_text: string; question_id: string; gap_key: string; mode: 'fast' | 'deep'; attempt_count: number; consecutive_dispatch_failures: number; last_researched_at: string | null; last_dispatch_error: string | null; status: 'PENDING' | 'EXECUTED' | 'STALLED_NEEDS_HUMAN' | 'INFRASTRUCTURE_BLOCKED'; }`
  - `NotebookRegistryEntry` gains `research_queue?: Record<string, ResearchQueueEntry>` (optional at the type level so existing literal fixtures in `registry.test.ts`, `mineNotebooklm.test.ts`, and `ingestNotebooklm.test.ts` keep compiling unchanged; `readRegistry` normalizes it to `{}` when absent so downstream code never has to null-check).
  - `export function questionHash(text: string): string`
  - `export function upsertResearchQueueEntry(root: string, notebookId: string, question: { id: string; text: string }, gapKey: string, mode: 'fast' | 'deep'): void`
  - `export function flushResearchQueueEntry(root: string, notebookId: string, questionHashValue: string, patch: Partial<ResearchQueueEntry>): void`

- [ ] **Step 1: Write the failing tests**

Add to `src/notebooklm/registry.test.ts` (new `import`s: `questionHash, upsertResearchQueueEntry, flushResearchQueueEntry` from `./registry`):

```typescript
  it('readRegistry normalizes a missing research_queue to an empty object', () => {
    seedRegistry(root, {
      version: 1,
      notebooks: [
        {
          notebook_id: 'nb-1', title: 'T', url: 'https://x',
          last_pulled_hashes: {}, quarantined: {},
          last_ingested_at: null, last_mined_at: null, last_mined_answer_keys: [],
        },
      ],
    });

    const entry = findNotebook(readRegistry(root), 'nb-1')!;
    expect(entry.research_queue).toEqual({});
  });

  it('questionHash is stable for identical text and differs for different text', () => {
    expect(questionHash('What open questions exist?')).toBe(questionHash('What open questions exist?'));
    expect(questionHash('What open questions exist?')).not.toBe(questionHash('Something else?'));
  });

  it('upsertResearchQueueEntry creates a PENDING entry with zeroed counters', () => {
    seedRegistry(root, {
      version: 1,
      notebooks: [
        {
          notebook_id: 'nb-1', title: 'T', url: 'https://x',
          last_pulled_hashes: {}, quarantined: {},
          last_ingested_at: null, last_mined_at: null, last_mined_answer_keys: [],
        },
      ],
    });

    upsertResearchQueueEntry(root, 'nb-1', { id: 'open-contradictions', text: 'What open questions?' }, 'nb-1:open-contradictions:hash', 'fast');

    const entry = findNotebook(readRegistry(root), 'nb-1')!;
    const hash = questionHash('What open questions?');
    expect(entry.research_queue![hash]).toEqual({
      question_hash: hash,
      question_text: 'What open questions?',
      question_id: 'open-contradictions',
      gap_key: 'nb-1:open-contradictions:hash',
      mode: 'fast',
      attempt_count: 0,
      consecutive_dispatch_failures: 0,
      last_researched_at: null,
      last_dispatch_error: null,
      status: 'PENDING',
    });
  });

  it('upsertResearchQueueEntry leaves an existing entry untouched', () => {
    seedRegistry(root, {
      version: 1,
      notebooks: [
        {
          notebook_id: 'nb-1', title: 'T', url: 'https://x',
          last_pulled_hashes: {}, quarantined: {},
          last_ingested_at: null, last_mined_at: null, last_mined_answer_keys: [],
        },
      ],
    });

    upsertResearchQueueEntry(root, 'nb-1', { id: 'q1', text: 'Q' }, 'gap-1', 'fast');
    flushResearchQueueEntry(root, 'nb-1', questionHash('Q'), { attempt_count: 2, status: 'EXECUTED' });
    upsertResearchQueueEntry(root, 'nb-1', { id: 'q1', text: 'Q' }, 'gap-1', 'fast');

    const entry = findNotebook(readRegistry(root), 'nb-1')!;
    expect(entry.research_queue![questionHash('Q')].attempt_count).toBe(2);
    expect(entry.research_queue![questionHash('Q')].status).toBe('EXECUTED');
  });

  it('flushResearchQueueEntry patches only the given fields', () => {
    seedRegistry(root, {
      version: 1,
      notebooks: [
        {
          notebook_id: 'nb-1', title: 'T', url: 'https://x',
          last_pulled_hashes: {}, quarantined: {},
          last_ingested_at: null, last_mined_at: null, last_mined_answer_keys: [],
        },
      ],
    });
    upsertResearchQueueEntry(root, 'nb-1', { id: 'q1', text: 'Q' }, 'gap-1', 'fast');

    flushResearchQueueEntry(root, 'nb-1', questionHash('Q'), { consecutive_dispatch_failures: 1, last_dispatch_error: 'timeout' });

    const entry = findNotebook(readRegistry(root), 'nb-1')!.research_queue![questionHash('Q')];
    expect(entry.consecutive_dispatch_failures).toBe(1);
    expect(entry.last_dispatch_error).toBe('timeout');
    expect(entry.status).toBe('PENDING'); // untouched fields survive the patch
  });

  it('flushResearchQueueEntry throws for an unknown question_hash', () => {
    seedRegistry(root, {
      version: 1,
      notebooks: [
        {
          notebook_id: 'nb-1', title: 'T', url: 'https://x',
          last_pulled_hashes: {}, quarantined: {},
          last_ingested_at: null, last_mined_at: null, last_mined_answer_keys: [],
        },
      ],
    });

    expect(() => flushResearchQueueEntry(root, 'nb-1', 'no-such-hash', { status: 'EXECUTED' })).toThrow(/no entry for question_hash/);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/notebooklm/registry.test.ts`
Expected: FAIL — `questionHash`/`upsertResearchQueueEntry`/`flushResearchQueueEntry` not exported, `research_queue` normalization test fails.

- [ ] **Step 3: Implement the registry changes**

In `src/notebooklm/registry.ts`:

```typescript
import * as crypto from 'node:crypto';
```

Add after `QuarantineEntry`:

```typescript
export interface ResearchQueueEntry {
  question_hash: string;
  question_text: string;
  question_id: string;
  gap_key: string;
  mode: 'fast' | 'deep';
  attempt_count: number;
  consecutive_dispatch_failures: number;
  last_researched_at: string | null;
  last_dispatch_error: string | null;
  status: 'PENDING' | 'EXECUTED' | 'STALLED_NEEDS_HUMAN' | 'INFRASTRUCTURE_BLOCKED';
}
```

Extend `NotebookRegistryEntry`:

```typescript
export interface NotebookRegistryEntry {
  notebook_id: string;
  title: string;
  url: string;
  last_pulled_hashes: Record<string, string>;
  quarantined: Record<string, QuarantineEntry>;
  last_ingested_at: string | null;
  last_mined_at: string | null;
  last_mined_answer_keys: string[];
  research_queue?: Record<string, ResearchQueueEntry>;
}
```

Normalize in `readRegistry`:

```typescript
export function readRegistry(root: string): RegistryFile {
  const file = registryPath(root);
  if (!fs.existsSync(file)) return { version: 1, notebooks: [] };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as RegistryFile;
  for (const notebook of parsed.notebooks) {
    if (!notebook.research_queue) notebook.research_queue = {};
  }
  return parsed;
}
```

Add after `flushMinedState`:

```typescript
export function questionHash(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}

export function upsertResearchQueueEntry(
  root: string,
  notebookId: string,
  question: { id: string; text: string },
  gapKey: string,
  mode: 'fast' | 'deep'
): void {
  mutateNotebook(root, notebookId, (entry) => {
    if (!entry.research_queue) entry.research_queue = {};
    const hash = questionHash(question.text);
    if (entry.research_queue[hash]) return; // gap already queued -- never reset progress/cooldown
    entry.research_queue[hash] = {
      question_hash: hash,
      question_text: question.text,
      question_id: question.id,
      gap_key: gapKey,
      mode,
      attempt_count: 0,
      consecutive_dispatch_failures: 0,
      last_researched_at: null,
      last_dispatch_error: null,
      status: 'PENDING',
    };
  });
}

export function flushResearchQueueEntry(
  root: string,
  notebookId: string,
  questionHashValue: string,
  patch: Partial<ResearchQueueEntry>
): void {
  mutateNotebook(root, notebookId, (entry) => {
    if (!entry.research_queue) entry.research_queue = {};
    const existing = entry.research_queue[questionHashValue];
    if (!existing) {
      throw new Error(`research_queue has no entry for question_hash "${questionHashValue}" in notebook "${notebookId}"`);
    }
    entry.research_queue[questionHashValue] = { ...existing, ...patch };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/notebooklm/registry.test.ts`
Expected: PASS (all existing + 6 new tests)

- [ ] **Step 5: Commit**

```bash
git add src/notebooklm/registry.ts src/notebooklm/registry.test.ts
git commit -m "feat(notebooklm): add research_queue to the notebook registry"
```

---

### Task 3: Config — `dispatch_limits`

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/config.ts`
- Modify: `tests/core/config.test.ts`

**Interfaces:**
- Produces (used by Task 4 and Task 5/6):
  - `export interface DispatchLimits { max_jobs_per_notebook: number; max_jobs_per_run_global: number; default_mode: 'fast' | 'deep'; cooldown_days_fast: number; cooldown_days_deep: number; max_attempts_before_stall: number; max_consecutive_dispatch_failures: number; }` (`src/core/types.ts`)
  - `TrmConfig` gains `dispatch_limits: DispatchLimits` (always resolved/concrete after `loadConfig` — never `undefined` for callers).
  - `export const DEFAULT_DISPATCH_LIMITS: DispatchLimits` (`src/core/config.ts`)

- [ ] **Step 1: Write the failing tests**

Add to `tests/core/config.test.ts`:

```typescript
  it('fills dispatch_limits with defaults when config.json omits it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-'));
    fs.writeFileSync(
      path.join(root, 'config.json'),
      JSON.stringify({
        default_scoring_adapter: 'stub',
        promotion_threshold: 80,
        actor_source: 'env',
        time_source: 'system',
      })
    );
    const config = loadConfig(root);
    expect(config.dispatch_limits).toEqual({
      max_jobs_per_notebook: 3,
      max_jobs_per_run_global: 5,
      default_mode: 'fast',
      cooldown_days_fast: 14,
      cooldown_days_deep: 30,
      max_attempts_before_stall: 3,
      max_consecutive_dispatch_failures: 5,
    });
  });

  it('merges a partial dispatch_limits with defaults for the missing fields', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-'));
    fs.writeFileSync(
      path.join(root, 'config.json'),
      JSON.stringify({
        default_scoring_adapter: 'stub',
        promotion_threshold: 80,
        actor_source: 'env',
        time_source: 'system',
        dispatch_limits: { max_jobs_per_run_global: 10 },
      })
    );
    const config = loadConfig(root);
    expect(config.dispatch_limits.max_jobs_per_run_global).toBe(10);
    expect(config.dispatch_limits.max_jobs_per_notebook).toBe(3);
  });

  it('throws on an invalid dispatch_limits.default_mode', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-'));
    fs.writeFileSync(
      path.join(root, 'config.json'),
      JSON.stringify({
        default_scoring_adapter: 'stub',
        promotion_threshold: 80,
        actor_source: 'env',
        time_source: 'system',
        dispatch_limits: { default_mode: 'bogus' },
      })
    );
    expect(() => loadConfig(root)).toThrow(/default_mode/);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/core/config.test.ts`
Expected: FAIL — `config.dispatch_limits` is `undefined`.

- [ ] **Step 3: Implement**

In `src/core/types.ts`, add and wire in:

```typescript
export interface DispatchLimits {
  max_jobs_per_notebook: number;
  max_jobs_per_run_global: number;
  default_mode: 'fast' | 'deep';
  cooldown_days_fast: number;
  cooldown_days_deep: number;
  max_attempts_before_stall: number;
  max_consecutive_dispatch_failures: number;
}

export interface TrmConfig {
  default_scoring_adapter: string;
  promotion_threshold: number;
  actor_source: 'env' | 'cli-only';
  time_source: 'system' | 'fixed';
  dispatch_limits: DispatchLimits;
}
```

In `src/core/config.ts`:

```typescript
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TrmConfig, DispatchLimits } from './types';

export const DEFAULT_DISPATCH_LIMITS: DispatchLimits = {
  max_jobs_per_notebook: 3,
  max_jobs_per_run_global: 5,
  default_mode: 'fast',
  cooldown_days_fast: 14,
  cooldown_days_deep: 30,
  max_attempts_before_stall: 3,
  max_consecutive_dispatch_failures: 5,
};

function resolveDispatchLimits(raw: unknown): DispatchLimits {
  const input = (raw ?? {}) as Partial<DispatchLimits>;
  const merged: DispatchLimits = { ...DEFAULT_DISPATCH_LIMITS, ...input };

  if (merged.default_mode !== 'fast' && merged.default_mode !== 'deep') {
    throw new Error(`config.json dispatch_limits.default_mode must be "fast" or "deep", got "${merged.default_mode}"`);
  }
  const numericFields: (keyof DispatchLimits)[] = [
    'max_jobs_per_notebook',
    'max_jobs_per_run_global',
    'cooldown_days_fast',
    'cooldown_days_deep',
    'max_attempts_before_stall',
    'max_consecutive_dispatch_failures',
  ];
  for (const field of numericFields) {
    if (typeof merged[field] !== 'number') {
      throw new Error(`config.json dispatch_limits.${field} must be a number, got ${JSON.stringify(merged[field])}`);
    }
  }
  return merged;
}

export function loadConfig(root: string): TrmConfig {
  const configPath = path.join(root, 'config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`config.json not found at ${configPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  if (raw.actor_source !== 'env' && raw.actor_source !== 'cli-only') {
    throw new Error(`config.json actor_source must be "env" or "cli-only", got "${raw.actor_source}"`);
  }
  if (raw.time_source !== 'system' && raw.time_source !== 'fixed') {
    throw new Error(`config.json time_source must be "system" or "fixed", got "${raw.time_source}"`);
  }
  if (typeof raw.promotion_threshold !== 'number') {
    throw new Error('config.json promotion_threshold must be a number');
  }
  if (typeof raw.default_scoring_adapter !== 'string') {
    throw new Error('config.json default_scoring_adapter must be a string');
  }
  return { ...raw, dispatch_limits: resolveDispatchLimits(raw.dispatch_limits) } as TrmConfig;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/core/config.test.ts`
Expected: PASS (all existing + 3 new tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/core/config.ts tests/core/config.test.ts
git commit -m "feat(config): add dispatch_limits with spec defaults"
```

---

### Task 4: `mine-notebooklm` — populate the research queue

**Files:**
- Modify: `src/cli/commands/mineNotebooklm.ts`
- Modify: `src/cli/commands/mineNotebooklm.test.ts`

**Interfaces:**
- Consumes: `loadConfig` (`../../core/config`), `upsertResearchQueueEntry` (`../../notebooklm/registry`, Task 2).
- Produces (used by Task 6):
  - `export function isUrgentAnswer(answer: string): boolean` (extracted from the existing inline check)
  - `export function appendStalledTodo(root: string, questionText: string, gapKey: string): void`

- [ ] **Step 1: Write the failing tests**

Add to `src/cli/commands/mineNotebooklm.test.ts` (new imports: `isUrgentAnswer, appendStalledTodo`; new import `import { readRegistry, findNotebook } from '../../notebooklm/registry';` already partially present via `registryPath` — add `readRegistry, findNotebook` to that existing import line):

```typescript
  it('isUrgentAnswer matches the three urgency patterns and nothing else', () => {
    expect(isUrgentAnswer('This needs verification against another source.')).toBe(true);
    expect(isUrgentAnswer('We recommend investigating this further.')).toBe(true);
    expect(isUrgentAnswer('No source found for this claim.')).toBe(true);
    expect(isUrgentAnswer('This is well-corroborated by three sources.')).toBe(false);
  });

  it('queues an urgent answer into research_queue with the default dispatch mode', () => {
    fs.writeFileSync(
      path.join(root, 'config.json'),
      JSON.stringify({
        default_scoring_adapter: 'stub',
        promotion_threshold: 80,
        actor_source: 'env',
        time_source: 'system',
        dispatch_limits: { default_mode: 'fast' },
      })
    );
    (nlmCli.queryNotebook as jest.Mock).mockImplementation((_nb: string, question: string) => ({
      ok: true,
      data: question.includes('contradictions') ? 'No source found for the 1943 production date.' : 'Some other answer.',
    }));

    runMineNotebooklm(root, 'nb-1', {});

    const entry = findNotebook(readRegistry(root), 'nb-1')!;
    const queued = Object.values(entry.research_queue!);
    expect(queued).toHaveLength(1);
    expect(queued[0].question_id).toBe('open-contradictions');
    expect(queued[0].mode).toBe('fast');
    expect(queued[0].status).toBe('PENDING');
  });

  it('does not re-queue or reset an already-queued gap on a repeat mining run', () => {
    fs.writeFileSync(
      path.join(root, 'config.json'),
      JSON.stringify({
        default_scoring_adapter: 'stub', promotion_threshold: 80, actor_source: 'env', time_source: 'system',
      })
    );
    (nlmCli.queryNotebook as jest.Mock).mockImplementation((_nb: string, question: string) => ({
      ok: true,
      data: question.includes('contradictions') ? 'No source found for the 1943 production date.' : 'Some other answer.',
    }));

    runMineNotebooklm(root, 'nb-1', {});
    const registry = readRegistry(root);
    const entry = findNotebook(registry, 'nb-1')!;
    const hash = Object.keys(entry.research_queue!)[0];
    entry.research_queue![hash].attempt_count = 2;
    fs.writeFileSync(registryPath(root), JSON.stringify(registry, null, 2));

    // Same answer again, plus a second question that changes to also be urgent
    (nlmCli.queryNotebook as jest.Mock).mockImplementation((_nb: string, question: string) => ({
      ok: true,
      data: question.includes('contradictions') ? 'No source found for the 1943 production date.' : 'Some other answer.',
    }));
    runMineNotebooklm(root, 'nb-1', {});

    const afterEntry = findNotebook(readRegistry(root), 'nb-1')!;
    expect(afterEntry.research_queue![hash].attempt_count).toBe(2); // untouched, not reset to 0
  });

  it('appendStalledTodo appends a [STALLED] line once and is idempotent on the same gap_key', () => {
    fs.writeFileSync(path.join(root, 'TODOS.md'), '# TODOS\n\n## Open\n\n## Completed\n');

    appendStalledTodo(root, 'What open questions exist?', 'nb-1:open-contradictions:abc');
    appendStalledTodo(root, 'What open questions exist?', 'nb-1:open-contradictions:abc');

    const todos = fs.readFileSync(path.join(root, 'TODOS.md'), 'utf-8');
    const occurrences = todos.split('nb-1:open-contradictions:abc').length - 1;
    expect(occurrences).toBe(1);
    expect(todos).toContain('[STALLED]');
  });
```

Also add a `config.json` write in the existing `beforeEach`/tests that call `runMineNotebooklm` and don't already write one (check each test in the file — `loadConfig` will now throw `config.json not found` for any test that doesn't seed it). Add to `beforeEach`, right after `seedRegistry(root)`:

```typescript
    fs.writeFileSync(
      path.join(root, 'config.json'),
      JSON.stringify({ default_scoring_adapter: 'stub', promotion_threshold: 80, actor_source: 'env', time_source: 'system' })
    );
```

Remove the now-redundant per-test `config.json` writes added above in favor of this shared `beforeEach` one, keeping only the ones that need a non-default `dispatch_limits`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/cli/commands/mineNotebooklm.test.ts`
Expected: FAIL — `isUrgentAnswer`/`appendStalledTodo` not exported, `config.json not found` errors, `research_queue` empty.

- [ ] **Step 3: Implement**

In `src/cli/commands/mineNotebooklm.ts`, add imports:

```typescript
import { loadConfig } from '../../core/config';
import { readRegistry, findNotebook, flushMinedState, upsertResearchQueueEntry } from '../../notebooklm/registry';
```

(This replaces the existing narrower `import { readRegistry, findNotebook, flushMinedState } from '../../notebooklm/registry';` line.)

Extract the urgency check and add the stalled-todo appender:

```typescript
export function isUrgentAnswer(answer: string): boolean {
  return URGENCY_PATTERNS.some((p) => p.test(answer));
}

function appendTodoIfUrgent(root: string, answer: string, question: MiningQuestion, key: string): void {
  if (!isUrgentAnswer(answer)) return;

  const todosPath = path.join(root, 'TODOS.md');
  const content = fs.existsSync(todosPath) ? fs.readFileSync(todosPath, 'utf-8') : '# TODOS\n\n## Open\n\n## Completed\n';
  if (content.includes(key) || content.includes(question.text)) return; // idempotent across Open + Completed

  const line = `- [ ] ${question.text} -- ${answer.slice(0, 150)} (${key})\n`;
  const openMarker = '## Open\n';
  const idx = content.indexOf(openMarker);
  const updated =
    idx === -1
      ? `${content}\n## Open\n${line}`
      : `${content.slice(0, idx + openMarker.length)}${line}${content.slice(idx + openMarker.length)}`;
  writeFileAtomic(todosPath, updated);
}

export function appendStalledTodo(root: string, questionText: string, gapKey: string): void {
  const todosPath = path.join(root, 'TODOS.md');
  const content = fs.existsSync(todosPath) ? fs.readFileSync(todosPath, 'utf-8') : '# TODOS\n\n## Open\n\n## Completed\n';
  if (content.includes(gapKey)) return;

  const line = `- [ ] [STALLED] ${questionText} -- research dispatched repeatedly, gap still unresolved (${gapKey})\n`;
  const openMarker = '## Open\n';
  const idx = content.indexOf(openMarker);
  const updated =
    idx === -1
      ? `${content}\n## Open\n${line}`
      : `${content.slice(0, idx + openMarker.length)}${line}${content.slice(idx + openMarker.length)}`;
  writeFileAtomic(todosPath, updated);
}
```

In `runMineNotebooklm`, load config and queue urgent gaps:

```typescript
export function runMineNotebooklm(root: string, notebookId: string, _opts: { topic?: string }): { newEntries: number; docPath: string } {
  const registry = readRegistry(root);
  const entry = findNotebook(registry, notebookId);
  if (!entry) {
    throw new Error(`notebooklm-registry.json has no entry for notebook "${notebookId}"`);
  }
  const config = loadConfig(root);

  const questions = loadMiningQuestions();
  const relativeDocPath = docPathFor(root, slugifyTitle(entry.title));
  const seenKeys = new Set(entry.last_mined_answer_keys);
  let newEntries = 0;
  let anySuccess = false;

  for (const question of questions) {
    const result = queryNotebook(notebookId, question.text);
    if (!result.ok) continue;
    anySuccess = true;

    const key = answerKey(notebookId, question.id, result.data);
    if (seenKeys.has(key)) continue;

    upsertDocRow(root, relativeDocPath, question, result.data, entry.title, key);
    appendTodoIfUrgent(root, result.data, question, key);
    appendResearchGapsMatrix(root, question, result.data, entry.title, key);
    if (isUrgentAnswer(result.data)) {
      upsertResearchQueueEntry(root, notebookId, question, key, config.dispatch_limits.default_mode);
    }
    seenKeys.add(key);
    newEntries++;
  }

  if (anySuccess) {
    flushMinedState(root, notebookId, Array.from(seenKeys), new Date().toISOString());
    if (newEntries > 0) {
      triggerGapTriage(root);
      uploadResearchGapsSource(root, notebookId, relativeDocPath);
    }
  }

  return { newEntries, docPath: relativeDocPath };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/cli/commands/mineNotebooklm.test.ts`
Expected: PASS (all existing + 4 new tests)

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/mineNotebooklm.ts src/cli/commands/mineNotebooklm.test.ts
git commit -m "feat(notebooklm): queue urgent mining gaps for push-research"
```

---

### Task 5: `research-notebooklm` — selection and ordering (pure logic)

**Files:**
- Create: `src/cli/commands/researchNotebooklm.ts`
- Test: `src/cli/commands/researchNotebooklm.test.ts`

**Interfaces:**
- Consumes: `RegistryFile`, `NotebookRegistryEntry`, `ResearchQueueEntry` (`../../notebooklm/registry`, Task 2), `DispatchLimits` (`../../core/types`, Task 3), `loadMiningQuestions` (`./mineNotebooklm`, existing).
- Produces (used by Task 6):
  - `export interface DispatchCandidate { notebookId: string; entry: ResearchQueueEntry; }`
  - `export function selectDispatchPlan(registry: RegistryFile, notebookId: string | undefined, limits: DispatchLimits, forceResearch: boolean, now: Date): DispatchCandidate[]`

**Selection rules implemented here (from the spec's "New command" section):**
1. Explicit `notebookId`: that notebook only (not-found handling is the caller's job in Task 6, since it needs `findNotebook`'s exact error message). Missing here just means an empty registry lookup returns no candidates.
2. Omitted `notebookId`: every notebook with at least one `PENDING` `research_queue` entry, ordered by that notebook's oldest `PENDING` entry's `last_researched_at` (`null` sorts first), tie-broken by `notebookId` ascending.
3. Within a notebook, entries are visited in `config/mining-questions.json` order (via `loadMiningQuestions`), skipping `STALLED_NEEDS_HUMAN`/`INFRASTRUCTURE_BLOCKED`, and skipping cooldown unless `forceResearch`.
4. Per-notebook cap (`max_jobs_per_notebook`) and a running global cap (`max_jobs_per_run_global`) across the whole returned list.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/cli/commands/researchNotebooklm.test.ts
import { selectDispatchPlan } from './researchNotebooklm';
import { RegistryFile, ResearchQueueEntry } from '../../notebooklm/registry';
import { DEFAULT_DISPATCH_LIMITS } from '../../core/config';

function entry(overrides: Partial<ResearchQueueEntry> = {}): ResearchQueueEntry {
  return {
    question_hash: 'h1',
    question_text: 'What open questions or unresolved contradictions exist across these sources?',
    question_id: 'open-contradictions',
    gap_key: 'nb:open-contradictions:x',
    mode: 'fast',
    attempt_count: 0,
    consecutive_dispatch_failures: 0,
    last_researched_at: null,
    last_dispatch_error: null,
    status: 'PENDING',
    ...overrides,
  };
}

function registryWith(notebooks: Array<{ id: string; queue: Record<string, ResearchQueueEntry> }>): RegistryFile {
  return {
    version: 1,
    notebooks: notebooks.map((n) => ({
      notebook_id: n.id,
      title: n.id,
      url: `https://x/${n.id}`,
      last_pulled_hashes: {},
      quarantined: {},
      last_ingested_at: null,
      last_mined_at: null,
      last_mined_answer_keys: [],
      research_queue: n.queue,
    })),
  };
}

describe('selectDispatchPlan', () => {
  const now = new Date('2026-09-13T00:00:00.000Z');

  it('selects the explicit notebook only, ignoring others', () => {
    const registry = registryWith([
      { id: 'nb-1', queue: { h1: entry() } },
      { id: 'nb-2', queue: { h2: entry({ question_hash: 'h2' }) } },
    ]);
    const plan = selectDispatchPlan(registry, 'nb-1', DEFAULT_DISPATCH_LIMITS, false, now);
    expect(plan.map((c) => c.notebookId)).toEqual(['nb-1']);
  });

  it('skips STALLED_NEEDS_HUMAN and INFRASTRUCTURE_BLOCKED entries', () => {
    const registry = registryWith([
      {
        id: 'nb-1',
        queue: {
          h1: entry({ status: 'STALLED_NEEDS_HUMAN' }),
          h2: entry({ question_hash: 'h2', status: 'INFRASTRUCTURE_BLOCKED' }),
          h3: entry({ question_hash: 'h3', status: 'PENDING' }),
        },
      },
    ]);
    const plan = selectDispatchPlan(registry, 'nb-1', DEFAULT_DISPATCH_LIMITS, false, now);
    expect(plan.map((c) => c.entry.question_hash)).toEqual(['h3']);
  });

  it('skips entries inside the cooldown window unless forceResearch', () => {
    const recentlyResearched = entry({ last_researched_at: '2026-09-12T00:00:00.000Z' }); // 1 day ago, fast cooldown is 14 days
    const registry = registryWith([{ id: 'nb-1', queue: { h1: recentlyResearched } }]);

    expect(selectDispatchPlan(registry, 'nb-1', DEFAULT_DISPATCH_LIMITS, false, now)).toHaveLength(0);
    expect(selectDispatchPlan(registry, 'nb-1', DEFAULT_DISPATCH_LIMITS, true, now)).toHaveLength(1);
  });

  it('applies the per-notebook cap', () => {
    const registry = registryWith([
      {
        id: 'nb-1',
        queue: {
          h1: entry({ question_hash: 'h1', question_id: 'open-contradictions' }),
          h2: entry({ question_hash: 'h2', question_id: 'under-sourced' }),
          h3: entry({ question_hash: 'h3', question_id: 'adjacent-topics' }),
          h4: entry({ question_hash: 'h4', question_id: 'follow-up' }),
        },
      },
    ]);
    const limits = { ...DEFAULT_DISPATCH_LIMITS, max_jobs_per_notebook: 2, max_jobs_per_run_global: 10 };
    const plan = selectDispatchPlan(registry, 'nb-1', limits, false, now);
    expect(plan).toHaveLength(2);
    expect(plan.map((c) => c.entry.question_id)).toEqual(['open-contradictions', 'under-sourced']); // question order
  });

  it('applies the global cap across notebooks, ordering never-researched notebooks first, tie-broken by id', () => {
    const registry = registryWith([
      { id: 'nb-b', queue: { h1: entry({ last_researched_at: null }) } },
      { id: 'nb-a', queue: { h2: entry({ question_hash: 'h2', last_researched_at: null }) } },
      { id: 'nb-c', queue: { h3: entry({ question_hash: 'h3', last_researched_at: '2020-01-01T00:00:00.000Z' }) } },
    ]);
    const limits = { ...DEFAULT_DISPATCH_LIMITS, max_jobs_per_notebook: 5, max_jobs_per_run_global: 2 };
    const plan = selectDispatchPlan(registry, undefined, limits, false, now);
    expect(plan.map((c) => c.notebookId)).toEqual(['nb-a', 'nb-b']); // both null last_researched_at, tie-broken a<b; nb-c excluded by global cap
  });

  it('excludes notebooks with no eligible PENDING entries from the omitted-id sweep', () => {
    const registry = registryWith([
      { id: 'nb-1', queue: { h1: entry({ status: 'EXECUTED' }) } },
      { id: 'nb-2', queue: { h2: entry({ question_hash: 'h2', status: 'PENDING' }) } },
    ]);
    const plan = selectDispatchPlan(registry, undefined, DEFAULT_DISPATCH_LIMITS, false, now);
    expect(plan.map((c) => c.notebookId)).toEqual(['nb-2']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/cli/commands/researchNotebooklm.test.ts`
Expected: FAIL with "Cannot find module './researchNotebooklm'"

- [ ] **Step 3: Implement `selectDispatchPlan`**

```typescript
// src/cli/commands/researchNotebooklm.ts
import { RegistryFile, NotebookRegistryEntry, ResearchQueueEntry, findNotebook } from '../../notebooklm/registry';
import { DispatchLimits } from '../../core/types';
import { loadMiningQuestions } from './mineNotebooklm';

export interface DispatchCandidate {
  notebookId: string;
  entry: ResearchQueueEntry;
}

function cooldownMs(entry: ResearchQueueEntry, limits: DispatchLimits): number {
  const days = entry.mode === 'fast' ? limits.cooldown_days_fast : limits.cooldown_days_deep;
  return days * 24 * 60 * 60 * 1000;
}

function isEligible(entry: ResearchQueueEntry, limits: DispatchLimits, forceResearch: boolean, now: Date): boolean {
  if (entry.status === 'STALLED_NEEDS_HUMAN' || entry.status === 'INFRASTRUCTURE_BLOCKED') return false;
  if (forceResearch) return true;
  if (!entry.last_researched_at) return true;
  return now.getTime() - new Date(entry.last_researched_at).getTime() >= cooldownMs(entry, limits);
}

function orderedEligibleEntries(entry: NotebookRegistryEntry, limits: DispatchLimits, forceResearch: boolean, now: Date): ResearchQueueEntry[] {
  const questionOrder = new Map(loadMiningQuestions().map((q, idx) => [q.id, idx]));
  return Object.values(entry.research_queue ?? {})
    .filter((e) => isEligible(e, limits, forceResearch, now))
    .sort((a, b) => (questionOrder.get(a.question_id) ?? Infinity) - (questionOrder.get(b.question_id) ?? Infinity));
}

function oldestPendingTimestamp(entry: NotebookRegistryEntry): number {
  const pending = Object.values(entry.research_queue ?? {}).filter((e) => e.status === 'PENDING');
  if (pending.length === 0) return Infinity; // no PENDING entries -- excluded from the sweep entirely
  const timestamps = pending.map((e) => (e.last_researched_at ? new Date(e.last_researched_at).getTime() : -Infinity));
  return Math.min(...timestamps);
}

function candidateNotebooksInOrder(registry: RegistryFile): NotebookRegistryEntry[] {
  return registry.notebooks
    .filter((n) => oldestPendingTimestamp(n) !== Infinity)
    .sort((a, b) => {
      const diff = oldestPendingTimestamp(a) - oldestPendingTimestamp(b);
      if (diff !== 0) return diff;
      return a.notebook_id.localeCompare(b.notebook_id);
    });
}

export function selectDispatchPlan(
  registry: RegistryFile,
  notebookId: string | undefined,
  limits: DispatchLimits,
  forceResearch: boolean,
  now: Date
): DispatchCandidate[] {
  const notebooks = notebookId
    ? [findNotebook(registry, notebookId)].filter((n): n is NotebookRegistryEntry => n !== null)
    : candidateNotebooksInOrder(registry);

  const plan: DispatchCandidate[] = [];
  for (const notebook of notebooks) {
    if (plan.length >= limits.max_jobs_per_run_global) break;
    const eligible = orderedEligibleEntries(notebook, limits, forceResearch, now);
    const remainingGlobal = limits.max_jobs_per_run_global - plan.length;
    const take = eligible.slice(0, Math.min(limits.max_jobs_per_notebook, remainingGlobal));
    for (const entry of take) {
      plan.push({ notebookId: notebook.notebook_id, entry });
    }
  }
  return plan;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/cli/commands/researchNotebooklm.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/researchNotebooklm.ts src/cli/commands/researchNotebooklm.test.ts
git commit -m "feat(notebooklm): add research-notebooklm dispatch selection logic"
```

---

### Task 6: `research-notebooklm` — dispatch execution and state transitions

**Files:**
- Modify: `src/cli/commands/researchNotebooklm.ts`
- Modify: `src/cli/commands/researchNotebooklm.test.ts`

**Interfaces:**
- Consumes: `selectDispatchPlan`, `DispatchCandidate` (Task 5, same file); `researchStart`, `researchStatus`, `researchImport` (`../../notebooklm/nlmResearch`, Task 1); `flushResearchQueueEntry` (`../../notebooklm/registry`, Task 2); `queryNotebook` (`../../notebooklm/nlmCli`, existing); `isUrgentAnswer`, `appendStalledTodo` (`./mineNotebooklm`, Task 4); `loadConfig` (`../../core/config`, Task 3); `readRegistry`, `findNotebook` (`../../notebooklm/registry`, existing).
- Produces (used by Task 7):
  - `export interface ResearchNotebooklmResult { dispatched: number; succeeded: number; transientFailures: number; stalled: number; infrastructureBlocked: number; skipped: number; }`
  - `export function runResearchNotebooklm(root: string, notebookId: string | undefined, opts: { forceResearch: boolean }): ResearchNotebooklmResult`

**Design decision documented here (deviation-free, but worth being explicit about):** the re-query-for-stall-check step reuses `queryNotebook` directly rather than calling `runMineNotebooklm`, because the spec is explicit that this "does not wait for the next scheduled mining pass" — it is a single fresh question/answer check, not a full mining pass (which would re-run all 4 questions and touch doc/TODOS state this function doesn't own). If that re-query itself fails (`queryNotebook` returns `ok: false`), this implementation conservatively treats the gap as **still urgent** (stays `PENDING`, no stall/EXECUTED transition) rather than silently marking it resolved — a network blip on the confirmation call must not hide an unresolved gap.

- [ ] **Step 1: Write the failing tests**

```typescript
// append to src/cli/commands/researchNotebooklm.test.ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runResearchNotebooklm } from './researchNotebooklm';
import { registryPath, readRegistry, findNotebook, questionHash } from '../../notebooklm/registry';
import * as nlmResearch from '../../notebooklm/nlmResearch';
import * as nlmCli from '../../notebooklm/nlmCli';

jest.mock('../../notebooklm/nlmResearch');
jest.mock('../../notebooklm/nlmCli');

function seedRunRegistry(root: string, queueEntry: object): void {
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
          research_queue: { [questionHash('What open questions or unresolved contradictions exist across these sources?')]: queueEntry },
        },
      ],
    })
  );
}

function baseEntry(overrides: object = {}) {
  return {
    question_hash: questionHash('What open questions or unresolved contradictions exist across these sources?'),
    question_text: 'What open questions or unresolved contradictions exist across these sources?',
    question_id: 'open-contradictions',
    gap_key: 'nb-1:open-contradictions:x',
    mode: 'fast',
    attempt_count: 0,
    consecutive_dispatch_failures: 0,
    last_researched_at: null,
    last_dispatch_error: null,
    status: 'PENDING',
    ...overrides,
  };
}

describe('runResearchNotebooklm', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-nlmresearch-'));
    fs.writeFileSync(
      path.join(root, 'config.json'),
      JSON.stringify({ default_scoring_adapter: 'stub', promotion_threshold: 80, actor_source: 'env', time_source: 'system' })
    );
    jest.resetAllMocks();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('on full success with a resolved gap, marks EXECUTED and starts the cooldown', () => {
    seedRunRegistry(root, baseEntry());
    (nlmResearch.researchStart as jest.Mock).mockReturnValue({ ok: true, data: { taskId: 'rt-1' } });
    (nlmResearch.researchStatus as jest.Mock).mockReturnValue({ ok: true, data: { completed: true } });
    (nlmResearch.researchImport as jest.Mock).mockReturnValue({ ok: true, data: undefined });
    (nlmCli.queryNotebook as jest.Mock).mockReturnValue({ ok: true, data: 'Fully resolved, well-sourced now.' });

    const result = runResearchNotebooklm(root, 'nb-1', { forceResearch: false });

    expect(result.succeeded).toBe(1);
    const entry = findNotebook(readRegistry(root), 'nb-1')!.research_queue![baseEntry().question_hash];
    expect(entry.status).toBe('EXECUTED');
    expect(entry.attempt_count).toBe(1);
    expect(entry.last_researched_at).not.toBeNull();
    expect(entry.consecutive_dispatch_failures).toBe(0);
  });

  it('on success but still urgent, with attempts remaining, stays PENDING', () => {
    seedRunRegistry(root, baseEntry({ attempt_count: 0 }));
    (nlmResearch.researchStart as jest.Mock).mockReturnValue({ ok: true, data: { taskId: 'rt-1' } });
    (nlmResearch.researchStatus as jest.Mock).mockReturnValue({ ok: true, data: { completed: true } });
    (nlmResearch.researchImport as jest.Mock).mockReturnValue({ ok: true, data: undefined });
    (nlmCli.queryNotebook as jest.Mock).mockReturnValue({ ok: true, data: 'Still no source found for this.' });

    runResearchNotebooklm(root, 'nb-1', { forceResearch: false });

    const entry = findNotebook(readRegistry(root), 'nb-1')!.research_queue![baseEntry().question_hash];
    expect(entry.status).toBe('PENDING');
    expect(entry.attempt_count).toBe(1);
  });

  it('on success but still urgent, at max_attempts_before_stall, transitions to STALLED_NEEDS_HUMAN and appends a TODOS.md line', () => {
    fs.writeFileSync(path.join(root, 'TODOS.md'), '# TODOS\n\n## Open\n\n## Completed\n');
    seedRunRegistry(root, baseEntry({ attempt_count: 2 })); // default max_attempts_before_stall is 3
    (nlmResearch.researchStart as jest.Mock).mockReturnValue({ ok: true, data: { taskId: 'rt-1' } });
    (nlmResearch.researchStatus as jest.Mock).mockReturnValue({ ok: true, data: { completed: true } });
    (nlmResearch.researchImport as jest.Mock).mockReturnValue({ ok: true, data: undefined });
    (nlmCli.queryNotebook as jest.Mock).mockReturnValue({ ok: true, data: 'Still no source found for this.' });

    runResearchNotebooklm(root, 'nb-1', { forceResearch: false });

    const entry = findNotebook(readRegistry(root), 'nb-1')!.research_queue![baseEntry().question_hash];
    expect(entry.status).toBe('STALLED_NEEDS_HUMAN');
    expect(entry.attempt_count).toBe(3);
    const todos = fs.readFileSync(path.join(root, 'TODOS.md'), 'utf-8');
    expect(todos).toContain('[STALLED]');
    expect(todos).toContain('nb-1:open-contradictions:x');
  });

  it('a transient researchStart failure leaves attempt_count/cooldown untouched and increments consecutive_dispatch_failures', () => {
    seedRunRegistry(root, baseEntry());
    (nlmResearch.researchStart as jest.Mock).mockReturnValue({ ok: false, error: 'network blip' });

    runResearchNotebooklm(root, 'nb-1', { forceResearch: false });

    const entry = findNotebook(readRegistry(root), 'nb-1')!.research_queue![baseEntry().question_hash];
    expect(entry.status).toBe('PENDING');
    expect(entry.attempt_count).toBe(0);
    expect(entry.last_researched_at).toBeNull();
    expect(entry.consecutive_dispatch_failures).toBe(1);
    expect(entry.last_dispatch_error).toBe('network blip');
  });

  it('a status timeout on exit 0 is treated as a transient failure, not a success', () => {
    seedRunRegistry(root, baseEntry());
    (nlmResearch.researchStart as jest.Mock).mockReturnValue({ ok: true, data: { taskId: 'rt-1' } });
    (nlmResearch.researchStatus as jest.Mock).mockReturnValue({ ok: true, data: { completed: false } });

    runResearchNotebooklm(root, 'nb-1', { forceResearch: false });

    const entry = findNotebook(readRegistry(root), 'nb-1')!.research_queue![baseEntry().question_hash];
    expect(entry.status).toBe('PENDING');
    expect(entry.attempt_count).toBe(0);
    expect(entry.consecutive_dispatch_failures).toBe(1);
    expect(nlmResearch.researchImport).not.toHaveBeenCalled();
  });

  it('reaching max_consecutive_dispatch_failures transitions to INFRASTRUCTURE_BLOCKED', () => {
    seedRunRegistry(root, baseEntry({ consecutive_dispatch_failures: 4 })); // default max is 5
    (nlmResearch.researchStart as jest.Mock).mockReturnValue({ ok: false, error: 'still failing' });

    runResearchNotebooklm(root, 'nb-1', { forceResearch: false });

    const entry = findNotebook(readRegistry(root), 'nb-1')!.research_queue![baseEntry().question_hash];
    expect(entry.status).toBe('INFRASTRUCTURE_BLOCKED');
    expect(entry.consecutive_dispatch_failures).toBe(5);
  });

  it('a query failure on the post-success re-query keeps the entry PENDING rather than marking EXECUTED', () => {
    seedRunRegistry(root, baseEntry());
    (nlmResearch.researchStart as jest.Mock).mockReturnValue({ ok: true, data: { taskId: 'rt-1' } });
    (nlmResearch.researchStatus as jest.Mock).mockReturnValue({ ok: true, data: { completed: true } });
    (nlmResearch.researchImport as jest.Mock).mockReturnValue({ ok: true, data: undefined });
    (nlmCli.queryNotebook as jest.Mock).mockReturnValue({ ok: false, error: 'timeout' });

    runResearchNotebooklm(root, 'nb-1', { forceResearch: false });

    const entry = findNotebook(readRegistry(root), 'nb-1')!.research_queue![baseEntry().question_hash];
    expect(entry.status).toBe('PENDING');
    expect(entry.attempt_count).toBe(1); // the dispatch itself still counts as a completed attempt
  });

  it('throws when an explicit notebookId is not present in the registry', () => {
    fs.writeFileSync(registryPath(root), JSON.stringify({ version: 1, notebooks: [] }));
    expect(() => runResearchNotebooklm(root, 'no-such-notebook', { forceResearch: false })).toThrow(
      /notebooklm-registry\.json has no entry for notebook "no-such-notebook"/
    );
  });

  it('a --force-research bypasses cooldown but does not dispatch a STALLED or BLOCKED entry', () => {
    seedRunRegistry(root, baseEntry({ status: 'STALLED_NEEDS_HUMAN', last_researched_at: '2026-09-12T00:00:00.000Z' }));

    runResearchNotebooklm(root, 'nb-1', { forceResearch: true });

    expect(nlmResearch.researchStart).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/cli/commands/researchNotebooklm.test.ts`
Expected: FAIL — `runResearchNotebooklm` not exported.

- [ ] **Step 3: Implement `runResearchNotebooklm`**

Append to `src/cli/commands/researchNotebooklm.ts`:

```typescript
import { readRegistry, findNotebook, flushResearchQueueEntry } from '../../notebooklm/registry';
import { loadConfig } from '../../core/config';
import { researchStart, researchStatus, researchImport } from '../../notebooklm/nlmResearch';
import { queryNotebook } from '../../notebooklm/nlmCli';
import { isUrgentAnswer, appendStalledTodo } from './mineNotebooklm';

export interface ResearchNotebooklmResult {
  dispatched: number;
  succeeded: number;
  transientFailures: number;
  stalled: number;
  infrastructureBlocked: number;
  skipped: number;
}

const STATUS_MAX_WAIT_SECONDS = 300;

function recordTransientFailure(root: string, notebookId: string, entry: ResearchQueueEntry, limits: DispatchLimits, message: string): 'PENDING' | 'INFRASTRUCTURE_BLOCKED' {
  const failures = entry.consecutive_dispatch_failures + 1;
  const status = failures >= limits.max_consecutive_dispatch_failures ? 'INFRASTRUCTURE_BLOCKED' : 'PENDING';
  flushResearchQueueEntry(root, notebookId, entry.question_hash, {
    consecutive_dispatch_failures: failures,
    last_dispatch_error: message,
    status,
  });
  if (status === 'INFRASTRUCTURE_BLOCKED') {
    console.error(
      `research-notebooklm: notebook "${notebookId}" question "${entry.question_id}" marked INFRASTRUCTURE_BLOCKED after ${failures} consecutive dispatch failures: ${message}`
    );
  }
  return status;
}

function recordSuccess(root: string, notebookId: string, entry: ResearchQueueEntry, limits: DispatchLimits, nowIso: string): 'EXECUTED' | 'PENDING' | 'STALLED_NEEDS_HUMAN' {
  const attemptCount = entry.attempt_count + 1;
  const requery = queryNotebook(notebookId, entry.question_text);
  // A failed re-query must not be mistaken for "resolved" -- stay urgent so the
  // gap is retried next eligible run instead of silently going quiet.
  const stillUrgent = requery.ok ? isUrgentAnswer(requery.data) : true;

  let status: 'EXECUTED' | 'PENDING' | 'STALLED_NEEDS_HUMAN';
  if (!stillUrgent) {
    status = 'EXECUTED';
  } else if (attemptCount >= limits.max_attempts_before_stall) {
    status = 'STALLED_NEEDS_HUMAN';
    appendStalledTodo(root, entry.question_text, entry.gap_key);
  } else {
    status = 'PENDING';
  }

  flushResearchQueueEntry(root, notebookId, entry.question_hash, {
    attempt_count: attemptCount,
    last_researched_at: nowIso,
    consecutive_dispatch_failures: 0,
    last_dispatch_error: null,
    status,
  });
  return status;
}

function dispatchCandidate(root: string, candidate: DispatchCandidate, limits: DispatchLimits, forceResearch: boolean, nowIso: string): 'succeeded' | 'transientFailure' | 'stalled' | 'infrastructureBlocked' {
  const { notebookId, entry } = candidate;

  const startResult = researchStart(notebookId, entry.question_text, entry.mode, forceResearch);
  if (!startResult.ok) {
    return recordTransientFailure(root, notebookId, entry, limits, startResult.error) === 'INFRASTRUCTURE_BLOCKED' ? 'infrastructureBlocked' : 'transientFailure';
  }

  const statusResult = researchStatus(notebookId, startResult.data.taskId, STATUS_MAX_WAIT_SECONDS);
  if (!statusResult.ok) {
    return recordTransientFailure(root, notebookId, entry, limits, statusResult.error) === 'INFRASTRUCTURE_BLOCKED' ? 'infrastructureBlocked' : 'transientFailure';
  }
  if (!statusResult.data.completed) {
    return recordTransientFailure(root, notebookId, entry, limits, 'research task timed out before completing') === 'INFRASTRUCTURE_BLOCKED' ? 'infrastructureBlocked' : 'transientFailure';
  }

  const importResult = researchImport(notebookId, startResult.data.taskId);
  if (!importResult.ok) {
    return recordTransientFailure(root, notebookId, entry, limits, importResult.error) === 'INFRASTRUCTURE_BLOCKED' ? 'infrastructureBlocked' : 'transientFailure';
  }

  const finalStatus = recordSuccess(root, notebookId, entry, limits, nowIso);
  return finalStatus === 'STALLED_NEEDS_HUMAN' ? 'stalled' : 'succeeded';
}

export function runResearchNotebooklm(root: string, notebookId: string | undefined, opts: { forceResearch: boolean }): ResearchNotebooklmResult {
  if (notebookId) {
    const registry = readRegistry(root);
    if (!findNotebook(registry, notebookId)) {
      throw new Error(`notebooklm-registry.json has no entry for notebook "${notebookId}"`);
    }
  }

  const config = loadConfig(root);
  const registry = readRegistry(root);
  const plan = selectDispatchPlan(registry, notebookId, config.dispatch_limits, opts.forceResearch, new Date());
  const nowIso = new Date().toISOString();

  const result: ResearchNotebooklmResult = { dispatched: 0, succeeded: 0, transientFailures: 0, stalled: 0, infrastructureBlocked: 0, skipped: 0 };

  for (const candidate of plan) {
    result.dispatched++;
    const outcome = dispatchCandidate(root, candidate, config.dispatch_limits, opts.forceResearch, nowIso);
    if (outcome === 'succeeded') result.succeeded++;
    else if (outcome === 'stalled') result.stalled++;
    else if (outcome === 'infrastructureBlocked') result.infrastructureBlocked++;
    else result.transientFailures++;
  }

  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/cli/commands/researchNotebooklm.test.ts`
Expected: PASS (14 tests total across both parts of this file)

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/researchNotebooklm.ts src/cli/commands/researchNotebooklm.test.ts
git commit -m "feat(notebooklm): dispatch push-research and reconcile queue state"
```

---

### Task 7: Wire the CLI command and the nightly wrapper

**Files:**
- Modify: `src/cli/index.ts`
- Modify: `schedule-task-wrapper-TRM-Notebooklm-Mine.ps1`

**Interfaces:**
- Consumes: `runResearchNotebooklm` (`./commands/researchNotebooklm`, Task 6).

- [ ] **Step 1: Wire the command into `src/cli/index.ts`**

Add the import alongside the existing `mineNotebooklm` import:

```typescript
import { runResearchNotebooklm } from './commands/researchNotebooklm';
```

Add the command registration directly after the existing `mine-notebooklm` command block:

```typescript
program
  .command('research-notebooklm [notebook-id]')
  .option('--force-research', 'bypass cooldown for eligible entries (does not bypass STALLED/BLOCKED status)')
  .action((notebookId, opts) => {
    try {
      const result = runResearchNotebooklm(root, notebookId, { forceResearch: !!opts.forceResearch });
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });
```

- [ ] **Step 2: Manually verify the command wires up**

Run: `npm run trm -- research-notebooklm --help`
Expected: Commander prints usage for `research-notebooklm [notebook-id]` with the `--force-research` option listed, exit code 0.

- [ ] **Step 3: Chain the new command into the nightly wrapper**

In `schedule-task-wrapper-TRM-Notebooklm-Mine.ps1`, add a second stage after the existing `foreach ($Notebook in $Registry.notebooks) { ... }` mining loop and before the "Refresh Daily Status Report" section:

```powershell
"=== research-notebooklm (all notebooks) ===" | Tee-Object -FilePath $LogFile -Append
try {
    & trm research-notebooklm 2>&1 | Tee-Object -FilePath $LogFile -Append
    if ($LASTEXITCODE -ne 0) {
        "research-notebooklm failed with exit code $LASTEXITCODE" | Tee-Object -FilePath $LogFile -Append
        $ExitCode = 1
    }
} catch {
    "research-notebooklm threw: $_" | Tee-Object -FilePath $LogFile -Append
    $ExitCode = 1
}
```

(Uses the `trm` binary and the existing `$ExitCode`/`$LogFile` variables already in scope in this script, consistent with how the mining loop above it is invoked — not the `node dist/cli/index.js` form sketched in the design doc, which doesn't match how this wrapper actually shells out.)

- [ ] **Step 4: Update the wrapper's header comment**

Change the top-of-file comment to reflect the new second stage:

```powershell
# schedule-task-wrapper-TRM-Notebooklm-Mine.ps1
# Weekly sweep: runs `trm mine-notebooklm <id>` for every notebook in
# notebooklm-registry.json, then `trm research-notebooklm` once across all
# notebooks to dispatch push-research for any urgent gaps mining queued.
# Registered in Windows Task Scheduler, weekly trigger -- see
# docs/superpowers/specs/2026-08-12-notebooklm-cic-ingest-mining-design.md §5
# and docs/superpowers/specs/2026-09-13-notebooklm-push-research-loop-design.md.
```

- [ ] **Step 5: Run the full test suite**

Run: `npx jest`
Expected: PASS, no regressions (PowerShell has no test harness in this repo — Steps 3-4 are reviewed by reading, not by an automated test).

- [ ] **Step 6: Commit**

```bash
git add src/cli/index.ts schedule-task-wrapper-TRM-Notebooklm-Mine.ps1
git commit -m "feat(notebooklm): wire research-notebooklm into the CLI and nightly wrapper"
```

---

## Self-Review

**Spec coverage:**
- Data model (`ResearchQueueEntry`, `research_queue`) → Task 2.
- Config (`dispatch_limits`, defaults) → Task 3.
- Population from `mine-notebooklm` → Task 4.
- New command, notebook selection/ordering, per-entry cooldown/cap/skip logic → Task 5.
- 3-step dispatch sequence, success/transient-failure/stall/blocked transitions, re-query stall check → Task 1 (CLI wrapper) + Task 6 (orchestration).
- Nightly wrapper chaining → Task 7.
- Testing checklist in the spec: cooldown skip ✓ (Task 5), `--force-research` bypasses cooldown but not stall/blocked ✓ (Task 5 + Task 6), attempt increment + cooldown start on success ✓ (Task 6), stall transition at cap ✓ (Task 6), transient failure leaves attempt_count/cooldown untouched ✓ (Task 6), `INFRASTRUCTURE_BLOCKED` transition ✓ (Task 6), global + per-notebook caps ✓ (Task 5), `TODOS.md` idempotent stall append ✓ (Task 4 + Task 6), explicit unknown `notebookId` throws ✓ (Task 6), re-query resolves to `EXECUTED` even at `attempt_count >= max_attempts_before_stall` ✓ (Task 6, `recordSuccess` checks `!stillUrgent` before the stall check), global-cap ordering by oldest `last_researched_at` including `null`, tie-broken by id ✓ (Task 5).

**Placeholder scan:** no `TBD`/`implement later`/bare prose steps — the one deliberately open item is Task 1's live-calibration step, which is a real, boundaried action (run 2 real CLI commands, compare output to two named regexes, edit them if they don't match) rather than an unspecified placeholder.

**Type consistency:** `ResearchQueueEntry`, `DispatchLimits`, `DispatchCandidate`, `ResearchCallResult<T>`, and `ResearchNotebooklmResult` are defined once (Tasks 1-3, 5-6) and referenced by the same names/shapes in every later task that consumes them.
