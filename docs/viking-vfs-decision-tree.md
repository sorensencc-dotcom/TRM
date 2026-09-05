# Viking VFS Resolution Decision Tree

```
[Agent Query / File Request]
           │
           ▼
 Is this an Edit / Hotfix / Refactor Task?
          / \
    YES  /   \  NO
        /     \
       ▼       ▼
   [L2 Raw]   Is this a broad survey or initial discovery?
               / \
         YES  /   \  NO (Need structural boundaries & signatures)
             /     \
            ▼       ▼
       [L0 Abstract] [L1 AST Skeletonizer]
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
       TypeScript AST             Non-TS / Markdown
   (Stripped Function Bodies)    (Heading & Interface Outlines)
```

## Matrix of Resolution Tiers

| Tier | Format & Contents | Ideal Usage | Token Impact |
| :--- | :--- | :--- | :--- |
| **`L0`** | Summary / Purpose / First-sentence concept abstract | High-level repository survey, index listing, multi-document scanning | **~94.5% reduction** |
| **`L1`** | AST Skeleton (interfaces, exported types, function signatures with stripped bodies) | Code comprehension, interface contracts, module boundary analysis | **~48.5% - 90% reduction** |
| **`L2`** | Raw file content (bit-for-bit full implementation) | Active refactoring, line-level editing, execution tests | **0% reduction (Full)** |
