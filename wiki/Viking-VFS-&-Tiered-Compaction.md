# Viking Virtual File System (VFS) & Tiered Compaction

The `viking://` virtual filesystem provider implements a high-speed SQLite Write-Ahead Logging (WAL) state machine and AST skeletonizer designed to reduce agent token overhead by up to 94.5% during codebase exploration and knowledge synthesis.

---

## Architecture Overview

![Viking VFS: three-tier resolution & AST skeletonization](viking-vfs-architecture.png)

<details>
<summary>Mermaid source (kept for editing — the image above is what renders on the wiki)</summary>

```mermaid
flowchart LR
    classDef inputStyle fill:#1e293b,stroke:#64748b,stroke-width:2px,color:#f8fafc;
    classDef stageStyle fill:#0f172a,stroke:#38bdf8,stroke-width:2px,color:#f8fafc;
    classDef compStyle fill:#312e81,stroke:#a855f7,stroke-width:2px,color:#f8fafc;
    classDef modeStyle fill:#064e3b,stroke:#34d399,stroke-width:2px,color:#f8fafc;

    URI["1. viking:// URI Request<br/>(vfs_read_file / vfs_search)"]:::inputStyle --> WAL["2. SQLite WAL Database<br/>(knowledge.db / FTS5 BM25)"]:::stageStyle
    
    WAL --> L0["L0 Abstract Tier<br/>(Summary ~94.5% cut)"]:::stageStyle
    WAL --> L1["L1 Overview & AST Skeleton<br/>(Signatures 48.5%-90% cut)"]:::compStyle
    WAL --> L2["L2 Full Raw Source<br/>(Full Payload 0% cut)"]:::stageStyle

    L1 --> T1["T1: TypeScript Compiler API<br/>(Compacted Skeleton)"]:::compStyle
    L1 --> T2["T2: Graft CLI Integration<br/>(graft skeleton)"]:::stageStyle
    L1 --> T3["T3: Regex Scraper<br/>(Signature Header Scrape)"]:::stageStyle

    T1 --> EXP["Exploration Mode<br/>([explore] / .claude-explore.md)"]:::modeStyle
    L2 --> REF["Refactor Mode<br/>([refactor] / .claude-refactor.md)"]:::modeStyle
```

</details>

---

## Resolution Tiers

| Tier | Contents & Format | Ideal Usage | Token Impact |
| :--- | :--- | :--- | :--- |
| **`L0`** | Summary / Purpose / First-sentence concept abstract | Repository survey, topic listing, concept searching | **~94.5% reduction** |
| **`L1`** | AST Skeleton (interfaces, exported types, method contracts with bodies replaced by error traps) | Code comprehension, interface contracts, module boundary analysis | **~48.5% - 90% reduction** |
| **`L2`** | Raw file content (bit-for-bit full implementation) | Active refactoring, line-level editing, execution tests | **0% reduction (Full)** |

---

## Three-Tier AST Skeletonizer Fallback Engine

When resolving code files under `L1`, `viking-vfs-mount.mjs` applies a fail-soft three-tier fallback pipeline:

1. **Tier 1: Native TypeScript Compiler API**: Performs syntactic diagnostics, builds an AST, and transforms all function declarations, expressions, class methods, constructors, accessors, and arrow functions by replacing their bodies with a deterministic halt trap (`throw new Error("[COMPACTED SKELETON: IMPLEMENTATION STRIPPED - DO NOT EXECUTE]")`).
2. **Tier 2: Graft CLI Integration**: Triggers `graft skeleton <targetFile>` if TypeScript compiler API is unavailable.
3. **Tier 3: Regex Signature Scraper**: Zero-dependency fallback scanning classes, interfaces, types, and exported signatures.

---

## Operational Modes

| Mode | Trigger | Strategy |
| :--- | :--- | :--- |
| **Exploration Mode** | `[explore]` or `.claude-explore.md` | Use `viking://` `L0`/`L1` compaction. Avoid loading full `L2` details until edit targets are isolated. |
| **Refactor Mode** | `[refactor]` or `.claude-refactor.md` | Skip `L0`/`L1`. Load files directly at `L2`. Minimize roundtrips and preserve cache prefix stability. |
| **Direct Execution** | `npm test` / CLI commands | Run directly against raw disk files. |
