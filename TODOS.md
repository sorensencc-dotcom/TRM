# Project TODOs

## AST-based Signature Extraction for Viking VFS
- **What:** Integrate Tree-sitter or TypeScript compiler API for deep method signature and generic type extraction in L1 overview tier.
- **Why:** Replaces regex pattern heuristics with a full concrete AST grammar to handle complex multiline generics, type aliases, and interface inheritance trees.
- **Pros:** Full syntax tree fidelity for complex type definitions.
- **Cons:** Adds parser dependency and slight memory footprint.
- **Context:** Currently iking-vfs-mount.mjs handles standard class/interface/function signatures in single-pass regex.
- **Depends on:** Baseline Viking VFS mount and test harness stabilization.

