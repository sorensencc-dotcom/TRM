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

- Given `intake-manifest.json`, classify each `done` entry's likely vault
  topic using cheap, zero-extraction signals (folder path + filename).
- Default to a dry-run report — no files touched, no vault state changed —
  so the heuristic can be sanity-checked before anything moves.
- `--apply` stages matched files into a per-topic staging directory, ready
  for a manual `ingest-dir` call per topic.
- Keyword-to-topic mapping lives in an editable config file, not hardcoded,
  since the vault's topic list is expected to keep growing (confirmed
  during this design: `willys-overland` was missing entirely until this
  pass surfaced it from the documentary treatment doc).

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

### Command: `src/cli/commands/routeIntake.ts`

```ts
export interface RouteIntakeOptions {
  apply?: boolean;
  configPath?: string; // override for tests; defaults to config/topic-routing.json
}

export interface RouteIntakeSummary {
  totalConsidered: number;
  byTopic: Record<string, number>; // includes 'unsorted'
  ambiguousCount: number; // subset of unsorted: matched 2+ topics
}

export async function runRouteIntake(
  root: string,
  opts: RouteIntakeOptions
): Promise<RouteIntakeSummary>
```

**Logic:**

1. Read `intake-manifest.json` via the existing `readIntakeManifest(root)`.
2. Filter to entries where `status === 'done'`. (`failed` entries aren't
   ready to route; this mirrors triage's own resume semantics.)
3. Load `topic-routing.json` (from `opts.configPath` or the default
   location). Missing or malformed file is a hard error — routing without
   a keyword map is meaningless, not a silently-empty result.
4. For each entry, lowercase `entry.sourcePath` and test every configured
   topic's keyword list for a substring match:
   - Exactly one topic matches → assign it.
   - Zero topics match → `unsorted`.
   - Two or more *different* topics match → `unsorted`, and counted
     separately in `ambiguousCount` (still bucketed under `unsorted` in
     `byTopic`, but visible in the report as "needs a keyword fix" rather
     than "genuinely unclassified").
5. Build the per-file assignment list and `byTopic` counts.
6. Always write `intake-routing-report.json` at the vault root: full
   per-file list (`sourcePath`, `hash`, assigned topic, `ambiguous: bool`),
   plus the `byTopic` summary. This happens on every run, dry or applied —
   the report is the reviewable artifact either way.
7. If `opts.apply` is not set: stop here. Print the summary to stdout.
   Nothing under `topics/` is touched.
8. If `opts.apply` is set: for every entry whose assigned topic is not
   `unsorted`, copy (not move — `intake/` stays the untouched source of
   record) the file into
   `topics/charlie/<topic>/_staging-intake-<YYYYMMDD>/<original filename>`,
   creating the staging directory if needed. `<YYYYMMDD>` is the date the
   command runs, giving each `--apply` run its own staging batch (matches
   the existing `_staging-batch1..6` convention already visible under
   `benson-ford`). Filename collisions within one staging run (two source
   files with the same basename from different folders) get the hash's
   first 8 characters appended before the extension, so nothing is
   silently overwritten. `unsorted` files are left in place — untouched,
   only reported.

### CLI wiring

`src/cli/index.ts` gets a new `route-intake` command, options `--apply` and
an optional `--config <path>` override, following the existing command
registration pattern used for `triage-intake`.

### Tests (`tests/cli/commands/routeIntake.test.ts`)

Following the `triageIntake.test.ts` fixture pattern (`makeRoot`,
`writeIntakeFile`-equivalent helpers writing directly into
`intake-manifest.json` for this command, since it consumes the manifest
rather than walking `intake/`):

1. Single unambiguous match (`sourcePath` contains one topic's keyword) →
   assigned to that topic, dry-run leaves `topics/` untouched, report file
   written with the correct assignment.
2. No keyword matches any topic → `unsorted`, `ambiguousCount` unaffected.
3. Two different topics' keywords both match → `unsorted`,
   `ambiguousCount` incremented, and the report marks that entry
   `ambiguous: true`.
4. `failed`-status entries are excluded from `totalConsidered` and the
   report entirely.
5. `--apply` copies a matched file into
   `topics/charlie/<topic>/_staging-intake-<date>/<name>`, original file
   in `intake/` untouched (still exists, unchanged content).
6. `--apply` with a filename collision (two matched entries with the same
   basename) — both land in the staging directory under distinct names
   (hash-suffixed), neither overwrites the other.
7. `--apply` never creates a staging directory for `unsorted` files.
8. Missing `topic-routing.json` → throws a clear error, no partial report
   written.
9. Malformed (invalid JSON) `topic-routing.json` → throws a clear error.

## Error handling

- Missing/malformed config file: throw before any manifest reading, with a
  message naming the expected path.
- A file listed in the manifest that no longer exists on disk at `--apply`
  time (deleted since triage ran): skip with a console warning, don't
  crash the whole run; note it in the report as a distinct status rather
  than silently dropping it.

## Out of scope / explicitly deferred

- Content/OCR-based classification.
- Auto-creating vault topic nodes (`willys-overland` needs `trm create`
  run separately first).
- Invoking `ingest-dir` automatically.
- Expanding beyond the 7 topics agreed here (`rouge`, `copenhagen`,
  `maine-maritime-museum` were noticed during the treatment-doc scan but
  explicitly deferred — not part of this pass).
