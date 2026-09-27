---
title: "Deployment & Automation"
status: active
owner: chris
last-reviewed: 2026-09-26
brand: cic
---

# Deployment & Automation

**Type:** Workflow & Operations Guide  
**Domain:** trm | deployment | automation  
**Status:** Active  
**Last Updated:** 2026-08-23 via Log entry [[SemanticUpdateDate]]

---

## Definition

The TRM Deployment & Automation subsystem manages background task execution, daemon scheduling, and staging export synchronization. It provisions recurring Windows Task Scheduler tasks and handles zero-collision mining passes across local topic packs (`topic.pack.v1`).

---

## Why It Matters

Manual research mining and extraction quickly introduce operational bottlenecks. By automating background mining daemons and export pipelines, TRM ensures continuous gap discovery, automated staging into `_kb-sync-staging/`, and systematic synchronization with canonical knowledge bases without manual operator intervention.

---

## Architecture & Flow Diagram

![TRM deployment and automation architecture: Windows Task Scheduler, concurrency lock, notebooklm miner, export script, and kb-sync context cache.](deployment-automation.png)

<details>
<summary>Mermaid source (kept for editing — the image above is what renders on the wiki)</summary>

```mermaid
flowchart TD
    classDef daemonStyle fill:#1e293b,stroke:#64748b,stroke-width:2px,color:#f8fafc;
    classDef execStyle fill:#0f172a,stroke:#38bdf8,stroke-width:2px,color:#f8fafc;
    classDef lockStyle fill:#312e81,stroke:#a855f7,stroke-width:2px,color:#f8fafc;
    classDef exportStyle fill:#064e3b,stroke:#34d399,stroke-width:2px,color:#f8fafc;

    subgraph Scheduler["1. Task Scheduling"]
        SCHED["Windows Task Scheduler<br/>(Recurring Cron / Daily 2:00 AM)"]:::daemonStyle
        WRAPPER["PowerShell Wrapper<br/>(schedule-task-wrapper-*.ps1)"]:::daemonStyle
        SCHED --> WRAPPER
    end

    subgraph Engine["2. Safe Mining Execution"]
        LOCK["Concurrency Lock<br/>(.sync-treatment.lock)"]:::lockStyle
        MINER["NotebookLM Mining Engine<br/>(trm mine-notebooklm)"]:::execStyle
        WRAPPER --> LOCK
        LOCK --> MINER
    end

    subgraph Staging["3. Staging Export & KB Sync"]
        EXPORT["Export Script<br/>(triage:export:staging)"]:::exportStyle
        STAGED_DIR["Staging Directory<br/>(_kb-sync-staging/)"]:::exportStyle
        KB_DB[("kb-sync Context Cache<br/>(knowledge.db)")]:::exportStyle

        MINER --> EXPORT
        EXPORT --> STAGED_DIR
        STAGED_DIR --> KB_DB
    end
```

</details>

---

## Windows Task Scheduler Registration

TRM includes `schedule-task-wrapper-TRM-Notebooklm-Mine.ps1` for background execution. Register the mining daemon with PowerShell:

```powershell
$action = New-ScheduledTaskAction -Execute "PowerShell.exe" `
  -Argument "-ExecutionPolicy Bypass -File C:\dev\trm\schedule-task-wrapper-TRM-Notebooklm-Mine.ps1"

$trigger = New-ScheduledTaskTrigger -Daily -At 2am

Register-ScheduledTask -TaskName "TRM-NotebookLM-Mining-Daemon" `
  -Action $action `
  -Trigger $trigger `
  -Description "Automated nightly TRM NotebookLM gap mining and triage"
```

---

## Staging Export Pipeline (`triage:export:staging`)

Export mined facts and research extractions into the `kb-sync` staging area:

```bash
npm run triage:export:staging
```

1. Reads verified extractions under `topics/{topic_slug}/_kb-sync-staging/`.
2. Formats structured research notes with canonical YAML frontmatter.
3. Transports staged records into `kb-sync` for SQLite FTS5 index update.

---

## Cross-References

- See [[Architecture & Data Model]] for `topic.pack.v1` staging layout
- See [[CLI Reference & Commands]] for CLI argument options
- See [[Closed Loop Gap Triage & RFC Synthesis]] for RFC drafting integration
