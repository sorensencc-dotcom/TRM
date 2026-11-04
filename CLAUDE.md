# TRM (Topic Research Module)

## What this repo is

TRM is a Node.js / TypeScript CLI (`trm`) for building hierarchical, lineage-tracked research topic trees on the local filesystem. It ingests sources, extracts facts, scores and promotes topics, and crosslinks related work. It stores everything as versioned JSON and text, with an append-only operation log per node. It also holds the NotebookLM mining pipelines, multimodal ingestion (PDF, DOCX, EPUB, image, video), the PPP entity-matching tools, and the Viking VFS compaction scripts.

## Where things live

- `README.md`: install, command table, data model, env vars, safety guardrail.
- `src/cli/index.ts`: CLI entry point (commander). The `trm` bin points at `dist/cli/index.js`.
- `src/cli/commands/`: one file per command, e.g. `create.ts`, `ingest.ts`, `ingestDir.ts`, `extract.ts`, `score.ts`, `crosslink.ts`, `validate.ts`, `versionBump.ts`, `triageIntake.ts`, `routeIntake.ts`, `ingestNotebooklm.ts`, `mineNotebooklm.ts`, `researchNotebooklm.ts`, `pppMatch.ts`, `evalWhichllm.ts`.
- `src/core/`: topic nodes, paths, config, atomic writes, manifests, raw-source envelope, and `rootSafety.ts` (the `assertSafeRoot` guardrail).
- `src/ingestion/`: `urlFetch.ts`, `epubExtract.ts`, `fileConvert.ts`, `imageExtract/`, `videoExtract/`.
- `src/extraction/`: fact extraction runners and prompts.
- `src/scoring/`: scoring adapters and types.
- `src/lineage/`, `src/crosslinks/`, `src/registry/`, `src/sync/`: lineage hashing, crosslinks, actor registry, and sync-treatment logic.
- `src/notebooklm/`: NotebookLM CLI wrapper, registry, chat archiver, run reports.
- `src/ppp/`: PPP entity matcher, match review output, gap registry, span hashing, pack gate, topic isolation.
- `src/protocol/`: research task and result validators, worker clients, replay.
- `src/research/`, `src/reporting/`, `src/telemetry/`, `src/whichllm/`: research evidence writer, HTML/export reports, telemetry, model evaluation.
- `src/schemas/`: JSON schemas (`topic.schema.json`, `extract.schema.json`, `lineage.schema.json`, etc.) and `validator.ts`.
- `tests/`: Jest tests. Most directories mirror `src/`. Also `tests/smoke/`, `tests/smoke.test.ts`, `tests/fixtures/`.
- `config/`: `topic-routing.json`, `mining-questions.json`, `operational-questions.json`, `phase4-canary-stage1.env`.
- `scripts/`: Node and PowerShell helpers, e.g. `secret-scan.mjs`, `verify-research-pipeline.mjs`, `viking-vfs-compact.mjs`, `vfs-to-knowledge-db.mjs`, `query-knowledge-db.mjs`, `sync-remote-wiki.mjs`.
- `scripts/git-hooks/` and `.githooks/pre-commit`: git hooks. `scripts/install-git-hooks.mjs` installs them via the `prepare` script.
- `deploy/`: deployment material (`DEPLOY.md`, `deploy/research-worker/`, phase 4 canary files).
- `docs/`: design docs (`viking-vfs-decision-tree.md`, `whichllm-evaluator.md`, `RESEARCH_WORKER_DEPLOYMENT.md`) plus `docs/superpowers/plans/` and `docs/superpowers/specs/`.
- `wiki/`: in-repo wiki (`Home.md`, `_Sidebar.md`, topic pages, diagram HTML/PNG triplets, `wiki/superpowers/`).
- `TODOS.md`, `STRAIN-LOG.md`: running work and strain logs. `.planning/scale-ingest/`: planning notes.
- Python utilities at the root: `scaffold_topic.py` and `topic_coverage_auditor.py`.

Not committed as project source: `.ijfw/` (tool state), `.context/` (retro JSON), `dist/` (build output).

## Build and test

Use only scripts that exist in `package.json`:

- `npm install`: install dependencies. The `prepare` script then runs `node scripts/install-git-hooks.mjs`.
- `npm run build`: `tsc`, output to `dist/`.
- `npm run typecheck`: `tsc --noEmit`.
- `npm test`: `jest`. To run one file: `npm test -- tests/smoke.test.ts --watchAll=false`.
- `npm run gov:smoke`: runs `npm test -- tests/smoke.test.ts --watchAll=false`.
- `npm run test:load`: ts-node load test for `src/ingestion/imageExtract/imageAnalyzer.load-test.ts`.
- `npm run secret-scan`: `node scripts/secret-scan.mjs`.
- `npm run trm -- <command> ...`: run the CLI via ts-node without building.
- `npm run triage:intake`, `npm run triage:export:staging`, `npm run eval:whichllm`: shortcuts for `triage-intake`, `triage-intake --export-staging=...`, and `eval-whichllm`.
- `npm run wiki:validate`, `wiki:publish`, `wiki:regen-cic`: wiki diagram validation, remote wiki sync, and CIC diagram regeneration.
- `npm run gov:validate`: runs `../CIC-GOVERNANCE/scripts/validate-governance-contract.mjs`, which lives in a sibling checkout. It fails if that checkout is absent.

Before finishing a change, run `npm run typecheck` and `npm test`. Tests use isolated temp directories and must not depend on a real topic root.

## Safety guardrail

Every command runs `assertSafeRoot(process.cwd())` first (`src/core/rootSafety.ts`). It refuses to run inside a git repo that has a remote configured. Do not bypass it with `TRM_ALLOW_GIT_ROOT=1` unless the user explicitly says so. Do not commit topic data (`topics/`, source text, extracts) to this repo. `.gitleaks.toml`, `.github/workflows/secret-scan.yml` and the pre-commit hook enforce secret scanning. Never commit real values from `.env`. Use `.env.example` as the template.

## Knowledge lookup

Before answering a question about this project, look it up in the knowledge base first, then fall back to reading code. Cite the file path you used in your answer.

1. Repo wiki. This repo has no `wiki/Index.md`. Start with `wiki/Home.md` and `wiki/_Sidebar.md`, then open the relevant topic page:
   - `wiki/Architecture-&-Data-Model.md`
   - `wiki/CLI-Reference-&-Commands.md`
   - `wiki/Multimodal-Ingestion-&-Media-Pipeline.md`
   - `wiki/NotebookLM-&-Mining-Pipeline.md`
   - `wiki/Closed-Loop-Gap-Triage-&-RFC-Synthesis.md`
   - `wiki/Viking-VFS-&-Tiered-Compaction.md`
   - `wiki/Security-Guardrails-&-Root-Safety.md`
   - `wiki/Deployment-&-Automation.md`
2. Cross-repo lookup. Use the `kb-sync` MCP server.
   - `query_context_cache`: search the cached context for a topic.
   - `fetch_topic_note`: fetch the full note for a topic returned by the search.
3. Design history. `docs/superpowers/specs/` holds designs and `docs/superpowers/plans/` holds implementation plans, both dated by filename.
4. Command behavior and flags. Read `README.md`, then `src/cli/index.ts` and `src/cli/commands/`.

If the KB and the code disagree, say so and cite both paths. The code wins for current behavior.

## Procedures

There are no `skills/` or `.claude/skills/` directories in this repo. These runbooks exist:

- Deployment: `deploy/DEPLOY.md`.
- Phase 4 stage 1 canary: `deploy/PHASE4-STAGE1-CHECKLIST.md`, with `deploy/phase4-stage1-canary.yaml` and the `deploy/phase4-stage1-deploy.sh` / `.ps1` scripts.
- Research worker (Kubernetes): `deploy/research-worker/K8S_DEPLOYMENT_GUIDE.md` and `docs/RESEARCH_WORKER_DEPLOYMENT.md`.
- Viking VFS compaction: `docs/viking-vfs-decision-tree.md` and `wiki/Viking-VFS-&-Tiered-Compaction.md`.
- Model evaluation: `docs/whichllm-evaluator.md`.
- Wiki diagrams and publishing: `npm run wiki:validate`, `npm run wiki:regen-cic` and `npm run wiki:publish`. See `wiki/Deployment-&-Automation.md`.
- Per-agent git worktrees: `scripts/agent-worktree.ps1` (self-test: `scripts/test-agent-worktree.ps1`).
- On-demand NotebookLM mining and the scheduled chat archive: `scripts/run-ondemand-mine.ps1` and `scripts/register-chat-archive-task.ps1`.
- Adding a feature: write a spec in `docs/superpowers/specs/` and a plan in `docs/superpowers/plans/` (date-prefixed, following the existing files), then implement with tests under `tests/`.

## Conventions

- TypeScript, CommonJS (`"type": "commonjs"`), compiled with `tsc` per `tsconfig.json`. Tests use ts-jest (`jest.config.cjs`).
- Put new command logic in `src/cli/commands/<name>.ts` and register it in `src/cli/index.ts`.
- Mutating commands must append a lineage entry to the node's `lineage/lineage.json`.
- Match existing line endings in a file. A recent commit restored the original line endings in `src/cli/index.ts`.
- Keep changes small and tested. Do not commit `dist/`, `.env`, or topic data.

<!-- Auto-generated by IJFW from repo scan. Edit freely -- IJFW only touches the managed block below. -->

<!-- IJFW-MEMORY-START (managed -- do not edit manually) -->
<ijfw-memory>
Project memory at .ijfw/memory/. Call `ijfw_memory_prelude` for full context.
</ijfw-memory>

<ijfw-routing>
IJFW is installed alongside a peer brainstorming skill. For project-level tasks (build, create, design, plan, brainstorm, landing page, app, website, dashboard, campaign, book, launch), prefer the ijfw:ijfw-workflow skill -- the user opted into IJFW via install, and ijfw-workflow is its configured workflow entry point. IJFW orchestrates think-build-ship end to end and dispatches peer specialist skills (frontend-design, TDD, code-review) as subagent tools when the workflow needs them.
</ijfw-routing>
<!-- IJFW-MEMORY-END -->
