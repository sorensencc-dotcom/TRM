<!--
title: "NotebookLM & Mining Pipeline"
status: active
owner: chris
last-reviewed: 2026-09-26
brand: cic
-->

# NotebookLM & Mining Pipeline

**Type:** Architecture & Integration Guide  
**Domain:** trm | notebooklm | mining | triage  
**Status:** Active  
**Last Updated:** 2026-08-23 via Log entry [[SemanticUpdateDate]]

---

## Definition

The NotebookLM & Mining Pipeline integrates TRM with Google NotebookLM research notebooks. It automates the retrieval of curated notebook sources, note extraction, and continuous questioning to unearth unknown research gaps and feed the `topic.pack.v1` task generator.

---

## Why It Matters

Google NotebookLM provides deep grounded query capabilities across large document sets. Linking NotebookLM into TRM ensures that manual research insights automatically propagate into structured research task specifications (`research.task.v1`), establishing continuous feedback between high-level notebook analysis and atomic extraction workers.

---

## Architecture & Flow Diagram

![TRM NotebookLM mining architecture: CLI request, grounded MCP query client, novelty filter, and task specification output.](notebooklm-mining.png)

<details>
<summary>Mermaid source (kept for editing — the image above is what renders on the wiki)</summary>

```mermaid
flowchart TD
    classDef clientStyle fill:#FAF6F0,stroke:#1A1410,stroke-width:2px,color:#1A1410;
    classDef engineStyle fill:#FAF6F0,stroke:#B8922A,stroke-width:2px,color:#1A1410;
    classDef mcpStyle fill:#FAF6F0,stroke:#C4501A,stroke-width:2px,color:#1A1410;
    classDef outStyle fill:#F5F0E6,stroke:#1A1410,stroke-width:2px,color:#5C5349;

    subgraph Client["1. Ingestion & Mining Request"]
        CLI_REQ["CLI / Task Scheduler<br/>(trm mine-notebooklm)"]:::clientStyle
        MINER_ENGINE["TRM Mining Orchestrator"]:::engineStyle
        CLI_REQ --> MINER_ENGINE
    end

    subgraph NotebookLM["2. Grounded MCP Query Engine"]
        MCP_SERVER["NotebookLM MCP Client"]:::mcpStyle
        NBLM_NOTEBOOK[("Google NotebookLM<br/>(Sources, Notes, Citations)")]:::mcpStyle

        MINER_ENGINE -->|Dispatch Question Matrix| MCP_SERVER
        MCP_SERVER <--> NBLM_NOTEBOOK
    end

    subgraph Processing["3. Novelty Detection & Deduplication"]
        DEDUP["Novelty Filter & Delta Check"]:::engineStyle
        MCP_SERVER -->|Grounded Answers| DEDUP
    end

    subgraph Outputs["4. Research Gap & Task Generation"]
        GAP_FILE["Research Gaps Matrix<br/>(trm-research-gaps.md)"]:::outStyle
        TASK_SPEC["Topic Pack Task Specs<br/>(specs/task-*.json)"]:::outStyle
        TRIAGE_QUEUE["_kb-sync-staging/<br/>(Staged Review Queue)"]:::outStyle

        DEDUP --> GAP_FILE
        DEDUP --> TASK_SPEC
        DEDUP --> TRIAGE_QUEUE
    end
```

</details>

---

## Ingestion (`trm ingest-notebooklm`)

The `ingest-notebooklm` command retrieves sources, generated notes, and citations from a registered Google NotebookLM notebook:

```bash
trm ingest-notebooklm "018f4a56-789a-bcde-f012-3456789abcde" \
  --narrative-root ./vault/topics
```

Key capabilities:
- **Incremental Synchronization**: Only new or modified notebook documents are downloaded.
- **Citation Anchoring**: Retains direct links between synthesized notes and raw source spans.
- **Semantic Classification**: Automatically classifies and routes notebook sources to matching topic packs (`topic.pack.v1`).

---

## Question Mining (`trm mine-notebooklm`)

The `mine-notebooklm` command executes targeted research batteries against NotebookLM:

```bash
trm mine-notebooklm "018f4a56-789a-bcde-f012-3456789abcde" \
  --slug "cic-kb"
```

1. **Battery Execution**: Runs who, what, when, where, and why query matrices.
2. **Severity Tagging**: Classifies surfaced ambiguities into severity tiers (`CRITICAL`, `HIGH`, `MEDIUM`, `LOW`).
3. **Gap Matrix Append**: Writes new findings to `trm-research-gaps.md` for automated triage.

---

## Cross-References

- See [[Closed Loop Gap Triage & RFC Synthesis]] for triage loop processing
- See [[CLI Reference & Commands]] for `mine-notebooklm` syntax
- See [[Architecture & Data Model]] for `topic.pack.v1` task specs
