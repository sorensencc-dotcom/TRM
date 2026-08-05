# route-intake Topic Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `trm route-intake`, which classifies triaged intake files to a likely vault topic by filename/path keyword matching, reports the result, and (with `--apply`) stages matched files per-topic for a later manual `ingest-dir` pass — all per the fully-reviewed spec.

**Architecture:** A pure classification module (`src/core/topicRouting.ts`: config load/validate, normalization, matching, precedence) consumed by an orchestration command (`src/cli/commands/routeIntake.ts`: manifest reading, dupPath expansion, path-safety checks, dry-run/apply branching, locking, staging, report writing). A new `copyFileAtomic` primitive in the existing `src/core/atomicWrite.ts` gives staging copies the same temp-then-rename safety the repo already uses for JSON writes.

**Tech Stack:** TypeScript, Jest, Node `fs`/`crypto`/`path`, the existing `src/sync/lock.ts` lock primitive, the existing `src/core/intakeManifest.ts` and `src/core/topicNode.ts` modules.

## Global Constraints

- Routing operates per **physical path** (`sourcePath` + every `dupPaths` entry), never per manifest record — duplicates must not be silently dropped.
- Every manifest path is resolved as `path.resolve(root, sourcePath)`; a path that resolves outside `root` (or is already absolute) throws before classification, mirroring `triageIntake.ts`'s `resolveWalkDir` boundary check.
- Keyword matching: normalize (lowercase; `_`, `-`, `/`, `\` → space; collapse whitespace) both path and keyword, then match on a `\b`-bounded substring. Precedence: longest matching keyword (token count, then char length) wins across all topics; a same-topic multi-keyword match is not a conflict; a cross-topic tie is `unsorted` + `ambiguous: true`.
- Config (`config/topic-routing.json`) is validated at load time: object top level; slugs matching `^[a-z0-9-]+$`; non-empty keyword arrays of non-empty strings; no two keywords colliding under different topics **after normalization**. Any violation throws before the manifest is read.
- `matchedKeyword` in the report is the keyword exactly as written in the config (not normalized).
- `--apply` aborts *before* staging anything if any matched topic lacks `topics/charlie/<topic>/topic.json` — but this still produces a report (`applied: false`, `runStatus: 'preflight-failed'`, `error` naming the missing topics, `entries` showing the completed classification).
- `--apply` acquires `intake-routing.lock` (vault root) via the existing `acquireLock`/`releaseLock`, released in a `finally`. A crash inside the lock-held region still produces a best-effort report (`runStatus: 'failed'`) before re-throwing.
- Staging copies use `copyFileAtomic` (temp file in the destination dir, then rename) — never a bare `fs.copyFileSync` straight to the final name.
- `runId` format: `<YYYYMMDD>-<8-char hex>` (from `crypto.randomUUID().replace(/-/g, '').slice(0, 8)`, matching the repo's existing `crypto.randomUUID()` convention for run identifiers, e.g. `syncTreatment.ts`). Test-injectable via `opts.runId`.
- Report is written exactly once per run, after every entry has reached a terminal status — never incrementally, never before an abort/crash path has determined the correct `runStatus`.

Spec: `docs/superpowers/specs/2026-08-05-route-intake-topic-classification-design.md`

---

### Task 1: `copyFileAtomic` primitive

**Files:**
- Modify: `src/core/atomicWrite.ts`
- Test: `tests/core/atomicWrite.test.ts`

**Interfaces:**
- Produces: `export function copyFileAtomic(srcPath: string, destPath: string): void` — copies `srcPath`'s bytes to `destPath` via a temp file in `destPath`'s directory, then renames. Creates `destPath`'s parent directory if needed (matches `writeFileAtomic`'s existing `mkdirSync(..., { recursive: true })` behavior).

- [ ] **Step 1: Write the failing tests**

Add to `tests/core/atomicWrite.test.ts`, inside the existing `describe('atomicWrite', ...)` block (update the import line first):

```ts
import { writeFileAtomic, writeFileExclusive, copyFileAtomic } from '../../src/core/atomicWrite';
```

```ts
  it('copyFileAtomic copies file contents and creates parent dirs', () => {
    const src = path.join(dir, 'source.bin');
    fs.writeFileSync(src, Buffer.from([1, 2, 3, 4]));
    const dest = path.join(dir, 'nested', 'dest.bin');

    copyFileAtomic(src, dest);

    expect(fs.readFileSync(dest)).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('copyFileAtomic leaves no temp file behind on success', () => {
    const src = path.join(dir, 'source.bin');
    fs.writeFileSync(src, 'hello');
    const dest = path.join(dir, 'dest.bin');

    copyFileAtomic(src, dest);

    const entries = fs.readdirSync(dir);
    expect(entries.sort()).toEqual(['dest.bin', 'source.bin']);
  });

  it('copyFileAtomic never leaves a partial file at the destination name when the copy throws', () => {
    const src = path.join(dir, 'source.bin');
    fs.writeFileSync(src, 'hello');
    const dest = path.join(dir, 'dest.bin');
    const copySpy = jest.spyOn(fs, 'copyFileSync').mockImplementation(() => {
      throw new Error('simulated disk-full mid-copy');
    });

    try {
      expect(() => copyFileAtomic(src, dest)).toThrow('simulated disk-full mid-copy');
      expect(fs.existsSync(dest)).toBe(false);
    } finally {
      copySpy.mockRestore();
    }
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/core/atomicWrite.test.ts -t copyFileAtomic`
Expected: FAIL — `copyFileAtomic` is not exported from `src/core/atomicWrite`.

- [ ] **Step 3: Implement `copyFileAtomic`**

In `src/core/atomicWrite.ts`, add after `writeFileExclusive`:

```ts
export function copyFileAtomic(srcPath: string, destPath: string): void {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmp = tempPathFor(destPath);
  fs.copyFileSync(srcPath, tmp);
  fs.renameSync(tmp, destPath);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/core/atomicWrite.test.ts`
Expected: PASS, all tests including the 3 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/core/atomicWrite.ts tests/core/atomicWrite.test.ts
git commit -m "feat(trm): add copyFileAtomic for safe staged-file copies"
```

---

### Task 2: Topic-routing config + matching module

**Files:**
- Create: `src/core/topicRouting.ts`
- Create: `config/topic-routing.json`
- Test: `tests/core/topicRouting.test.ts`

**Interfaces:**
- Produces:
  - `export interface TopicRoutingConfig { [topicSlug: string]: string[] }`
  - `export function loadTopicRoutingConfig(configPath: string): TopicRoutingConfig` — reads, parses, and validates; throws on any schema violation (see Global Constraints).
  - `export interface MatchResult { topic: string; matchedKeyword: string }`
  - `export function classifyPath(normalizedInputPath: string, config: TopicRoutingConfig): { result: MatchResult | null; ambiguous: boolean }` — `result: null` with `ambiguous: false` means no match (`unsorted`, not ambiguous); `result: null` with `ambiguous: true` means a cross-topic tie (`unsorted`, ambiguous); `result` set means exactly one topic won.
  - `export function normalize(text: string): string` — exported for the command module to normalize a `sourcePath` before calling `classifyPath` (also used internally for keywords).
- Consumes: nothing outside Node built-ins.

- [ ] **Step 1: Write the failing tests**

Create `tests/core/topicRouting.test.ts`:

```ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadTopicRoutingConfig, classifyPath, normalize } from '../../src/core/topicRouting';

function writeConfig(dir: string, contents: unknown): string {
  const file = path.join(dir, 'topic-routing.json');
  fs.writeFileSync(file, JSON.stringify(contents));
  return file;
}

describe('topicRouting', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-topicrouting-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('normalize', () => {
    it('lowercases, collapses separators to spaces, and collapses whitespace', () => {
      expect(normalize('Documents/Michigan_Flight-Museum  Scans')).toBe('documents michigan flight museum scans');
    });
  });

  describe('loadTopicRoutingConfig validation', () => {
    it('loads a valid config', () => {
      const file = writeConfig(dir, { 'willow-run': ['willow run'] });
      expect(loadTopicRoutingConfig(file)).toEqual({ 'willow-run': ['willow run'] });
    });

    it('throws if the top level is not an object', () => {
      const file = writeConfig(dir, ['not', 'an', 'object']);
      expect(() => loadTopicRoutingConfig(file)).toThrow(/object/i);
    });

    it('throws on a topic slug that fails ^[a-z0-9-]+$', () => {
      const file = writeConfig(dir, { 'Willow Run': ['willow run'] });
      expect(() => loadTopicRoutingConfig(file)).toThrow(/slug/i);
    });

    it('throws on a path-traversal topic slug', () => {
      const file = writeConfig(dir, { '../evil': ['x'] });
      expect(() => loadTopicRoutingConfig(file)).toThrow(/slug/i);
    });

    it('throws on an empty keyword array', () => {
      const file = writeConfig(dir, { cuba: [] });
      expect(() => loadTopicRoutingConfig(file)).toThrow(/keyword/i);
    });

    it('throws on an empty-string keyword', () => {
      const file = writeConfig(dir, { cuba: [''] });
      expect(() => loadTopicRoutingConfig(file)).toThrow(/keyword/i);
    });

    it('throws on keywords colliding across topics only after normalization', () => {
      const file = writeConfig(dir, {
        'michigan-flight-museum': ['michigan-flight-museum'],
        'other-topic': ['Michigan Flight Museum'],
      });
      expect(() => loadTopicRoutingConfig(file)).toThrow(/collide|duplicate/i);
    });

    it('throws a clear error for a missing config file', () => {
      expect(() => loadTopicRoutingConfig(path.join(dir, 'nope.json'))).toThrow(/nope\.json/);
    });

    it('throws a clear error for malformed JSON', () => {
      const file = path.join(dir, 'bad.json');
      fs.writeFileSync(file, '{ not json');
      expect(() => loadTopicRoutingConfig(file)).toThrow();
    });
  });

  describe('classifyPath', () => {
    const config = {
      helene: ['helene'],
      'helene-i': ['helene i', 'helene 1'],
      'michigan-flight-museum': ['michigan flight museum', 'mfm'],
      cuba: ['cuba'],
    };

    it('matches a single unambiguous keyword', () => {
      const { result, ambiguous } = classifyPath(normalize('intake/dump/Cuba Trip/photo1.jpg'), config);
      expect(result).toEqual({ topic: 'cuba', matchedKeyword: 'cuba' });
      expect(ambiguous).toBe(false);
    });

    it('returns no match (not ambiguous) when nothing matches', () => {
      const { result, ambiguous } = classifyPath(normalize('intake/dump/Downloads/random.pdf'), config);
      expect(result).toBeNull();
      expect(ambiguous).toBe(false);
    });

    it('resolves helene vs helene-i by longest-keyword precedence', () => {
      const { result, ambiguous } = classifyPath(normalize('intake/dump/Helene I photos/scan.jpg'), config);
      expect(result).toEqual({ topic: 'helene-i', matchedKeyword: 'helene 1' });
      expect(ambiguous).toBe(false);
    });

    it('does not treat multiple same-topic keyword matches as ambiguous', () => {
      const multiKeywordConfig = { 'willys-overland': ['willys', 'jeep'] };
      const { result, ambiguous } = classifyPath(normalize('intake/dump/Willys Jeep Ads/ad1.jpg'), multiKeywordConfig);
      expect(result).toEqual({ topic: 'willys-overland', matchedKeyword: expect.any(String) });
      expect(ambiguous).toBe(false);
    });

    it('flags a genuine cross-topic tie as ambiguous with no result', () => {
      const tieConfig = { 'topic-a': ['shared term'], 'topic-b': ['shared term'] };
      const { result, ambiguous } = classifyPath(normalize('intake/dump/Shared Term/file.jpg'), tieConfig);
      expect(result).toBeNull();
      expect(ambiguous).toBe(true);
    });

    it('does not match a keyword as a substring of an unrelated word', () => {
      const { result } = classifyPath(normalize('intake/dump/Incubator Reports/file.pdf'), config);
      expect(result).toBeNull(); // "cuba" must not match inside "incubator"
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/core/topicRouting.test.ts`
Expected: FAIL — `src/core/topicRouting` does not exist yet.

- [ ] **Step 3: Implement `src/core/topicRouting.ts`**

```ts
import * as fs from 'node:fs';

export interface TopicRoutingConfig {
  [topicSlug: string]: string[];
}

export interface MatchResult {
  topic: string;
  matchedKeyword: string;
}

const SLUG_PATTERN = /^[a-z0-9-]+$/;

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[_\-/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function loadTopicRoutingConfig(configPath: string): TopicRoutingConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`topic-routing config not found at "${configPath}"`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (err) {
    throw new Error(`topic-routing config at "${configPath}" is not valid JSON: ${(err as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`topic-routing config at "${configPath}" must be a JSON object mapping topic slug -> keyword array`);
  }

  const config = parsed as Record<string, unknown>;
  const normalizedKeywordOwners = new Map<string, string>(); // normalized keyword -> topic that first claimed it

  for (const [slug, value] of Object.entries(config)) {
    if (!SLUG_PATTERN.test(slug)) {
      throw new Error(`topic-routing config: invalid topic slug "${slug}" (must match ${SLUG_PATTERN})`);
    }
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error(`topic-routing config: topic "${slug}" must have a non-empty keyword array`);
    }
    for (const keyword of value) {
      if (typeof keyword !== 'string' || keyword.trim().length === 0) {
        throw new Error(`topic-routing config: topic "${slug}" has an empty or non-string keyword`);
      }
      const normalizedKeyword = normalize(keyword);
      const owner = normalizedKeywordOwners.get(normalizedKeyword);
      if (owner && owner !== slug) {
        throw new Error(
          `topic-routing config: keyword "${keyword}" (normalized: "${normalizedKeyword}") collides between topics "${owner}" and "${slug}"`
        );
      }
      normalizedKeywordOwners.set(normalizedKeyword, slug);
    }
  }

  return config as TopicRoutingConfig;
}

function wordBoundaryIncludes(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(haystack);
}

export function classifyPath(
  normalizedInputPath: string,
  config: TopicRoutingConfig
): { result: MatchResult | null; ambiguous: boolean } {
  let best: { topic: string; keyword: string; tokenCount: number; length: number }[] = [];

  for (const [topic, keywords] of Object.entries(config)) {
    let topicBest: { keyword: string; tokenCount: number; length: number } | null = null;
    for (const keyword of keywords) {
      const normalizedKeyword = normalize(keyword);
      if (!wordBoundaryIncludes(normalizedInputPath, normalizedKeyword)) continue;
      const tokenCount = normalizedKeyword.split(' ').length;
      const length = normalizedKeyword.length;
      if (!topicBest || tokenCount > topicBest.tokenCount || (tokenCount === topicBest.tokenCount && length > topicBest.length)) {
        topicBest = { keyword, tokenCount, length };
      }
    }
    if (topicBest) best.push({ topic, ...topicBest });
  }

  if (best.length === 0) return { result: null, ambiguous: false };

  const maxTokenCount = Math.max(...best.map((b) => b.tokenCount));
  best = best.filter((b) => b.tokenCount === maxTokenCount);
  const maxLength = Math.max(...best.map((b) => b.length));
  best = best.filter((b) => b.length === maxLength);

  if (best.length > 1) return { result: null, ambiguous: true };

  return { result: { topic: best[0].topic, matchedKeyword: best[0].keyword }, ambiguous: false };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/core/topicRouting.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Create the seed config**

Create `config/topic-routing.json`:

```json
{
  "benson-ford": ["benson ford"],
  "cuba": ["cuba"],
  "helene": ["helene"],
  "helene-i": ["helene i", "helene 1", "first helene"],
  "michigan-flight-museum": ["michigan flight museum", "mfm"],
  "willow-run": ["willow run"],
  "willys-overland": ["willys", "willys-overland", "willys overland", "jeep"]
}
```

- [ ] **Step 6: Verify the seed config loads cleanly**

Run: `node -e "console.log(require('./src/core/topicRouting').loadTopicRoutingConfig('config/topic-routing.json'))"` after building, or add a one-off assertion in the test file temporarily and remove it — either way, confirm no validation error against the real seed file (this catches a collision like `helene` vs `helene-i`'s `helene 1` keyword, which do NOT collide since they normalize to different strings, but is worth a real check since it's the actual shipped config).

Expected: prints the config object, no throw.

- [ ] **Step 7: Commit**

```bash
git add src/core/topicRouting.ts config/topic-routing.json tests/core/topicRouting.test.ts
git commit -m "feat(trm): add topic-routing config loader and keyword matcher"
```

---

### Task 3: `route-intake` dry-run path

**Files:**
- Create: `src/cli/commands/routeIntake.ts`
- Test: `tests/cli/commands/routeIntake.test.ts`

**Interfaces:**
- Consumes: `loadTopicRoutingConfig`, `classifyPath`, `normalize` from `../../core/topicRouting` (Task 2); `readIntakeManifest` from `../../core/intakeManifest`; `writeFileAtomic` from `../../core/atomicWrite`.
- Produces:
  ```ts
  export type RouteEntryStatus = 'staged' | 'unsorted' | 'missing' | 'failed' | 'would-stage';
  export type RouteRunStatus = 'completed' | 'preflight-failed' | 'failed';

  export interface RouteReportEntry {
    sourcePath: string;
    hash: string;
    topic: string | null;
    matchedKeyword: string | null;
    ambiguous: boolean;
    status: RouteEntryStatus;
    stagedPath?: string;
    error?: string;
  }

  export interface RouteIntakeReport {
    reportVersion: 1;
    generatedAt: string;
    applied: boolean;
    runStatus: RouteRunStatus;
    runId: string;
    totalConsidered: number;
    byTopic: Record<string, number>;
    ambiguousCount: number;
    entries: RouteReportEntry[];
    error?: string;
  }

  export interface RouteIntakeOptions {
    apply?: boolean;
    configPath?: string;
    runId?: string;
  }

  export type RouteIntakeSummary = Pick<
    RouteIntakeReport,
    'totalConsidered' | 'byTopic' | 'ambiguousCount' | 'runStatus'
  >;

  export async function runRouteIntake(root: string, opts: RouteIntakeOptions): Promise<RouteIntakeSummary>
  ```
  This task implements only the dry-run path (`opts.apply` falsy); Task 4 adds `--apply`.

- [ ] **Step 1: Write the failing tests (dry-run behaviors)**

Create `tests/cli/commands/routeIntake.test.ts`:

```ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runRouteIntake } from '../../../src/cli/commands/routeIntake';
import { openIntakeManifest, IntakeEntry } from '../../../src/core/intakeManifest';

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trm-routeintake-'));
}

function writeConfig(root: string, contents: unknown): string {
  const dir = path.join(root, 'config');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'topic-routing.json');
  fs.writeFileSync(file, JSON.stringify(contents));
  return file;
}

function writeManifestEntry(root: string, entry: Partial<IntakeEntry> & { hash: string; sourcePath: string }): void {
  const session = openIntakeManifest(root);
  session.write({
    batch: 'dump',
    ext: path.extname(entry.sourcePath),
    sizeBytes: 100,
    kind: 'text',
    classifiedType: 'text',
    isDup: false,
    status: 'done',
    classifiedAt: new Date().toISOString(),
    ...entry,
  } as IntakeEntry);
  session.flush();
}

const CONFIG = {
  cuba: ['cuba'],
  'willow-run': ['willow run'],
};

describe('runRouteIntake (dry-run)', () => {
  it('classifies a single unambiguous match and writes a would-stage report entry', async () => {
    const root = makeRoot();
    writeConfig(root, CONFIG);
    writeManifestEntry(root, { hash: 'h1', sourcePath: 'intake/dump/Cuba Trip/photo1.jpg' });

    const summary = await runRouteIntake(root, {});

    expect(summary.runStatus).toBe('completed');
    expect(summary.byTopic.cuba).toBe(1);
    const report = JSON.parse(fs.readFileSync(path.join(root, 'intake-routing-report.json'), 'utf-8'));
    expect(report.applied).toBe(false);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]).toMatchObject({ topic: 'cuba', status: 'would-stage', ambiguous: false });
    // dry-run never touches topics/
    expect(fs.existsSync(path.join(root, 'topics'))).toBe(false);
  });

  it('reports no match as unsorted, not ambiguous', async () => {
    const root = makeRoot();
    writeConfig(root, CONFIG);
    writeManifestEntry(root, { hash: 'h1', sourcePath: 'intake/dump/Downloads/random.pdf' });

    const summary = await runRouteIntake(root, {});

    expect(summary.byTopic.unsorted).toBe(1);
    expect(summary.ambiguousCount).toBe(0);
  });

  it('reports a cross-topic tie as unsorted and ambiguous', async () => {
    const root = makeRoot();
    writeConfig(root, { 'topic-a': ['shared term'], 'topic-b': ['shared term'] });
    writeManifestEntry(root, { hash: 'h1', sourcePath: 'intake/dump/Shared Term/file.jpg' });

    const summary = await runRouteIntake(root, {});

    expect(summary.byTopic.unsorted).toBe(1);
    expect(summary.ambiguousCount).toBe(1);
    const report = JSON.parse(fs.readFileSync(path.join(root, 'intake-routing-report.json'), 'utf-8'));
    expect(report.entries[0].ambiguous).toBe(true);
  });

  it('expands dupPaths into separate report rows, each classified independently', async () => {
    const root = makeRoot();
    writeConfig(root, CONFIG);
    writeManifestEntry(root, {
      hash: 'h1',
      sourcePath: 'intake/dump/Willow Run/scan1.jpg',
      dupPaths: ['intake/dump/Cuba Trip/scan1-copy.jpg'],
    });

    const summary = await runRouteIntake(root, {});

    expect(summary.totalConsidered).toBe(2);
    const report = JSON.parse(fs.readFileSync(path.join(root, 'intake-routing-report.json'), 'utf-8'));
    const topics = report.entries.map((e: { topic: string }) => e.topic).sort();
    expect(topics).toEqual(['cuba', 'willow-run']);
  });

  it('excludes failed-status manifest entries entirely', async () => {
    const root = makeRoot();
    writeConfig(root, CONFIG);
    writeManifestEntry(root, { hash: 'h1', sourcePath: 'intake/dump/Cuba Trip/bad.pdf', status: 'failed', error: 'unsupported extension' });

    const summary = await runRouteIntake(root, {});

    expect(summary.totalConsidered).toBe(0);
  });

  it('throws before classification when a manifest sourcePath escapes root', async () => {
    const root = makeRoot();
    writeConfig(root, CONFIG);
    writeManifestEntry(root, { hash: 'h1', sourcePath: '../outside/evil.jpg' });

    await expect(runRouteIntake(root, {})).rejects.toThrow(/root|escape|outside/i);
    expect(fs.existsSync(path.join(root, 'intake-routing-report.json'))).toBe(false);
  });

  it('throws before reading the manifest when config is missing', async () => {
    const root = makeRoot();
    // no config written
    writeManifestEntry(root, { hash: 'h1', sourcePath: 'intake/dump/Cuba Trip/photo1.jpg' });

    await expect(runRouteIntake(root, {})).rejects.toThrow(/topic-routing/i);
  });

  it('matchedKeyword preserves the config spelling, not the normalized form', async () => {
    const root = makeRoot();
    writeConfig(root, { 'michigan-flight-museum': ['Michigan Flight Museum'] });
    writeManifestEntry(root, { hash: 'h1', sourcePath: 'intake/dump/michigan-flight-museum/photo1.jpg' });

    await runRouteIntake(root, {});

    const report = JSON.parse(fs.readFileSync(path.join(root, 'intake-routing-report.json'), 'utf-8'));
    expect(report.entries[0].matchedKeyword).toBe('Michigan Flight Museum');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/cli/commands/routeIntake.test.ts`
Expected: FAIL — `src/cli/commands/routeIntake` does not exist yet.

- [ ] **Step 3: Implement the dry-run path**

Create `src/cli/commands/routeIntake.ts`:

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readIntakeManifest, IntakeEntry } from '../../core/intakeManifest';
import { loadTopicRoutingConfig, classifyPath, normalize } from '../../core/topicRouting';
import { writeFileAtomic } from '../../core/atomicWrite';

export type RouteEntryStatus = 'staged' | 'unsorted' | 'missing' | 'failed' | 'would-stage';
export type RouteRunStatus = 'completed' | 'preflight-failed' | 'failed';

export interface RouteReportEntry {
  sourcePath: string;
  hash: string;
  topic: string | null;
  matchedKeyword: string | null;
  ambiguous: boolean;
  status: RouteEntryStatus;
  stagedPath?: string;
  error?: string;
}

export interface RouteIntakeReport {
  reportVersion: 1;
  generatedAt: string;
  applied: boolean;
  runStatus: RouteRunStatus;
  runId: string;
  totalConsidered: number;
  byTopic: Record<string, number>;
  ambiguousCount: number;
  entries: RouteReportEntry[];
  error?: string;
}

export interface RouteIntakeOptions {
  apply?: boolean;
  configPath?: string;
  runId?: string;
}

export type RouteIntakeSummary = Pick<
  RouteIntakeReport,
  'totalConsidered' | 'byTopic' | 'ambiguousCount' | 'runStatus'
>;

function reportPath(root: string): string {
  return path.join(root, 'intake-routing-report.json');
}

function resolveConfigPath(root: string, configPath?: string): string {
  return path.resolve(root, configPath ?? 'config/topic-routing.json');
}

function resolvePhysicalPath(root: string, sourcePath: string): string {
  const resolved = path.resolve(root, sourcePath);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `route-intake: manifest sourcePath "${sourcePath}" resolves outside the vault root "${root}" -- refusing to classify it`
    );
  }
  return resolved;
}

function classifyEntries(root: string, entries: IntakeEntry[], config: ReturnType<typeof loadTopicRoutingConfig>): RouteReportEntry[] {
  const rows: RouteReportEntry[] = [];
  for (const entry of entries) {
    const physicalPaths = [entry.sourcePath, ...(entry.dupPaths ?? [])];
    for (const sourcePath of physicalPaths) {
      resolvePhysicalPath(root, sourcePath); // throws on escape; result unused here, absolute path resolved again at apply time
      const { result, ambiguous } = classifyPath(normalize(sourcePath), config);
      rows.push({
        sourcePath,
        hash: entry.hash,
        topic: result?.topic ?? null,
        matchedKeyword: result?.matchedKeyword ?? null,
        ambiguous,
        status: result ? 'would-stage' : 'unsorted',
      });
    }
  }
  return rows;
}

function summarize(entries: RouteReportEntry[]): { byTopic: Record<string, number>; ambiguousCount: number } {
  const byTopic: Record<string, number> = {};
  let ambiguousCount = 0;
  for (const entry of entries) {
    const key = entry.topic ?? 'unsorted';
    byTopic[key] = (byTopic[key] ?? 0) + 1;
    if (entry.ambiguous) ambiguousCount++;
  }
  return { byTopic, ambiguousCount };
}

export async function runRouteIntake(root: string, opts: RouteIntakeOptions): Promise<RouteIntakeSummary> {
  const config = loadTopicRoutingConfig(resolveConfigPath(root, opts.configPath));
  const manifest = readIntakeManifest(root);
  const doneEntries = Object.values(manifest.entries).filter((e) => e.status === 'done');
  const entries = classifyEntries(root, doneEntries, config);
  const { byTopic, ambiguousCount } = summarize(entries);

  const report: RouteIntakeReport = {
    reportVersion: 1,
    generatedAt: new Date().toISOString(),
    applied: false,
    runStatus: 'completed',
    runId: opts.runId ?? 'dry-run',
    totalConsidered: entries.length,
    byTopic,
    ambiguousCount,
    entries,
  };

  writeFileAtomic(reportPath(root), JSON.stringify(report, null, 2));

  return { totalConsidered: report.totalConsidered, byTopic: report.byTopic, ambiguousCount: report.ambiguousCount, runStatus: report.runStatus };
}
```

Note: `opts.apply` is intentionally not yet handled — Task 4 adds it. This step's `runRouteIntake` always behaves as a dry run.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/cli/commands/routeIntake.test.ts`
Expected: PASS, all dry-run tests.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/routeIntake.ts tests/cli/commands/routeIntake.test.ts
git commit -m "feat(trm): add route-intake dry-run classification and report"
```

---

### Task 4: `--apply` staging, topic preflight, locking

**Files:**
- Modify: `src/cli/commands/routeIntake.ts`
- Modify: `tests/cli/commands/routeIntake.test.ts`

**Interfaces:**
- Consumes: `readTopicMeta` from `../../core/topicNode` (topic-existence preflight check); `copyFileAtomic` from `../../core/atomicWrite` (Task 1); `acquireLock`, `releaseLock`, `LockConflictError`, `LockUnrecoverableError` from `../../sync/lock`.
- No new exports beyond what Task 3 already defined — this task fills in the `opts.apply` branch that Task 3 left unhandled.

- [ ] **Step 1: Write the failing tests (apply behaviors)**

Add to `tests/cli/commands/routeIntake.test.ts`. First add these two imports near the top (alongside the existing `fs`/`os`/`path`/`runRouteIntake` imports from Task 3):

```ts
import { createNode } from '../../../src/core/topicNode';
import { acquireLock } from '../../../src/sync/lock';
```

```ts
describe('runRouteIntake (--apply)', () => {
  it('stages a matched file into topics/charlie/<topic>/_staging-intake-<runId>/', async () => {
    const root = makeRoot();
    writeConfig(root, CONFIG);
    createNode(root, 'charlie/cuba', 'ACTOR-TEST');
    const srcDir = path.join(root, 'intake', 'dump', 'Cuba Trip');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'photo1.jpg'), 'bytes');
    writeManifestEntry(root, { hash: 'h1', sourcePath: 'intake/dump/Cuba Trip/photo1.jpg' });

    const summary = await runRouteIntake(root, { apply: true, runId: 'test-run-1' });

    expect(summary.runStatus).toBe('completed');
    const stagedPath = path.join(root, 'topics', 'charlie', 'cuba', '_staging-intake-test-run-1', 'photo1.jpg');
    expect(fs.readFileSync(stagedPath, 'utf-8')).toBe('bytes');
    // original untouched
    expect(fs.readFileSync(path.join(srcDir, 'photo1.jpg'), 'utf-8')).toBe('bytes');
    const report = JSON.parse(fs.readFileSync(path.join(root, 'intake-routing-report.json'), 'utf-8'));
    expect(report.applied).toBe(true);
    expect(report.entries[0]).toMatchObject({ status: 'staged', stagedPath });
  });

  it('never creates a staging directory for unsorted files', async () => {
    const root = makeRoot();
    writeConfig(root, CONFIG);
    const srcDir = path.join(root, 'intake', 'dump', 'Downloads');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'random.pdf'), 'bytes');
    writeManifestEntry(root, { hash: 'h1', sourcePath: 'intake/dump/Downloads/random.pdf' });

    await runRouteIntake(root, { apply: true, runId: 'test-run-2' });

    expect(fs.existsSync(path.join(root, 'topics'))).toBe(false);
  });

  it('resolves a basename collision within one run with a hash suffix', async () => {
    const root = makeRoot();
    writeConfig(root, CONFIG);
    createNode(root, 'charlie/cuba', 'ACTOR-TEST');
    const dirA = path.join(root, 'intake', 'dump', 'Cuba Trip', 'A');
    const dirB = path.join(root, 'intake', 'dump', 'Cuba Trip', 'B');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    fs.writeFileSync(path.join(dirA, 'photo.jpg'), 'aaa');
    fs.writeFileSync(path.join(dirB, 'photo.jpg'), 'bbb');
    writeManifestEntry(root, { hash: 'h1', sourcePath: 'intake/dump/Cuba Trip/A/photo.jpg' });
    writeManifestEntry(root, { hash: 'h2', sourcePath: 'intake/dump/Cuba Trip/B/photo.jpg' });

    await runRouteIntake(root, { apply: true, runId: 'test-run-3' });

    const stagingDir = path.join(root, 'topics', 'charlie', 'cuba', '_staging-intake-test-run-3');
    const staged = fs.readdirSync(stagingDir);
    expect(staged).toHaveLength(2);
    expect(new Set(staged).size).toBe(2); // no overwrite
  });

  it('aborts before staging when a matched topic has no topic.json, but still writes a report', async () => {
    const root = makeRoot();
    writeConfig(root, CONFIG);
    // no createNode call -- 'cuba' topic node deliberately absent
    const srcDir = path.join(root, 'intake', 'dump', 'Cuba Trip');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'photo1.jpg'), 'bytes');
    writeManifestEntry(root, { hash: 'h1', sourcePath: 'intake/dump/Cuba Trip/photo1.jpg' });

    const summary = await runRouteIntake(root, { apply: true, runId: 'test-run-4' });

    expect(summary.runStatus).toBe('preflight-failed');
    expect(fs.existsSync(path.join(root, 'topics', 'charlie', 'cuba'))).toBe(false);
    const report = JSON.parse(fs.readFileSync(path.join(root, 'intake-routing-report.json'), 'utf-8'));
    expect(report.applied).toBe(false);
    expect(report.error).toMatch(/cuba/i);
    expect(report.entries[0].status).toBe('would-stage'); // classification still shown
  });

  it('marks a missing source file as status "missing" without failing the whole run', async () => {
    const root = makeRoot();
    writeConfig(root, CONFIG);
    createNode(root, 'charlie/cuba', 'ACTOR-TEST');
    // note: no file written to disk for this sourcePath
    writeManifestEntry(root, { hash: 'h1', sourcePath: 'intake/dump/Cuba Trip/gone.jpg' });

    const summary = await runRouteIntake(root, { apply: true, runId: 'test-run-5' });

    expect(summary.runStatus).toBe('completed');
    const report = JSON.parse(fs.readFileSync(path.join(root, 'intake-routing-report.json'), 'utf-8'));
    expect(report.entries[0]).toMatchObject({ status: 'missing' });
    expect(report.entries[0].error).toBeDefined();
  });

  it('marks a copy failure as status "failed" and still completes the run for other entries', async () => {
    const root = makeRoot();
    writeConfig(root, CONFIG);
    createNode(root, 'charlie/cuba', 'ACTOR-TEST');
    const srcDir = path.join(root, 'intake', 'dump', 'Cuba Trip');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'photo1.jpg'), 'bytes');
    fs.writeFileSync(path.join(srcDir, 'photo2.jpg'), 'bytes');
    writeManifestEntry(root, { hash: 'h1', sourcePath: 'intake/dump/Cuba Trip/photo1.jpg' });
    writeManifestEntry(root, { hash: 'h2', sourcePath: 'intake/dump/Cuba Trip/photo2.jpg' });

    const copySpy = jest.spyOn(fs, 'copyFileSync').mockImplementationOnce(() => {
      throw new Error('simulated copy failure');
    });

    try {
      const summary = await runRouteIntake(root, { apply: true, runId: 'test-run-6' });
      expect(summary.runStatus).toBe('completed');
      const report = JSON.parse(fs.readFileSync(path.join(root, 'intake-routing-report.json'), 'utf-8'));
      const statuses = report.entries.map((e: { status: string }) => e.status).sort();
      expect(statuses).toEqual(['failed', 'staged']);
    } finally {
      copySpy.mockRestore();
    }
  });

  it('fails fast with a lock conflict when a live lock is already held', async () => {
    const root = makeRoot();
    writeConfig(root, CONFIG);
    createNode(root, 'charlie/cuba', 'ACTOR-TEST');
    writeManifestEntry(root, { hash: 'h1', sourcePath: 'intake/dump/Cuba Trip/photo1.jpg' });
    acquireLock(path.join(root, 'intake-routing.lock'), 'other-run');

    await expect(runRouteIntake(root, { apply: true })).rejects.toThrow(/lock/i);
  });

  it('writes a runStatus: "failed" report and releases the lock on an unexpected crash inside the lock-held region', async () => {
    const root = makeRoot();
    writeConfig(root, CONFIG);
    createNode(root, 'charlie/cuba', 'ACTOR-TEST');
    const srcDir = path.join(root, 'intake', 'dump', 'Cuba Trip');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'photo1.jpg'), 'bytes');
    writeManifestEntry(root, { hash: 'h1', sourcePath: 'intake/dump/Cuba Trip/photo1.jpg' });

    // existsSync's per-file "does the source still exist" check sits outside
    // the per-entry try/catch (only copyFileAtomic is guarded there), so a
    // throw here exercises the outer catch -> runStatus: 'failed' path, not
    // the per-entry 'missing'/'failed' path. Mock conditionally on the exact
    // source path -- a blanket mockImplementationOnce would instead intercept
    // loadTopicRoutingConfig's own existsSync check on the config file,
    // which runs first and isn't what this test means to exercise.
    const targetPath = path.join(srcDir, 'photo1.jpg');
    const realExistsSync = fs.existsSync;
    const existsSpy = jest.spyOn(fs, 'existsSync').mockImplementation((p) => {
      if (p === targetPath) throw new Error('simulated unexpected fs error');
      return realExistsSync(p);
    });

    try {
      await expect(runRouteIntake(root, { apply: true, runId: 'test-run-7' })).rejects.toThrow('simulated unexpected fs error');
    } finally {
      existsSpy.mockRestore();
    }

    const report = JSON.parse(fs.readFileSync(path.join(root, 'intake-routing-report.json'), 'utf-8'));
    expect(report.runStatus).toBe('failed');
    expect(report.error).toMatch(/simulated unexpected fs error/);
    // lock released despite the crash
    expect(fs.existsSync(path.join(root, 'intake-routing.lock'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/cli/commands/routeIntake.test.ts -t apply`
Expected: FAIL — `--apply` isn't implemented yet (Task 3's `runRouteIntake` ignores `opts.apply` entirely, so these all behave like dry-runs and their assertions about staged files / locks / preflight fail).

- [ ] **Step 3: Implement `--apply`**

Replace the body of `runRouteIntake` in `src/cli/commands/routeIntake.ts` with the full dry-run + apply logic:

```ts
import * as crypto from 'node:crypto';
import { readTopicMeta } from '../../core/topicNode';
import { copyFileAtomic } from '../../core/atomicWrite';
import { acquireLock, releaseLock } from '../../sync/lock';
```

(add these imports alongside the existing ones at the top of the file)

```ts
function generateRunId(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  return `${date}-${suffix}`;
}

function stagingDir(root: string, topic: string, runId: string): string {
  return path.join(root, 'topics', 'charlie', topic, `_staging-intake-${runId}`);
}

function lockPath(root: string): string {
  return path.join(root, 'intake-routing.lock');
}

function topicNodeExists(root: string, topic: string): boolean {
  try {
    readTopicMeta(root, `charlie/${topic}`);
    return true;
  } catch {
    return false;
  }
}

export async function runRouteIntake(root: string, opts: RouteIntakeOptions): Promise<RouteIntakeSummary> {
  const config = loadTopicRoutingConfig(resolveConfigPath(root, opts.configPath));
  const manifest = readIntakeManifest(root);
  const doneEntries = Object.values(manifest.entries).filter((e) => e.status === 'done');
  const entries = classifyEntries(root, doneEntries, config);
  const { byTopic, ambiguousCount } = summarize(entries);
  const runId = opts.runId ?? generateRunId();

  const writeAndReturn = (report: RouteIntakeReport): RouteIntakeSummary => {
    writeFileAtomic(reportPath(root), JSON.stringify(report, null, 2));
    return { totalConsidered: report.totalConsidered, byTopic: report.byTopic, ambiguousCount: report.ambiguousCount, runStatus: report.runStatus };
  };

  if (!opts.apply) {
    return writeAndReturn({
      reportVersion: 1,
      generatedAt: new Date().toISOString(),
      applied: false,
      runStatus: 'completed',
      runId,
      totalConsidered: entries.length,
      byTopic,
      ambiguousCount,
      entries,
    });
  }

  const matchedTopics = [...new Set(entries.map((e) => e.topic).filter((t): t is string => t !== null))];
  const missingTopics = matchedTopics.filter((t) => !topicNodeExists(root, t));
  if (missingTopics.length > 0) {
    return writeAndReturn({
      reportVersion: 1,
      generatedAt: new Date().toISOString(),
      applied: false,
      runStatus: 'preflight-failed',
      runId,
      totalConsidered: entries.length,
      byTopic,
      ambiguousCount,
      entries,
      error: `missing topic node(s): ${missingTopics.map((t) => `topics/charlie/${t}`).join(', ')} -- run "trm create topics/charlie/<topic>" first`,
    });
  }

  acquireLock(lockPath(root), runId);
  try {
    const stagedEntries: RouteReportEntry[] = [];
    const basenamesUsed = new Map<string, Set<string>>(); // topic -> set of basenames already staged this run

    for (const entry of entries) {
      if (!entry.topic) {
        stagedEntries.push(entry);
        continue;
      }
      const absSource = path.resolve(root, entry.sourcePath);
      if (!fs.existsSync(absSource)) {
        stagedEntries.push({ ...entry, status: 'missing', error: `source file no longer exists at "${entry.sourcePath}"` });
        continue;
      }
      const destDir = stagingDir(root, entry.topic, runId);
      let basename = path.basename(entry.sourcePath);
      const usedForTopic = basenamesUsed.get(entry.topic) ?? new Set<string>();
      if (usedForTopic.has(basename)) {
        const ext = path.extname(basename);
        const stem = path.basename(basename, ext);
        basename = `${stem}-${entry.hash.slice(0, 8)}${ext}`;
      }
      usedForTopic.add(basename);
      basenamesUsed.set(entry.topic, usedForTopic);

      const destPath = path.join(destDir, basename);
      try {
        copyFileAtomic(absSource, destPath);
        stagedEntries.push({ ...entry, status: 'staged', stagedPath: destPath });
      } catch (err) {
        stagedEntries.push({ ...entry, status: 'failed', error: (err as Error).message });
      }
    }

    return writeAndReturn({
      reportVersion: 1,
      generatedAt: new Date().toISOString(),
      applied: true,
      runStatus: 'completed',
      runId,
      totalConsidered: entries.length,
      byTopic,
      ambiguousCount,
      entries: stagedEntries,
    });
  } catch (err) {
    writeAndReturn({
      reportVersion: 1,
      generatedAt: new Date().toISOString(),
      applied: false,
      runStatus: 'failed',
      runId,
      totalConsidered: entries.length,
      byTopic,
      ambiguousCount,
      entries,
      error: (err as Error).message,
    });
    throw err;
  } finally {
    releaseLock(lockPath(root));
  }
}
```

This replaces the whole function body written in Task 3 — the dry-run branch (`if (!opts.apply) { ... }`) is preserved verbatim in behavior, just refactored to share `writeAndReturn`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/cli/commands/routeIntake.test.ts`
Expected: PASS, all tests (dry-run from Task 3 plus apply tests from this task).

- [ ] **Step 5: Run the full test suite**

Run: `npx jest`
Expected: PASS, no regressions elsewhere.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/routeIntake.ts tests/cli/commands/routeIntake.test.ts
git commit -m "feat(trm): add route-intake --apply staging with topic preflight and locking"
```

---

### Task 5: CLI wiring

**Files:**
- Modify: `src/cli/index.ts`

**Interfaces:**
- Consumes: `runRouteIntake`, `RouteIntakeOptions` from `./commands/routeIntake` (Task 3/4); `LockConflictError`, `LockUnrecoverableError` already imported in this file.

- [ ] **Step 1: Add the command**

In `src/cli/index.ts`, add the import alongside the existing command imports:

```ts
import { runRouteIntake } from './commands/routeIntake';
```

Add the command registration after the existing `triage-intake` block:

```ts
program
  .command('route-intake')
  .option('--apply', 'stage matched files into per-topic staging directories; default is a dry-run report only')
  .option('--config <path>', 'override the default config/topic-routing.json')
  .action(async (opts) => {
    try {
      const summary = await runRouteIntake(root, { apply: opts.apply, configPath: opts.config });
      console.log(JSON.stringify(summary, null, 2));
      if (summary.runStatus !== 'completed') process.exitCode = 1;
    } catch (err) {
      if (err instanceof LockConflictError || err instanceof LockUnrecoverableError) {
        console.error(err.message);
        process.exitCode = 1;
      } else {
        throw err;
      }
    }
  });
```

- [ ] **Step 2: Build and smoke-test the CLI wiring**

Run: `npm run build`
Expected: clean TypeScript build.

Run: `node dist/cli/index.js route-intake --help` (from a directory that passes `assertSafeRoot`, e.g. the real vault at `C:\Users\soren\trm-vault`, not `C:\dev\trm` itself)
Expected: prints usage showing `--apply` and `--config` options, matching the `triage-intake --help` output style already seen.

- [ ] **Step 3: Run the full test suite one more time**

Run: `npx jest`
Expected: PASS, 53+ suites (no regressions from the CLI wiring change, which has no dedicated test per the existing repo convention — `triage-intake`'s CLI wiring has none either).

- [ ] **Step 4: Commit**

```bash
git add src/cli/index.ts
git commit -m "feat(trm): wire up trm route-intake CLI command"
```

---

## Post-plan verification

- [ ] Run `trm route-intake` (dry-run) against the real vault at `C:\Users\soren\trm-vault` and inspect `intake-routing-report.json` — sanity-check the seed `config/topic-routing.json` keywords against real `intake/dump` folder/file names, and refine keywords if the real data reveals gaps (per the spec's own note that the seed keywords are illustrative, not final).
