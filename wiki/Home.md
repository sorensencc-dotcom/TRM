---
title: "Topic Research Module (TRM) Wiki"
status: active
owner: chris
last-reviewed: 2026-09-26
brand: cic
---

# Topic Research Module (TRM) Wiki

Welcome to the canonical engineering and operational documentation for the **Topic Research Module (TRM)**.

TRM is an enterprise-grade CLI and autonomous ingestion system for building hierarchical, lineage-tracked research topic trees on the local filesystem. It powers source ingestion, multimodal media processing, fact extraction, topic scoring/promotion, cross-linking, and closed-loop research gap triage across the federated Cast Iron Charlie (CIC) knowledge ecosystem.

---

## 🧭 Navigation & Knowledge Base Index

### 📐 Architecture & Core Principles
* [[Architecture & Data Model]] — Topic tree hierarchy, node directory contracts (`topic.json`, `sources/`, `extracts/`, `lineage/`), append-only operation logs, and scoring mechanics.
* [[Security Guardrails & Root Safety]] — `assertSafeRoot` zero-trust protection preventing research data leakage to public git remotes.

### 🛠️ Operations & CLI Guides
* [[CLI Reference & Commands]] — Complete reference for `trm create`, `ingest`, `extract`, `score`, `crosslink`, `version-bump`, and `validate`.
* [[Multimodal Ingestion & Media Pipeline]] — Image OCR/Vision analysis, ffmpeg video frame extraction, and whisper.cpp local audio transcription.
* [[NotebookLM & Mining Pipeline]] — Autonomous NotebookLM ingestion, question mining, and automated research gap extraction.

### 🔄 Integrations & Closed-Loop Governance
* [[Closed-Loop Gap Triage & RFC Synthesis]] — SQLite context cache integration (`kb_fts`, BM25), automated triage engine, and RFC synthesis.
* [[Deployment & Automation]] — Scheduled tasks, Windows Task Scheduler wrappers, environment configuration, and staging exports.

---

## ⚡ Quick Architecture Overview

![TRM architecture: source pinning, topic pack v1 layout, audit rules, operator gate, and staging sync.](architecture.png)

<details>
<summary>Mermaid source (kept for editing — the image above is what renders on the wiki)</summary>

```mermaid
flowchart TD
    classDef inputStyle fill:#1e293b,stroke:#64748b,stroke-width:2px,color:#f8fafc;
    classDef stageStyle fill:#0f172a,stroke:#38bdf8,stroke-width:2px,color:#f8fafc;
    classDef packStyle fill:#1e1b4b,stroke:#818cf8,stroke-width:2px,color:#f8fafc;
    classDef gateStyle fill:#312e81,stroke:#a855f7,stroke-width:2px,color:#f8fafc;
    classDef syncStyle fill:#064e3b,stroke:#34d399,stroke-width:2px,color:#f8fafc;

    subgraph Sources["1. Source Ingestion & Pinning"]
        S_RAW["Raw Corpora & Transcripts<br/>(PDF, Text, Media, NotebookLM)"]:::inputStyle
        S_PIN["TRM Source Pinning<br/>(SHA-256 Digest Computation)"]:::stageStyle
        S_RAW --> S_PIN
    end

    subgraph Scaffolder["2. TRM Automated Scaffolding (topic.pack.v1)"]
        PACK_DEC["Task Decomposition<br/>(research.task.v1 specs)"]:::stageStyle
        PACK_AUD["Audit Rule Synthesis<br/>(Temporal bounds & over-claim triggers)"]:::stageStyle
        S_PIN --> PACK_DEC
        PACK_DEC --> PACK_AUD
    end

    subgraph Layout["3. Standardized Topic Pack Layout"]
        direction TB
        MANIFEST["topic.manifest.json<br/>(Domain & Metadata)"]:::packStyle
        CATALOG["corpus/source_catalog.json<br/>(Immutable Hashes)"]:::packStyle
        TASKS["specs/task-*.json<br/>(research.task.v1)"]:::packStyle
        AUDIT_CFG["config/audit_rules.json<br/>(Adversarial Rules)"]:::packStyle
        STAGING["_kb-sync-staging/<br/>(Canonical & Review Queues)"]:::packStyle
    end

    PACK_AUD --> Layout

    subgraph Gate["4. Execution & Audit Gate"]
        HUMAN_GATE["Operator Approval Gate<br/>(Task boundary review)"]:::gateStyle
        WORKER["Ollama / Claude Workers<br/>(Fact Extraction)"]:::stageStyle
        AUDIT_API["Adversarial /api/audit<br/>(Temporal & entity validation)"]:::stageStyle
        
        HUMAN_GATE --> WORKER
        WORKER --> AUDIT_API
    end

    Layout --> HUMAN_GATE

    subgraph KB["5. Staging & Knowledge Base Sync"]
        STAGED_QUEUE["_kb-sync-staging/staged_review_queue.json"]:::syncStyle
        CANONICAL["kb-sync / Obsidian Vault<br/>(Canonical Knowledge Base)"]:::syncStyle
        
        AUDIT_API --> STAGED_QUEUE
        STAGED_QUEUE --> CANONICAL
    end
```

</details>

---

## 🔒 The Core Security Guarantee

Research artifacts (raw audio, transcribed video, internal source PDFs, proprietary notes) must never risk being committed or pushed to a public remote repository. 

Every TRM command enforces an immutable `assertSafeRoot` guardrail:
1. TRM traverses upward from the working directory to locate `.git`.
2. If a `.git` configuration contains a remote (`[remote "..."]`), execution terminates immediately with non-zero exit code.
3. Research data remains strictly contained in local vaults or non-remote repositories.
