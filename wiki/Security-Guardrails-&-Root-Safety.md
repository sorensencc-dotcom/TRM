---
title: "Security Guardrails & Root Safety"
status: active
owner: chris
last-reviewed: 2026-09-26
brand: cic
---

# Security Guardrails & Root Safety

**Type:** Governance Rule & Security Pattern  
**Domain:** trm | security | guardrails  
**Status:** Active  
**Last Updated:** 2026-08-23 via Log entry [[SemanticUpdateDate]]

---

## Definition

The `assertSafeRoot` guardrail is TRM's zero-trust security assertion engine located in `src/core/rootSafety.ts`. Before executing any filesystem mutation, TRM verifies that the current working directory does not reside inside a Git repository configured with remote push URLs, preventing accidental data leaks.

---

## Why It Matters

Research topic packs (`topic.pack.v1`) ingest raw primary sources, declassified field logs, and internal interview transcripts. Without root safety enforcement, a developer or automated script could inadvertently commit and push sensitive research data to a public or corporate Git remote via standard `git push`.

---

## Architecture & Flow Diagram

![TRM security guardrails and root safety architecture: command invocation, assertSafeRoot inspection, git remote detection, and zero-trust gate.](security-guardrails.png)

<details>
<summary>Mermaid source (kept for editing — the image above is what renders on the wiki)</summary>

```mermaid
flowchart TD
    classDef initStyle fill:#1e293b,stroke:#64748b,stroke-width:2px,color:#f8fafc;
    classDef checkStyle fill:#0f172a,stroke:#38bdf8,stroke-width:2px,color:#f8fafc;
    classDef failStyle fill:#450a0a,stroke:#f87171,stroke-width:2px,color:#f8fafc;
    classDef passStyle fill:#064e3b,stroke:#34d399,stroke-width:2px,color:#f8fafc;

    subgraph Trigger["1. Command Invocation"]
        CMD["TRM Command Invoked<br/>(create, ingest, extract, score)"]:::initStyle
        ASSERT["Invoke assertSafeRoot(process.cwd())"]:::checkStyle
        CMD --> ASSERT
    end

    subgraph Inspection["2. Git Repository & Remote Inspection"]
        WALK["Walk Up Directory Tree<br/>(Search for .git folder)"]:::checkStyle
        PARSE_CFG["Parse .git/config<br/>(Inspect [remote '...'])"]:::checkStyle
        ENV_OVERRIDE{"TRM_ALLOW_GIT_ROOT == 1?"}:::checkStyle

        ASSERT --> WALK
        WALK -->|Found .git| PARSE_CFG
        PARSE_CFG -->|Remote Exists| ENV_OVERRIDE
    end

    subgraph Enforcement["3. Zero-Trust Enforcement Gate"]
        BLOCK_EXIT["TERMINATE EXECUTION<br/>(Exit Code != 0 & Display Alert)"]:::failStyle
        ALLOW_EXEC["ALLOW EXECUTION<br/>(Proceed with Topic Mutation)"]:::passStyle

        ENV_OVERRIDE -->|No| BLOCK_EXIT
        ENV_OVERRIDE -->|Yes| ALLOW_EXEC
        WALK -->|No .git Found| ALLOW_EXEC
        PARSE_CFG -->|No Remotes| ALLOW_EXEC
    end
```

</details>

---

## Supported Storage Configurations

| Storage Configuration | `assertSafeRoot` Result | Rationale |
| :--- | :--- | :--- |
| Standalone local directory (no `.git`) | **PASS** | No git repository present; zero leak risk. |
| Local-only Git vault (no remotes configured) | **PASS** | Local version control enabled without external push targets. |
| Repository with configured remote | **FAIL** | High leak risk. Data could be accidentally pushed via `git push`. |
| Repository with remote + `TRM_ALLOW_GIT_ROOT=1` | **PASS (Override)** | Explicit operator bypass. |

---

## Environment Override

Override root safety for public research repositories using environment variables:

```bash
export TRM_ALLOW_GIT_ROOT=1   # Linux / macOS
$env:TRM_ALLOW_GIT_ROOT="1"    # Windows PowerShell
```

> [!CAUTION]
> Enable `TRM_ALLOW_GIT_ROOT=1` only if no proprietary, classified, or copyrighted research assets reside in your topic tree.

---

## Cross-References

- See [[Architecture & Data Model]] for directory safety constraints
- See [[CLI Reference & Commands]] for command enforcement points
