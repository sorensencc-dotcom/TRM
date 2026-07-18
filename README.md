# trm — Topic Research Module

CLI for building hierarchical, lineage-tracked research topic trees on the local filesystem. Ingest sources, extract facts, score/promote topics, crosslink related work — all as versioned JSON+text under a topic-tree root, with an append-only operation log per node.

## Why

Research work (source PDFs, extracted facts, scoring, crosslinks between topics) needs an audit trail and a stable on-disk shape, but doesn't belong committed into a public git repo alongside code. `trm` gives that structure a CLI and enforces, in code, that its data root is never inside a repo with a remote configured.

## Install

```bash
git clone https://github.com/sorensencc-dotcom/TRM.git trm
cd trm
npm install
npm run build
```

Run via the built CLI:

```bash
node dist/cli/index.js <command> ...
```

Or during development, without building:

```bash
npm run trm -- <command> ...
```

## Safety guardrail

Every command call runs `assertSafeRoot(process.cwd())` first (`src/core/rootSafety.ts`). It walks up from the current directory looking for a `.git` folder; if one is found **and** its `config` has a `[remote "..."]` section, the command refuses to run:

```text
trm refuses to run: "<cwd>" is inside a git repository at "<repo>"
that has a remote configured. TRM data must never risk being
committed/pushed to a remote. Move the data outside this repo,
or set TRM_ALLOW_GIT_ROOT=1 to override.
```

No `.git` found, or `.git` found with no remote (e.g. a local-only vault repo), both pass silently. Override with `TRM_ALLOW_GIT_ROOT=1` if you're certain.

## Data model

Run commands from inside a **root** directory (a local-only, non-remote git repo works well). Topics live under `topics/<path>/...` as slash-separated paths (e.g. `charlie/cuba`). Each topic node directory contains:

```text
topics/charlie/cuba/
  topic.json           # metadata: version, actors, tags, status, node_type
  sources/
    raw/SRC-NNN.txt     # ingested source text
    metadata.json        # per-source origin/type/url
  extracts/
    extract.json          # extracted facts
    score.json             # scoring output
    summary.md              # human-readable summary
  lineage/
    lineage.json             # append-only operation log (CREATE, INGEST, EXTRACT, SCORE, ...)
  crosslinks/                 # links to related topics
```

`node_type` is derived from path depth: `project` → `topic` → `subtopic`.

## Commands

| Command | Purpose |
| --- | --- |
| `trm create <path> [--actor] [--description] [--tags a,b,c]` | Create a topic node (and any missing ancestor containers). |
| `trm ingest <path> <url> --type <t> --title <t> --origin <o> [--actor] [--dry-run]` | Ingest a source into a topic. |
| `trm extract <path> [--actor] [--dry-run] [--stub]` | Extract facts from ingested sources. |
| `trm score <path> [--actor] [--dry-run] [--rollup]` | Score a topic (optionally rolling scores up to ancestors). |
| `trm crosslink <path> [--actor] --related-topic <p> [--relationship] [--treatment-sections] [--promotion-reason]` | Record a relationship to another topic. |
| `trm version-bump <path> <major\|minor\|patch> [--actor]` | Bump a topic node's semver `version`. |
| `trm validate <path> [--recursive]` | Validate a topic node's on-disk shape; exits non-zero if any node is invalid. |

All commands take an implicit root of `process.cwd()`. All mutating commands write an entry to that node's `lineage/lineage.json`.

## Config

A `config.json` at the root controls defaults (`TrmConfig` in `src/core/types.ts`):

```json
{
  "default_scoring_adapter": "...",
  "promotion_threshold": 0.0,
  "actor_source": "env",
  "time_source": "system"
}
```

## Development

```bash
npm test          # jest — unit tests, tmpdir-isolated, no dependency on any real root
npm run typecheck  # tsc --noEmit
npm run build      # tsc -> dist/
```

Tests live in `tests/`, mirroring `src/`. `assertSafeRoot` itself is covered in `tests/core/rootSafety.test.ts` against real ephemeral git repos (with/without a remote), not mocks.
