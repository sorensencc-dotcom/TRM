---
title: "CLI Reference & Commands"
status: active
owner: chris
last-reviewed: 2026-09-26
brand: cic
---

# CLI Reference & Commands

The `trm` command-line interface provides tools for creating topic trees, ingesting raw and structured media, running fact extraction, calculating scores, managing semver versions, and validating repository conformance.

---

## Command Matrix

| Command | Signature | Description |
| :--- | :--- | :--- |
| `scaffold-topic` | `trm scaffold-topic <slug> [options]` | Provisions a standardized topic.pack.v1 harness, SHA-256 corpus, specs, and audit rules. |
| `create` | `trm create <path> [options]` | Creates a topic node and all missing parent containers. |
| `ingest` | `trm ingest <path> <url/file> [options]` | Ingests a single document or URL into the topic source directory. |
| `ingest-dir` | `trm ingest-dir <dir> [options]` | Recursively ingests a folder of files (PDF, images, video, text). |
| `ingest-notebooklm` | `trm ingest-notebooklm <id> [options]` | Ingests sources, notes, and citations from Google NotebookLM. |
| `mine-notebooklm` | `trm mine-notebooklm <id> [options]` | Runs targeted research gap questions against NotebookLM. |
| `extract` | `trm extract <path> [options]` | Extracts key entities, facts, and claims from raw sources. |
| `score` | `trm score <path> [options]` | Evaluates topic completeness and optionally rolls up to ancestors. |
| `crosslink` | `trm crosslink <path> --related-topic <p>` | Records semantic relationships between topics. |
| `version-bump` | `trm version-bump <path> <major\|minor\|patch>` | Increments a node's semver version in `topic.json`. |
| `validate` | `trm validate <path> [--recursive]` | Asserts directory structure and JSON schema compliance. |

---

## Detailed Command Specifications

### 1. `trm create`
Creates a topic node and writes initial `topic.json`, `sources/metadata.json`, and `lineage/lineage.json`.

```bash
trm create charlie/cuba/havana \
  --actor "soren" \
  --description "Havana intelligence operations" \
  --tags "cuba,espionage,havana"
```

### 2. `trm ingest`
Ingests an individual file or web source, assigning an immutable `SRC-NNN` identifier and calculating SHA-256 content hashes.

```bash
trm ingest charlie/cuba ./documents/declassified-log.txt \
  --type "document" \
  --title "1958 Declassified Havana Field Log" \
  --origin "national-archives" \
  --actor "soren"
```

### 3. `trm ingest-dir`
Scans a directory recursively and ingests supported media types (Text, PDF, Images via OCR, Videos via ffmpeg, Audio via whisper.cpp).

```bash
trm ingest-dir ./raw-media/willow-run \
  --target-path ww2/aviation/bombers/willow-run \
  --concurrency 8
```

### 4. `trm ingest-notebooklm`
Pulls sources, generated notes, and citations from a registered Google NotebookLM notebook ID and routes them to target topics.

```bash
trm ingest-notebooklm "018f4a56-789a-bcde-f012-3456789abcde" \
  --narrative-root ./vault/topics
```

### 5. `trm mine-notebooklm`
Executes systematic gap queries against a NotebookLM notebook and appends synthesized answers to `research-gaps/<slug>.md`.

```bash
trm mine-notebooklm "018f4a56-789a-bcde-f012-3456789abcde" \
  --slug "cic-kb" \
  --export-todos
```

### 6. `trm extract`
Runs fact and entity extraction against `sources/raw/*.txt`, producing `extracts/extract.json` and updating `extracts/summary.md`.

```bash
trm extract charlie/cuba --actor "agent-codex"
```

### 7. `trm score`
Scores topic completeness based on source density, entity count, and crosslinks.

```bash
trm score charlie/cuba --rollup
```

### 8. `trm validate`
Validates that every topic node strictly adheres to schema contracts and contains valid JSON, source files, and lineage logs.

```bash
trm validate charlie --recursive
```
