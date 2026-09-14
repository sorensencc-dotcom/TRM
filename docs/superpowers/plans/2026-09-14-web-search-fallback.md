# Web Search Fallback/Bypass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give trm's NotebookLM research loop a Parallel.ai web-search bypass (`web_strategy: "web"`) and a last-resort fallback (`web_strategy: "auto"` at the existing stall point) so gaps that `nlm research` can't answer get one more shot via live web search before being flagged for a human.

**Architecture:** Two new standalone modules (`src/research/webSearch.ts`, `src/research/evidenceWriter.ts`) with zero registry/CLI coupling, wired into the existing `research-notebooklm` dispatch command's success/failure branches. Web search hits get staged as markdown and re-ingested into NotebookLM via `nlm source add`, so NotebookLM stays the single source of truth — nothing here answers a gap directly.

**Tech Stack:** TypeScript, Jest, Node built-in `fetch`, Parallel.ai's `v1beta/search` REST endpoint (no SDK dependency), `nlm` CLI (subprocess).

**Spec:** `docs/superpowers/specs/2026-09-14-web-search-fallback-design.md`

## Global Constraints

- No dependency on the `toolforge` repo's `parallel-search` skill or its `parallel-web` SDK package — direct `fetch` calls only, per spec Decisions.
- `PARALLEL_API_KEY` read via `process.env.PARALLEL_API_KEY` directly — no `config.ts`/`TrmConfig` changes, matching trm's existing `TRM_*` env var convention.
- No live Parallel or `nlm` calls in any test — everything mocked.
- Evidence markdown ids limited to alphanumeric + dash, max 64 chars, before touching any filesystem path.

## Prerequisite

**This plan's Tasks 3 and 4 require the separate, already-written plan `docs/superpowers/plans/2026-09-13-notebooklm-push-research-loop.md` to be implemented first** (specifically its Tasks 2, 4, and 6 — `ResearchQueueEntry`/`flushResearchQueueEntry` in `src/notebooklm/registry.ts`, `isUrgentAnswer`/`appendStalledTodo` in `src/cli/commands/mineNotebooklm.ts`, and `runResearchNotebooklm`/`dispatchCandidate`/`recordSuccess`/`recordTransientFailure` in `src/cli/commands/researchNotebooklm.ts`). As of this writing that plan has not been executed — confirmed via `ls src/cli/commands/ | grep research` returning nothing and no `ResearchQueueEntry` in `src/notebooklm/registry.ts`.

Tasks 1 and 2 below have no such dependency and can be built and merged independently, in either order relative to the other plan.

---

### Task 1: `src/research/webSearch.ts` — Parallel search wrapper

**Files:**
- Create: `src/research/webSearch.ts`
- Test: `src/research/webSearch.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (uses global `fetch`, `process.env.PARALLEL_API_KEY`).
- Produces (used by Task 2 and Task 4):
  - `export interface WebSearchHit { title: string; url: string; snippet: string }`
  - `export interface WebSearchResult { query: string; hits: WebSearchHit[] }`
  - `export async function searchWeb(query: string): Promise<WebSearchResult>` — throws `Error` on: missing `PARALLEL_API_KEY`, non-2xx HTTP response, network failure, or a response body without an array `results` field.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/research/webSearch.test.ts
import { searchWeb } from './webSearch';

describe('searchWeb', () => {
  const originalKey = process.env.PARALLEL_API_KEY;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env.PARALLEL_API_KEY = 'test-key-123';
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });

  afterEach(() => {
    process.env.PARALLEL_API_KEY = originalKey;
    jest.resetAllMocks();
  });

  it('throws if PARALLEL_API_KEY is not set', async () => {
    delete process.env.PARALLEL_API_KEY;
    await expect(searchWeb('some query')).rejects.toThrow(/PARALLEL_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs to the Parallel search endpoint with the right shape', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [], search_id: 'search_abc' }),
    });

    await searchWeb('what is the latest release of @octokit/rest');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.parallel.ai/v1beta/search',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-api-key': 'test-key-123', 'content-type': 'application/json' }),
        body: JSON.stringify({ search_queries: ['what is the latest release of @octokit/rest'], excerpts: true }),
      })
    );
  });

  it('maps a successful response into WebSearchResult', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          { url: 'https://example.com/a', title: 'Example A', excerpts: ['first excerpt', 'second excerpt'] },
          { url: 'https://example.com/b', title: null, excerpts: null },
        ],
        search_id: 'search_abc',
      }),
    });

    const result = await searchWeb('query text');

    expect(result).toEqual({
      query: 'query text',
      hits: [
        { title: 'Example A', url: 'https://example.com/a', snippet: 'first excerpt' },
        { title: '(untitled)', url: 'https://example.com/b', snippet: '' },
      ],
    });
  });

  it('throws on a non-2xx response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({ error: 'rate limited' }) });
    await expect(searchWeb('query')).rejects.toThrow(/429/);
  });

  it('throws when the response body has no results array', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ search_id: 'x' }) });
    await expect(searchWeb('query')).rejects.toThrow(/results/);
  });

  it('throws on network failure', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    await expect(searchWeb('query')).rejects.toThrow('ECONNRESET');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/research/webSearch.test.ts`
Expected: FAIL — cannot find module `./webSearch`.

- [ ] **Step 3: Implement `searchWeb`**

```typescript
// src/research/webSearch.ts
export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResult {
  query: string;
  hits: WebSearchHit[];
}

const PARALLEL_SEARCH_URL = 'https://api.parallel.ai/v1beta/search';

interface RawWebSearchResult {
  url: string;
  title?: string | null;
  excerpts?: string[] | null;
}

interface RawSearchResponse {
  results?: RawWebSearchResult[];
}

export async function searchWeb(query: string): Promise<WebSearchResult> {
  const apiKey = process.env.PARALLEL_API_KEY;
  if (!apiKey) {
    throw new Error('PARALLEL_API_KEY is not set');
  }

  const response = await fetch(PARALLEL_SEARCH_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ search_queries: [query], excerpts: true }),
  });

  if (!response.ok) {
    throw new Error(`Parallel search request failed with status ${response.status}`);
  }

  const body = (await response.json()) as RawSearchResponse;
  if (!Array.isArray(body.results)) {
    throw new Error('Parallel search response missing results array');
  }

  const hits: WebSearchHit[] = body.results.map((raw) => ({
    title: raw.title ?? '(untitled)',
    url: raw.url,
    snippet: raw.excerpts && raw.excerpts.length > 0 ? raw.excerpts[0] : '',
  }));

  return { query, hits };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/research/webSearch.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/research/webSearch.ts src/research/webSearch.test.ts
git commit -m "feat(research): add Parallel.ai web search wrapper"
```

---

### Task 2: `src/research/evidenceWriter.ts` — evidence markdown staging

**Files:**
- Create: `src/research/evidenceWriter.ts`
- Test: `src/research/evidenceWriter.test.ts`

**Interfaces:**
- Consumes: `WebSearchResult` (`./webSearch`, Task 1).
- Produces (used by Task 4):
  - `export function writeEvidenceMarkdown(root: string, id: string, query: string, result: WebSearchResult): string` — returns the absolute path written. Throws `Error` if `id` fails the format check (not `/^[a-zA-Z0-9-]{1,64}$/`).

- [ ] **Step 1: Write the failing tests**

```typescript
// src/research/evidenceWriter.test.ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeEvidenceMarkdown } from './evidenceWriter';
import { WebSearchResult } from './webSearch';

describe('writeEvidenceMarkdown', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-evidence-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const sampleResult: WebSearchResult = {
    query: 'latest release of widget-lib',
    hits: [
      { title: 'Widget Lib Releases', url: 'https://example.com/releases', snippet: 'v3.2.0 was released on 2026-09-01.' },
      { title: '(untitled)', url: 'https://example.com/other', snippet: '' },
    ],
  };

  it('writes a markdown file with the query and each hit, and returns its path', () => {
    const returnedPath = writeEvidenceMarkdown(root, 'open-contradictions', 'latest release of widget-lib', sampleResult);

    expect(returnedPath).toBe(path.join(root, '_kb-sync-staging', 'trm', 'gap-open-contradictions-evidence.md'));
    const content = fs.readFileSync(returnedPath, 'utf-8');
    expect(content).toContain('latest release of widget-lib');
    expect(content).toContain('### Widget Lib Releases');
    expect(content).toContain('https://example.com/releases');
    expect(content).toContain('v3.2.0 was released on 2026-09-01.');
    expect(content).toContain('### (untitled)');
    expect(content).toContain('https://example.com/other');
  });

  it('creates the staging directory if it does not exist', () => {
    expect(fs.existsSync(path.join(root, '_kb-sync-staging'))).toBe(false);
    writeEvidenceMarkdown(root, 'gap-1', 'q', sampleResult);
    expect(fs.existsSync(path.join(root, '_kb-sync-staging', 'trm'))).toBe(true);
  });

  it('overwrites an existing file at the same path', () => {
    writeEvidenceMarkdown(root, 'gap-1', 'first query', sampleResult);
    writeEvidenceMarkdown(root, 'gap-1', 'second query', sampleResult);
    const content = fs.readFileSync(path.join(root, '_kb-sync-staging', 'trm', 'gap-gap-1-evidence.md'), 'utf-8');
    expect(content).toContain('second query');
    expect(content).not.toContain('first query');
  });

  it.each([
    ['contains a slash', 'gap/1'],
    ['contains dots', '../etc'],
    ['contains spaces', 'gap 1'],
    ['is empty', ''],
    ['exceeds 64 chars', 'a'.repeat(65)],
  ])('throws when id %s', (_desc, badId) => {
    expect(() => writeEvidenceMarkdown(root, badId, 'q', sampleResult)).toThrow(/invalid id/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/research/evidenceWriter.test.ts`
Expected: FAIL — cannot find module `./evidenceWriter`.

- [ ] **Step 3: Implement `writeEvidenceMarkdown`**

```typescript
// src/research/evidenceWriter.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WebSearchResult } from './webSearch';

const ID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;

export function writeEvidenceMarkdown(root: string, id: string, query: string, result: WebSearchResult): string {
  if (!ID_PATTERN.test(id)) {
    throw new Error(`invalid id for evidence filename: "${id}"`);
  }

  const dir = path.join(root, '_kb-sync-staging', 'trm');
  fs.mkdirSync(dir, { recursive: true });

  const lines: string[] = [`# Web search evidence: ${id}`, '', `Query: ${query}`, ''];
  for (const hit of result.hits) {
    lines.push(`### ${hit.title}`, '', hit.url, '', hit.snippet, '');
  }

  const filePath = path.join(dir, `gap-${id}-evidence.md`);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  return filePath;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/research/evidenceWriter.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/research/evidenceWriter.ts src/research/evidenceWriter.test.ts
git commit -m "feat(research): add evidence markdown staging for web search hits"
```

---

### Task 3: `src/notebooklm/registry.ts` — `web_strategy` field and `EVIDENCE_IMPORTED` status

**Prerequisite:** requires `docs/superpowers/plans/2026-09-13-notebooklm-push-research-loop.md` Task 2 (`ResearchQueueEntry`, `research_queue`, `upsertResearchQueueEntry`, `flushResearchQueueEntry`) to be implemented first. If it hasn't been, stop and implement that plan's Task 2 before starting this task.

**Files:**
- Modify: `src/notebooklm/registry.ts`
- Modify: `src/notebooklm/registry.test.ts`

**Interfaces:**
- Consumes: `ResearchQueueEntry`, `flushResearchQueueEntry` (`./registry`, from the prerequisite plan's Task 2 — modifying the same interface in place).
- Produces (used by Task 4):
  - `ResearchQueueEntry` gains `web_strategy?: 'web' | 'auto' | 'notebook'`, `imported_source?: string`, `last_updated_at?: string`.
  - `ResearchQueueEntry['status']` union gains `'EVIDENCE_IMPORTED'`.

- [ ] **Step 1: Write the failing test**

Add to `src/notebooklm/registry.test.ts` (alongside the existing `flushResearchQueueEntry` tests from the prerequisite plan):

```typescript
  it('flushResearchQueueEntry accepts web_strategy, imported_source, last_updated_at, and EVIDENCE_IMPORTED status', () => {
    upsertResearchQueueEntry(root, 'nb-1', { id: 'q1', text: 'Q' }, 'gap-1', 'fast');
    flushResearchQueueEntry(root, 'nb-1', questionHash('Q'), {
      status: 'EVIDENCE_IMPORTED',
      imported_source: 'gap-q1-evidence.md',
      last_updated_at: '2026-09-14T00:00:00.000Z',
    });

    const entry = findNotebook(readRegistry(root), 'nb-1')!.research_queue![questionHash('Q')];
    expect(entry.status).toBe('EVIDENCE_IMPORTED');
    expect(entry.imported_source).toBe('gap-q1-evidence.md');
    expect(entry.last_updated_at).toBe('2026-09-14T00:00:00.000Z');
  });

  it('upsertResearchQueueEntry accepts an optional web_strategy and defaults it to undefined', () => {
    upsertResearchQueueEntry(root, 'nb-2', { id: 'q2', text: 'Q2' }, 'gap-2', 'fast', 'web');
    const entry = findNotebook(readRegistry(root), 'nb-2')!.research_queue![questionHash('Q2')];
    expect(entry.web_strategy).toBe('web');

    upsertResearchQueueEntry(root, 'nb-3', { id: 'q3', text: 'Q3' }, 'gap-3', 'fast');
    const entryNoStrategy = findNotebook(readRegistry(root), 'nb-3')!.research_queue![questionHash('Q3')];
    expect(entryNoStrategy.web_strategy).toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/notebooklm/registry.test.ts`
Expected: FAIL — TypeScript error, `web_strategy`/`imported_source`/`last_updated_at` not on `ResearchQueueEntry`, `'EVIDENCE_IMPORTED'` not assignable to `status`.

- [ ] **Step 3: Extend `ResearchQueueEntry` and `upsertResearchQueueEntry`**

In `src/notebooklm/registry.ts`, locate the `ResearchQueueEntry` interface (added by the prerequisite plan's Task 2) and change its `status` field and add the three new fields:

```typescript
export interface ResearchQueueEntry {
  question_hash: string;
  question_text: string;
  question_id: string;
  gap_key: string;
  mode: 'fast' | 'deep';
  web_strategy?: 'web' | 'auto' | 'notebook';
  attempt_count: number;
  consecutive_dispatch_failures: number;
  last_researched_at: string | null;
  last_dispatch_error: string | null;
  status: 'PENDING' | 'EXECUTED' | 'STALLED_NEEDS_HUMAN' | 'INFRASTRUCTURE_BLOCKED' | 'EVIDENCE_IMPORTED';
  imported_source?: string;
  last_updated_at?: string;
}
```

Locate `upsertResearchQueueEntry` and add an optional fifth parameter:

```typescript
export function upsertResearchQueueEntry(
  root: string,
  notebookId: string,
  question: { id: string; text: string },
  gapKey: string,
  mode: 'fast' | 'deep',
  webStrategy?: 'web' | 'auto' | 'notebook'
): void {
  // existing body: find or create the entry as today, then when constructing
  // a new entry, include `web_strategy: webStrategy` in the object literal.
}
```

Locate the object literal inside `upsertResearchQueueEntry` that builds a new `ResearchQueueEntry` (created when no existing entry is found for the question hash) and add `web_strategy: webStrategy` to it.

`flushResearchQueueEntry` takes `Partial<ResearchQueueEntry>` already — no change needed there, the new optional fields flow through automatically.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/notebooklm/registry.test.ts`
Expected: PASS, including all prerequisite-plan tests still passing (Task 2's tests plus the two new ones above).

- [ ] **Step 5: Commit**

```bash
git add src/notebooklm/registry.ts src/notebooklm/registry.test.ts
git commit -m "feat(notebooklm): add web_strategy and EVIDENCE_IMPORTED to research queue entries"
```

---

### Task 4: `src/cli/commands/researchNotebooklm.ts` — wire in bypass and last-resort fallback

**Prerequisite:** requires `docs/superpowers/plans/2026-09-13-notebooklm-push-research-loop.md` Tasks 4 and 6 (`isUrgentAnswer`, `appendStalledTodo` in `mineNotebooklm.ts`; `dispatchCandidate`, `recordSuccess`, `recordTransientFailure`, `runResearchNotebooklm` in `researchNotebooklm.ts`) to be implemented first, and this plan's Task 3 (registry fields).

**Files:**
- Modify: `src/cli/commands/researchNotebooklm.ts`
- Modify: `src/cli/commands/researchNotebooklm.test.ts`

**Interfaces:**
- Consumes: `searchWeb` (`../../research/webSearch`, Task 1), `writeEvidenceMarkdown` (`../../research/evidenceWriter`, Task 2), `flushResearchQueueEntry` (`../../notebooklm/registry`, Task 3 + prerequisite plan Task 2), `isUrgentAnswer`, `appendStalledTodo` (`./mineNotebooklm`, prerequisite plan Task 4), the existing `dispatchCandidate`/`recordSuccess`/`recordTransientFailure`/`DispatchCandidate` from the prerequisite plan's Task 6 (same file).
- Produces: no new exports — this task changes the internal control flow of `dispatchCandidate`/`recordSuccess` only. `ResearchNotebooklmResult` (prerequisite plan's Task 6 export) is unchanged in shape.

- [ ] **Step 1: Write the failing tests**

Add to `src/cli/commands/researchNotebooklm.test.ts` (same file as the prerequisite plan's Task 6 tests; add these imports alongside the existing ones: `import * as webSearch from '../../research/webSearch'; import * as evidenceWriter from '../../research/evidenceWriter'; jest.mock('../../research/webSearch'); jest.mock('../../research/evidenceWriter');`):

```typescript
describe('runResearchNotebooklm — web search fallback', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-nlmresearch-web-'));
    fs.writeFileSync(
      path.join(root, 'config.json'),
      JSON.stringify({ default_scoring_adapter: 'stub', promotion_threshold: 80, actor_source: 'env', time_source: 'system' })
    );
    fs.writeFileSync(path.join(root, 'TODOS.md'), '# TODOS\n\n## Open\n\n## Completed\n');
    jest.resetAllMocks();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('web_strategy "web" bypasses nlm research and calls searchWeb directly', () => {
    seedRunRegistry(root, baseEntry({ web_strategy: 'web' }));
    (webSearch.searchWeb as jest.Mock).mockResolvedValue({
      query: 'q',
      hits: [{ title: 'T', url: 'https://x', snippet: 'S' }],
    });
    (evidenceWriter.writeEvidenceMarkdown as jest.Mock).mockReturnValue('/tmp/evidence.md');
    (nlmCli.addSource as jest.Mock).mockReturnValue({ ok: true, data: undefined });

    runResearchNotebooklm(root, 'nb-1', { forceResearch: false });

    expect(nlmResearch.researchStart).not.toHaveBeenCalled();
    expect(webSearch.searchWeb).toHaveBeenCalledWith('What open questions or unresolved contradictions exist across these sources?');
    const entry = findNotebook(readRegistry(root), 'nb-1')!.research_queue![baseEntry().question_hash];
    expect(entry.status).toBe('EVIDENCE_IMPORTED');
    expect(entry.imported_source).toBe('/tmp/evidence.md');
  });

  it('web_strategy "auto" below stall threshold never calls searchWeb', () => {
    seedRunRegistry(root, baseEntry({ web_strategy: 'auto', attempt_count: 0 }));
    (nlmResearch.researchStart as jest.Mock).mockReturnValue({ ok: true, data: { taskId: 'rt-1' } });
    (nlmResearch.researchStatus as jest.Mock).mockReturnValue({ ok: true, data: { completed: true } });
    (nlmResearch.researchImport as jest.Mock).mockReturnValue({ ok: true, data: undefined });
    (nlmCli.queryNotebook as jest.Mock).mockReturnValue({ ok: true, data: 'Still no source found for this.' });

    runResearchNotebooklm(root, 'nb-1', { forceResearch: false });

    expect(webSearch.searchWeb).not.toHaveBeenCalled();
    const entry = findNotebook(readRegistry(root), 'nb-1')!.research_queue![baseEntry().question_hash];
    expect(entry.status).toBe('PENDING');
  });

  it('web_strategy "auto" at stall threshold falls back to web search instead of stalling immediately', () => {
    seedRunRegistry(root, baseEntry({ web_strategy: 'auto', attempt_count: 2 })); // default max_attempts_before_stall is 3
    (nlmResearch.researchStart as jest.Mock).mockReturnValue({ ok: true, data: { taskId: 'rt-1' } });
    (nlmResearch.researchStatus as jest.Mock).mockReturnValue({ ok: true, data: { completed: true } });
    (nlmResearch.researchImport as jest.Mock).mockReturnValue({ ok: true, data: undefined });
    (nlmCli.queryNotebook as jest.Mock).mockReturnValue({ ok: true, data: 'Still no source found for this.' });
    (webSearch.searchWeb as jest.Mock).mockResolvedValue({ query: 'q', hits: [{ title: 'T', url: 'https://x', snippet: 'S' }] });
    (evidenceWriter.writeEvidenceMarkdown as jest.Mock).mockReturnValue('/tmp/evidence.md');
    (nlmCli.addSource as jest.Mock).mockReturnValue({ ok: true, data: undefined });

    runResearchNotebooklm(root, 'nb-1', { forceResearch: false });

    expect(webSearch.searchWeb).toHaveBeenCalledTimes(1);
    const entry = findNotebook(readRegistry(root), 'nb-1')!.research_queue![baseEntry().question_hash];
    expect(entry.status).toBe('EVIDENCE_IMPORTED');
    const todos = fs.readFileSync(path.join(root, 'TODOS.md'), 'utf-8');
    expect(todos).not.toContain('[STALLED]');
  });

  it('web_strategy "notebook" never calls searchWeb even at the stall point', () => {
    seedRunRegistry(root, baseEntry({ web_strategy: 'notebook', attempt_count: 2 }));
    (nlmResearch.researchStart as jest.Mock).mockReturnValue({ ok: true, data: { taskId: 'rt-1' } });
    (nlmResearch.researchStatus as jest.Mock).mockReturnValue({ ok: true, data: { completed: true } });
    (nlmResearch.researchImport as jest.Mock).mockReturnValue({ ok: true, data: undefined });
    (nlmCli.queryNotebook as jest.Mock).mockReturnValue({ ok: true, data: 'Still no source found for this.' });

    runResearchNotebooklm(root, 'nb-1', { forceResearch: false });

    expect(webSearch.searchWeb).not.toHaveBeenCalled();
    const entry = findNotebook(readRegistry(root), 'nb-1')!.research_queue![baseEntry().question_hash];
    expect(entry.status).toBe('STALLED_NEEDS_HUMAN');
  });

  it('a failed web fallback at the stall point falls through to STALLED_NEEDS_HUMAN', () => {
    seedRunRegistry(root, baseEntry({ web_strategy: 'auto', attempt_count: 2 }));
    (nlmResearch.researchStart as jest.Mock).mockReturnValue({ ok: true, data: { taskId: 'rt-1' } });
    (nlmResearch.researchStatus as jest.Mock).mockReturnValue({ ok: true, data: { completed: true } });
    (nlmResearch.researchImport as jest.Mock).mockReturnValue({ ok: true, data: undefined });
    (nlmCli.queryNotebook as jest.Mock).mockReturnValue({ ok: true, data: 'Still no source found for this.' });
    (webSearch.searchWeb as jest.Mock).mockRejectedValue(new Error('Parallel search request failed with status 500'));

    runResearchNotebooklm(root, 'nb-1', { forceResearch: false });

    const entry = findNotebook(readRegistry(root), 'nb-1')!.research_queue![baseEntry().question_hash];
    expect(entry.status).toBe('STALLED_NEEDS_HUMAN');
    const todos = fs.readFileSync(path.join(root, 'TODOS.md'), 'utf-8');
    expect(todos).toContain('[STALLED]');
  });

  it('a failed web_strategy "web" dispatch (searchWeb throws) is treated as a transient failure, not a stall', () => {
    seedRunRegistry(root, baseEntry({ web_strategy: 'web', consecutive_dispatch_failures: 0 }));
    (webSearch.searchWeb as jest.Mock).mockRejectedValue(new Error('Parallel search request failed with status 500'));

    runResearchNotebooklm(root, 'nb-1', { forceResearch: false });

    const entry = findNotebook(readRegistry(root), 'nb-1')!.research_queue![baseEntry().question_hash];
    expect(entry.status).toBe('PENDING');
    expect(entry.consecutive_dispatch_failures).toBe(1);
    expect(nlmResearch.researchStart).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/cli/commands/researchNotebooklm.test.ts`
Expected: FAIL — `web_strategy` bypass not implemented, `searchWeb` never called, `nlmCli.addSource` doesn't exist yet.

- [ ] **Step 3: Add `addSource` to the `nlmCli` wrapper**

Check `src/notebooklm/nlmCli.ts` for its existing wrapper pattern (functions like `queryNotebook` that shell out to `nlm` and return `{ ok: true, data } | { ok: false, error }`). Add a sibling function:

```typescript
// src/notebooklm/nlmCli.ts — add alongside the existing queryNotebook function
export function addSource(
  notebookId: string,
  filePath: string,
  title: string
): { ok: true; data: undefined } | { ok: false; error: string } {
  const result = runNlm(['source', 'add', notebookId, '--file', filePath, '--title', title, '--wait']);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return { ok: true, data: undefined };
}
```

(Match the exact shape of `runNlm`'s return type and the existing `queryNotebook` implementation already in this file — if `runNlm` doesn't return an `{ ok, error }` shape, adapt `addSource` to whatever process-exit-code/stderr check the existing functions in this file already use, keeping the same `{ ok: true, data } | { ok: false, error }` return contract for callers.)

- [ ] **Step 4: Implement the bypass and last-resort fallback in `researchNotebooklm.ts`**

Add the imports:

```typescript
import { searchWeb } from '../../research/webSearch';
import { writeEvidenceMarkdown } from '../../research/evidenceWriter';
import { addSource } from '../../notebooklm/nlmCli';
```

Add a helper that runs the web fallback and returns the resulting status:

```typescript
async function runWebFallback(
  root: string,
  notebookId: string,
  entry: ResearchQueueEntry,
  nowIso: string
): Promise<'EVIDENCE_IMPORTED' | 'FAILED'> {
  try {
    const result = await searchWeb(entry.question_text);
    if (result.hits.length === 0) {
      throw new Error('Parallel search returned zero hits');
    }
    const evidencePath = writeEvidenceMarkdown(root, entry.question_id, entry.question_text, result);
    const uploadResult = addSource(notebookId, evidencePath, `TRM Evidence: ${entry.question_id}`);
    if (!uploadResult.ok) {
      throw new Error(uploadResult.error);
    }
    flushResearchQueueEntry(root, notebookId, entry.question_hash, {
      status: 'EVIDENCE_IMPORTED',
      imported_source: evidencePath,
      last_updated_at: nowIso,
      consecutive_dispatch_failures: 0,
      last_dispatch_error: null,
    });
    return 'EVIDENCE_IMPORTED';
  } catch (err) {
    return 'FAILED';
  }
}
```

Modify `dispatchCandidate` (the existing function from the prerequisite plan's Task 6) at its start to add the bypass branch:

```typescript
async function dispatchCandidate(
  root: string,
  candidate: DispatchCandidate,
  limits: DispatchLimits,
  forceResearch: boolean,
  nowIso: string
): Promise<'succeeded' | 'transientFailure' | 'stalled' | 'infrastructureBlocked'> {
  const { notebookId, entry } = candidate;

  if (entry.web_strategy === 'web') {
    const outcome = await runWebFallback(root, notebookId, entry, nowIso);
    if (outcome === 'EVIDENCE_IMPORTED') {
      return 'succeeded';
    }
    return recordTransientFailure(root, notebookId, entry, limits, 'web search fallback failed') === 'INFRASTRUCTURE_BLOCKED'
      ? 'infrastructureBlocked'
      : 'transientFailure';
  }

  const startResult = researchStart(notebookId, entry.question_text, entry.mode, forceResearch);
  // ... rest of the existing function body from the prerequisite plan's Task 6, unchanged.
}
```

Modify `recordSuccess` (the existing function from the prerequisite plan's Task 6) to insert the last-resort branch where it currently transitions to `STALLED_NEEDS_HUMAN`:

```typescript
async function recordSuccess(
  root: string,
  notebookId: string,
  entry: ResearchQueueEntry,
  limits: DispatchLimits,
  nowIso: string
): Promise<'EXECUTED' | 'PENDING' | 'STALLED_NEEDS_HUMAN' | 'EVIDENCE_IMPORTED'> {
  const attemptCount = entry.attempt_count + 1;
  const requery = queryNotebook(notebookId, entry.question_text);
  const stillUrgent = requery.ok ? isUrgentAnswer(requery.data) : true;

  if (!stillUrgent) {
    flushResearchQueueEntry(root, notebookId, entry.question_hash, {
      attempt_count: attemptCount,
      last_researched_at: nowIso,
      consecutive_dispatch_failures: 0,
      last_dispatch_error: null,
      status: 'EXECUTED',
    });
    return 'EXECUTED';
  }

  if (attemptCount < limits.max_attempts_before_stall || entry.web_strategy === 'notebook') {
    flushResearchQueueEntry(root, notebookId, entry.question_hash, {
      attempt_count: attemptCount,
      last_researched_at: nowIso,
      consecutive_dispatch_failures: 0,
      last_dispatch_error: null,
      status: 'PENDING',
    });
    return 'PENDING';
  }

  // Last resort: about to stall, try the web fallback first.
  const fallbackEntry = { ...entry, attempt_count: attemptCount };
  const fallbackOutcome = await runWebFallback(root, notebookId, fallbackEntry, nowIso);
  if (fallbackOutcome === 'EVIDENCE_IMPORTED') {
    return 'EVIDENCE_IMPORTED';
  }

  appendStalledTodo(root, entry.question_text, entry.gap_key);
  flushResearchQueueEntry(root, notebookId, entry.question_hash, {
    attempt_count: attemptCount,
    last_researched_at: nowIso,
    consecutive_dispatch_failures: 0,
    last_dispatch_error: null,
    status: 'STALLED_NEEDS_HUMAN',
  });
  return 'STALLED_NEEDS_HUMAN';
}
```

**Note:** `dispatchCandidate` and `recordSuccess` are now `async` — the existing plan's Task 6 defined them as synchronous. Update `runResearchNotebooklm` (the exported entry point) and its call site to `await` the results, and update its own signature to `Promise<ResearchNotebooklmResult>` if it isn't already. Check every call site of these two functions in the file and add `await`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/cli/commands/researchNotebooklm.test.ts`
Expected: PASS — all prerequisite-plan Task 6 tests plus the six new tests above.

- [ ] **Step 6: Commit**

```bash
git add src/notebooklm/nlmCli.ts src/cli/commands/researchNotebooklm.ts src/cli/commands/researchNotebooklm.test.ts
git commit -m "feat(research): wire Parallel web search bypass and last-resort fallback into research dispatch"
```

---

## Self-Review Notes

- Spec coverage: wire contract (Task 1), evidence staging (Task 2), registry fields (Task 3), bypass + last-resort fallback + error routing (Task 4) all covered. Sub-project B (research consultant) explicitly out of scope, not a task here.
- Type consistency checked: `WebSearchResult`/`WebSearchHit` (Task 1) match usage in Task 4's mocks; `writeEvidenceMarkdown`'s signature (`root, id, query, result`) matches its Task 4 call site; `addSource`'s `{ ok, data | error }` return shape matches the existing `nlmCli.ts` convention used elsewhere in Task 4.
- Task 4's `async` conversion of `dispatchCandidate`/`recordSuccess` is called out explicitly as a required change to the prerequisite plan's existing (synchronous) implementation, not silently assumed.
