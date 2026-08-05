# route-intake: Topic Classification for Triaged Files — Design

## Problem

`trm triage-intake` classifies each intake file by *type* (`text` /
`exhibit-photo` / `doc-photo` / `unsure`), written to `intake-manifest.json`.
It has no concept of *topic* — which vault sub-topic (`benson-ford`,
`cuba`, `helene`, `helene-i`, `michigan-flight-museum`, `willow-run`) a file
actually belongs to.

`trm ingest-dir <topicPath> --dir <dir>` requires both a topic and a flat
directory of files to walk (it does not recurse). A real intake batch
(`intake/dump`, ~740 files) is nested across nine loosely-organized
subfolders (`Documents/Source Articles`, `Downloads`, `Research Logs`,
`Documents/Treatment`, etc.) that don't line up with vault sub-topics at
all. There is currently no step between triage and ingest that decides
which topic a file's content belongs to.

## Goals

- Given `intake-manifest.json`, classify each routable *path* (see
  "Routing unit" below) to a likely vault topic using cheap,
  zero-extraction signals (folder path + filename).
- Default to a dry-run: no source file, staging directory, or vault state
  is changed. The `intake-routing-report.json` report artifact is written
  on every run (dry or applied) — it is the reviewable output, not a side
  effect to avoid.
- `--apply` stages matched files into a per-topic, per-run staging
  directory, ready for a manual `ingest-dir` call per topic.
- Keyword-to-topic mapping lives in an editable, validated config file,
  not hardcoded, since the vault's topic list is expected to keep growing
  (confirmed during this design: `willys-overland` was missing entirely
  until this pass surfaced it from the documentary treatment doc).

## Non-goals

- Content/OCR-based classification (would duplicate `ingest-dir`'s own
  extraction cost — filename/path heuristics are the agreed signal for
  this pass).
- Auto-creating new topic nodes in the vault. `willys-overland` (and any
  future topic) needs its `topics/charlie/<slug>/topic.json` created via
  the existing `trm create` command *before* `route-intake --apply` can
  usefully stage files there, and before `ingest-dir` can ingest them.
  `route-intake` only proposes/stages; topic lifecycle is out of scope.
- Actually invoking `ingest-dir`. Running it per topic, after reviewing
  the staged files, remains a manual step.
- Auto-expanding the topic set from new keywords the classifier doesn't
  recognize. Ambiguous or unmatched files fall to `unsorted` for a human
  to look at and, if warranted, add a keyword or a new topic by hand.

## Design

### Routing unit: physical path, not manifest record

`IntakeEntry.dupPaths` holds every additional source path that hashed to
the same canonical entry — `write()` in `openIntakeManifest` appends to it
rather than creating a second record (`src/core/intakeManifest.ts:73-83`).
If routing only iterated `entries[hash].sourcePath`, every duplicate path
would silently vanish from the report and from staging, even though it's a
real file sitting in `intake/` that may live in a *different* folder than
the canonical copy (and therefore match a different topic keyword).

**Decision:** routing operates per physical path. For each manifest entry
with `status === 'done'`, build the list `[entry.sourcePath, ...(entry.dupPaths ?? [])]`
and classify **each path independently** (same hash, but each path gets its
own topic match, its own report row, and — on `--apply` — its own staged
copy, since the same bytes can legitimately belong in two topic folders if
two duplicate copies live under two different keyword-matching directories).
`ingest-dir`'s own hash-based dedup (`manifestStore.isDone`) is what
prevents the same content from being ingested twice once both staged
copies reach it — that's not this command's job to pre-empt.

### Config: `config/topic-routing.json`

New file at `config/topic-routing.json` — `config/` already exists in the
repo root (currently holds `phase4-canary-stage1.env`), so this just adds
a file to it, no new directory.

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

Seeded from what's visible in existing batch/topic names plus the
documentary treatment doc scan that surfaced `willys-overland` (Sorensen's
1944–46 CEO tenure at Willys-Overland Motors, the Jeep company, after his
Ford exit). Keywords are illustrative — refine at implementation/review
time against real `intake/dump` folder and file names.

**Schema and validation** (checked at load time, before any manifest
reading — a bad config must never produce a silently-empty or
silently-wrong routing run):

- Top level must be a JSON object (not array/string/etc).
- Every key (topic slug) must match `^[a-z0-9-]+$` — this is also the
  safety boundary that keeps a malicious/typo'd slug (e.g. `../../etc`)
  from ever being joined into a filesystem path (see Staging path safety
  below). A slug failing this pattern is a validation error, not silently
  skipped.
- Every value must be a non-empty array of non-empty strings.
- No two keywords under *different* topics may collide once both are run
  through the same normalization used for matching (lowercase,
  punctuation/separators → spaces, collapsed whitespace) — checked after
  normalization, not on the raw string, so `"michigan-flight-museum"`
  under one topic and `"Michigan Flight Museum"` under another are caught
  as the same collision they'd be at match time. This is an unresolvable
  ambiguity baked into the config itself, so it's rejected at load time
  rather than surfacing as a per-file `unsorted` surprise later.
- `--config <path>` (and the default `config/topic-routing.json`) is
  resolved relative to `root` (the vault root passed to `runRouteIntake`),
  the same convention `triage-intake`'s `--dir` uses — not
  `process.cwd()`.

### Matching: normalization, boundaries, and precedence

Raw substring matching has two concrete failure modes the config above
would immediately hit: `"helene"` is a substring of `"helene-i"`/`"helene i"`
(false ambiguity on every real `helene-i` file), and an unbounded match on
short keywords like `"cuba"` could hit an unrelated word fragment.

**Normalization:** lowercase the path, then replace every `_`, `-`, `/`,
and `\` with a space, and collapse repeated whitespace — this turns both
path separators and filename punctuation into token boundaries so
`"Michigan Flight Museum"`, `michigan-flight-museum`, and
`michigan_flight_museum` all normalize to the same token sequence
`michigan flight museum`.

**Matching:** a keyword matches only on a word-boundary substring of the
normalized path (`\bKEYWORD\b` after the same normalization is applied to
the keyword itself) — not a raw substring — so `"cuba"` cannot match inside
a longer unrelated word.

**Precedence (resolves `helene` vs `helene-i`):** collect every
`(topic, keyword)` pair that matches, across *all* topics, then keep only
the topic(s) whose best-matching keyword is longest (by token count, then
by character length as a tiebreak). If exactly one topic remains after
that filter, assign it. If two or more topics are still tied at the same
maximum length, the file is `unsorted` and flagged `ambiguous: true`. This
means a file whose path matches both `helene` and `helene i` resolves
cleanly to `helene-i` (longer, more specific keyword wins), while two
*equally specific* but different-topic matches still correctly fall to
manual review. Multiple keywords matching under the *same* topic (e.g.
`willys-overland`'s `willys` and `jeep` both hitting one path) is not a
conflict — it's one topic, assign it.

The report's `matchedKeyword` field stores the keyword exactly as written
in `topic-routing.json` (e.g. `"Michigan Flight Museum"` if that's the
config spelling), not its normalized form — normalization is purely a
matching-time detail; the report is for human review, so it shows the
keyword the way a human wrote it in the config.

### Command: `src/cli/commands/routeIntake.ts`

```ts
export type RouteEntryStatus = 'staged' | 'unsorted' | 'missing' | 'failed' | 'would-stage';
export type RouteRunStatus = 'completed' | 'preflight-failed' | 'failed';

export interface RouteReportEntry {
  sourcePath: string; // root-relative, exactly as read from the manifest
  hash: string;
  topic: string | null; // null only when status is 'unsorted'
  matchedKeyword: string | null; // config spelling, e.g. "Michigan Flight Museum" as written in topic-routing.json -- not the normalized form, for human readability in the report
  ambiguous: boolean;
  status: RouteEntryStatus;
  stagedPath?: string; // present only when status === 'staged'
  error?: string; // present only when status === 'missing' | 'failed'
}

export interface RouteIntakeReport {
  reportVersion: 1;
  generatedAt: string; // ISO timestamp
  applied: boolean; // false for dry-run, true only when staging actually ran
  runStatus: RouteRunStatus;
  runId: string; // also the staging directory suffix when applied
  totalConsidered: number;
  byTopic: Record<string, number>; // includes 'unsorted'
  ambiguousCount: number;
  entries: RouteReportEntry[];
  error?: string; // set when runStatus is 'preflight-failed' or 'failed'
}

export interface RouteIntakeOptions {
  apply?: boolean;
  configPath?: string; // resolved relative to root; defaults to config/topic-routing.json
  runId?: string; // test-injectable override; defaults to a freshly generated id (see Design step 6c)
}

export type RouteIntakeSummary = Pick<
  RouteIntakeReport,
  'totalConsidered' | 'byTopic' | 'ambiguousCount' | 'runStatus'
>;

export async function runRouteIntake(
  root: string,
  opts: RouteIntakeOptions
): Promise<RouteIntakeSummary>
```

**Logic:**

1. Load and validate `topic-routing.json` (schema rules above). Any
   validation failure throws before `intake-manifest.json` is even read,
   and before any report is written — there is no partial classification
   to report on yet, so this stays a thrown error, not a `runStatus:
   'failed'` report. Same for a missing/unreadable manifest file.
2. Read `intake-manifest.json` via the existing `readIntakeManifest(root)`.
3. Filter to entries where `status === 'done'`, then expand each into its
   physical paths (`sourcePath` + `dupPaths`, per "Routing unit" above).
   Each path is resolved as `path.resolve(root, sourcePath)` — manifest
   paths are always written root-relative by `triage-intake`
   (`triageIntake.ts`'s `rel = path.relative(root, filePath)...`), so an
   absolute path or a relative path that resolves outside `root` indicates
   a corrupted or hand-edited manifest. Reject such an entry the same way
   `resolveWalkDir` in `triageIntake.ts` rejects an escaping `--dir`: throw
   before classification begins, naming the offending path — this is a
   structural manifest-integrity problem, not a per-file routing outcome.
4. Classify every physical path per the Matching rules above, producing a
   `RouteReportEntry` for each with `status: 'would-stage'` or `'unsorted'`.
   This step fully determines every entry's topic assignment regardless of
   `--apply` — staging is a separate, later concern.
5. **If `opts.apply` is not set:** write the report with `applied: false`,
   `runStatus: 'completed'` (dry-run classification either succeeds for
   every entry or throws per step 3/1 above — there's no partial dry-run
   state), print the summary, return. Nothing under `topics/` or `intake/`
   is touched.
6. **If `opts.apply` is set:**
   a. Collect the distinct set of non-`unsorted` topics this run would
      stage into. For each, check `topics/charlie/<topic>/topic.json`
      exists (`readTopicMeta` throwing means it doesn't). **If any matched
      topic has no topic node, do not stage anything.** Write the report
      immediately with `applied: false`, `runStatus: 'preflight-failed'`,
      `error` listing the missing topic(s) (e.g. "run `trm create
      topics/charlie/willys-overland` first"), and `entries` reflecting
      the classification from step 4 (still `'would-stage'`/`'unsorted'` —
      classification succeeded, only staging was blocked). Return this
      report; exit non-zero. This is the one and only way "report always
      written" and "abort before staging" coexist: the abort itself
      becomes the report's documented outcome, not a contradiction of it.
   b. Acquire an exclusive run lock (`intake-routing.lock` at vault root)
      via the existing `src/sync/lock.ts` (`acquireLock`/`releaseLock`) —
      same cross-host/stale-pid semantics already used by `sync-treatment`.
      A concurrent `--apply` run gets the same
      `LockConflictError`/`LockUnrecoverableError` behavior other commands
      already surface; dry-run needs no lock (read-only against the
      manifest — see Report writing for the one caveat). From this point
      until step (e), the lock release happens in a `finally` block —
      any unexpected exception during staging or report writing (not just
      the handled per-entry `missing`/`failed` cases) still releases the
      lock. An exception escaping the `finally`-guarded region is caught
      at the top level, and a best-effort report is written with
      `runStatus: 'failed'` and `error` set to that exception's message
      before it propagates, so a route-intake crash is still visible in
      `intake-routing-report.json` rather than only in a stack trace.
   c. Generate one `runId` for this invocation (or use `opts.runId` if
      provided — the test-injection point for deterministic assertions on
      exact staging paths, per the testability gap this closes):
      `<YYYYMMDD-HHMMSS>-<6-char random suffix>` — guarantees uniqueness
      even across multiple `--apply` runs in the same second, unlike a
      bare date stamp. This is the same value recorded in the report's
      `runId` field.
   d. For each entry with a resolved topic: verify the source file still
      exists on disk. Missing → `status: 'missing'`, `error` set, move on.
      Otherwise copy into a temp file in the destination staging
      directory (`<basename>.tmp-<random>`), then `fs.renameSync` it to
      the final `<basename>` (hash-suffixed on collision, per below) —
      an interrupted copy leaves only a stray `.tmp-*` file behind, never
      a truncated file at the real destination name, so a partial copy can
      never be mistaken for a valid staged file. A basename collision
      *within this run* (two matched paths sharing a basename) appends the
      first 8 hex characters of that path's hash before the extension.
      A copy or rename that throws (disk full, permissions, etc.) →
      `status: 'failed'`, `error` set, and the stray temp file (if any) is
      removed on a best-effort basis — processing continues for the
      remaining entries rather than aborting the whole run (a failure on
      file 37 of 200 shouldn't discard the 36 that already succeeded).
      Successful rename → `status: 'staged'`, `stagedPath` set.
   e. Release the lock (`finally`, per step 6b).
7. **Report writing:** for a completed apply run, the report is written
   with `runStatus: 'completed'`, `applied: true`, after every entry has
   reached a terminal status (`staged`/`missing`/`failed`/`unsorted`) —
   never incrementally, so a run that dies partway through never leaves a
   report claiming completion it didn't reach (the `runStatus: 'failed'`
   path in step 6b is what covers that case instead). On a dry run there
   is no lock, so two concurrent dry runs racing to write
   `intake-routing-report.json` is possible; this is explicitly accepted
   (last writer wins, no vault state at risk) rather than guarded, since
   dry-run has nothing to corrupt but its own report file. `--apply`'s
   lock prevents the higher-stakes race (concurrent staging into the same
   directory).

### Staging path safety

Every path segment written under `topics/charlie/` is either a config key
already validated against `^[a-z0-9-]+$` (the topic slug) or a `runId`
generated by this command itself (never derived from file content or
config) — so no user-controlled or file-derived string reaches
`path.join` for the staging destination without going through that
validation. This closes the path-traversal risk a malformed or malicious
topic slug would otherwise open.

### CLI wiring

`src/cli/index.ts` gets a new `route-intake` command, options `--apply` and
an optional `--config <path>` override, following the existing command
registration pattern used for `triage-intake`.

### Tests (`tests/cli/commands/routeIntake.test.ts`)

Following the `triageIntake.test.ts` fixture pattern (`makeRoot`, plus a
helper that writes directly into `intake-manifest.json` for this command,
since it consumes the manifest rather than walking `intake/`), and a
helper that writes a `topics/charlie/<slug>/topic.json` fixture for the
topic-existence checks:

1. Single unambiguous match (`sourcePath` contains one topic's keyword) →
   assigned to that topic, dry-run leaves `topics/` and `intake/`
   untouched, report file written with the correct assignment and
   `status: 'would-stage'`.
2. No keyword matches any topic → `unsorted`, `ambiguousCount` unaffected,
   `topic: null`.
3. Two different topics match at equal keyword-length precedence →
   `unsorted`, `ambiguousCount` incremented, report entry has
   `ambiguous: true`.
4. A path matching both `"helene"` and `"helene i"` resolves to
   `helene-i` (longer keyword wins), not `unsorted` — the precedence
   rule's core regression guard.
5. A canonical entry with `dupPaths` set — both the canonical `sourcePath`
   and every `dupPaths` entry appear as separate rows in the report (and,
   under `--apply`, both get staged independently, including to two
   *different* topics when their paths match different keywords).
6. `failed`-status entries are excluded from `totalConsidered` and the
   report entirely.
7. `--apply` copies a matched file into
   `topics/charlie/<topic>/_staging-intake-<runId>/<name>`, original file
   in `intake/` untouched (still exists, unchanged content); report entry
   has `status: 'staged'` and `stagedPath` set.
8. `--apply` with a filename collision (two matched entries with the same
   basename) — both land in the staging directory under distinct names
   (hash-suffixed), neither overwrites the other.
9. `--apply` never creates a staging directory for `unsorted` files.
10. `--apply` where a matched topic has no `topics/charlie/<topic>/topic.json`
    → no file is copied; report IS written (this run's one required
    behavior) with `applied: false`, `runStatus: 'preflight-failed'`,
    `error` naming the missing topic(s), and `entries` still showing each
    file's classified topic from step 4.
11. `--apply` where the manifest references a `sourcePath` that no longer
    exists on disk → that entry gets `status: 'missing'` with `error` set;
    every other entry in the same run still reaches `staged`;
    `runStatus: 'completed'` (a per-entry miss isn't a run failure).
12. `--apply` where one file's copy/rename throws (simulate via a spy) →
    that entry gets `status: 'failed'` with `error` set; every other entry
    in the same run still reaches `staged` (partial-failure isolation, not
    whole-run abort); `runStatus: 'completed'`.
13. `--apply` where a copy is interrupted mid-write (simulate the temp-file
    write throwing after partial bytes) → no file exists at the final
    `<basename>` destination (only a possible stray `.tmp-*`, which the
    implementation attempts to clean up) — a reader of the staging
    directory never sees a truncated file under a real name.
14. Two `--apply` runs use `opts.runId` overrides to assert exact distinct
    `_staging-intake-<runId>` directory paths deterministically, neither
    overwriting the other's staged files (and one production-path test
    without an override just asserts the `runId` pattern, not an exact
    value, since it's time-based).
15. A concurrent second `--apply` while the first holds the lock →
    `LockConflictError`, no files staged by the second invocation.
16. Missing `topic-routing.json` → throws a clear error before the
    manifest is read; no report written.
17. Malformed (invalid JSON) `topic-routing.json` → throws a clear error.
18. Config schema violations each throw a distinct, clear error: non-object
    top level; a topic slug failing `^[a-z0-9-]+$` (including a
    path-traversal attempt like `"../evil": ["x"]`); an empty keyword
    array; an empty-string keyword; two keywords under different topics
    that collide only after normalization (e.g.
    `"michigan-flight-museum"` vs `"Michigan Flight Museum"` under two
    different topic keys).
19. A manifest entry whose `sourcePath` is absolute, or whose resolved
    path escapes `root` (e.g. via `../`) → throws before classification,
    naming the offending path; no report written (manifest-integrity
    problem, not a per-file outcome).
20. `matchedKeyword` in the report preserves the config's original
    spelling/casing (e.g. `"Michigan Flight Museum"`), not the normalized
    lowercase form used internally for matching.

## Error handling

- Missing/malformed config file, any schema-validation failure, or a
  manifest entry whose path resolves outside `root`: throw before
  `intake-manifest.json` is even read (or, for the path-escape case,
  before that entry is classified), naming the expected path or the
  specific offending key/keyword/path in the error message. No report is
  written for these — there's no partial classification yet to report on.
- A topic matched by this run but missing its `topics/charlie/<topic>/topic.json`
  node: this **does** produce a report — `applied: false`, `runStatus:
  'preflight-failed'`, `error` naming the missing topic(s), `entries`
  showing the classification that was completed before staging was
  blocked (see Design step 6a). This is the resolution to "report always
  written" vs. "abort before staging": the abort is itself the reported
  outcome.
- A file listed in the manifest that no longer exists on disk at `--apply`
  time (deleted since triage ran): `status: 'missing'` for that entry only;
  the run continues for every other entry; `runStatus: 'completed'`.
- A copy/rename that throws mid-run (disk full, permissions, etc.):
  `status: 'failed'` for that entry only; the run continues for every
  other entry; `runStatus: 'completed'`. The report always reflects the
  true per-entry outcome — it is written once, after every entry has
  reached a terminal status, never announcing success before work is
  actually done. Copies land via a temp-file-then-rename sequence in the
  destination directory, so an interrupted copy never leaves a partial
  file visible under its real destination name.
- An unexpected exception during the lock-held region (step 6b–6e) that
  isn't one of the handled per-entry cases above: caught at the top level,
  lock released via `finally` regardless, and a best-effort report is
  written with `runStatus: 'failed'` and `error` set to the exception's
  message before it re-throws — a route-intake crash is visible in
  `intake-routing-report.json`, not just a stack trace.
- Concurrent `--apply` invocations against the same root: the second one
  fails fast with `LockConflictError` (or `LockUnrecoverableError` for a
  malformed/cross-host lock file), via the shared `src/sync/lock.ts`.
  Concurrent dry-runs are unguarded and may race on the report file only —
  explicitly accepted, since no vault state is at stake in a dry run.

## Out of scope / explicitly deferred

- Content/OCR-based classification.
- Auto-creating vault topic nodes (`willys-overland` needs `trm create`
  run separately first).
- Invoking `ingest-dir` automatically.
- Expanding beyond the 7 topics agreed here (`rouge`, `copenhagen`,
  `maine-maritime-museum` were noticed during the treatment-doc scan but
  explicitly deferred — not part of this pass).
