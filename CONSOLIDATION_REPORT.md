# Consolidation Report — Tourist v2 Integration Branch

Written after merging Agent A/D's `main` (36a2c1b), Agent B's
`ao/tourist-3/root` (958213c), and Agent C's `ao/tourist-4/root` (e48d34b)
into this integration branch (`ao/tourist-6/root`). See
`ORCHESTRATOR_HANDOFF.md` for the pre-consolidation status this report
supersedes.

## What merged cleanly

- All three branches' `src/` trees (`src/core/`, `src/adapters/`,
  `src/persistence/`, `src/vscode-integration/` + `src/extension.ts`),
  `spike/`, and `test/fixtures/` combined with **zero file-level conflicts**
  — the module-ownership boundaries in PLAN1.md Part 2 held exactly as
  designed.
- Root scaffold (`package.json`, `tsconfig.json`, `vitest.config.ts`,
  `.gitignore`, `package-lock.json`) was the only real conflict surface,
  resolved by using Agent C's manifest (the real VS Code extension
  contributes block) as the base, merging in Agent A/B's dependencies
  (`ignore`, `ps-list`) and scripts, and standardizing on **vitest** as the
  single test runner.

## What needed real reconciliation

1. **tsx → vitest port.** Agent A/D's 6 test files (`test/core/*.test.ts`,
   `test/fixtures/loader.test.ts`) used `node:test`'s `test`/`describe`;
   switched their imports to vitest's.
2. **`listTrackedDocIds`/`renameDocument` were claimed done but weren't.**
   ORCHESTRATOR_HANDOFF.md §7 reported these as needed fixes "already folded
   back into PLAN1.md," but `src/core/engine.ts` as committed had neither.
   Added both for real, and rewired `extension.ts`'s rename handler to call
   `engine.renameDocument` instead of its close+reopen workaround.
3. **Agent B's persistence used a different `AttributedRange` than Agent
   A's core.** Agent B's is line-based, fsPath-keyed, with
   `verified`/`inferred`/`heuristic` attribution tiers; Agent A's is
   offset-based, with `ai`/`human`/`external` origins and `1`/`2a`/.../`4`
   tiers — the two were never actually compatible, despite Agent C's
   `contracts.ts` mirroring a contract that assumed they were. Wrote
   `src/vscode-integration/persistence-adapter.ts` (`RealPersistenceAdapter`)
   to reconcile them via an explicit, documented offset↔line conversion and
   origin/tier mapping. Widened `PersistenceLike.load/save/rename` to pass
   the document's current text/key, since accurate per-range validation and
   the offset↔line conversion both need them.
4. **Mock-to-real swap.** `extension.ts` now constructs the real
   `AttributionEngine` and `RealPersistenceAdapter` instead of
   `MockAttributionEngine`/`MockPersistence`; `contracts.ts` re-exports real
   types from `src/core/index.ts` instead of hand-mirroring them.
5. **Manifest drift fixes.** Renamed `tourist.shareAttribution` →
   `tourist.gitNotesSync` throughout (`package.json`, `settings.ts`,
   `commands.ts`, `extension.ts`); removed the `tourist.fixLineAttribution`
   command and its QuickPick entry entirely, per PLAN1.md's scope narrowing.
6. **Flaky tests fixed.** `piece-table.test.ts` and `engine.test.ts` each
   compared two independently-constructed instances whose initial unmarked
   range's timestamp defaulted to `Date.now()` — a real (if narrow) race
   that failed intermittently across repeated runs. Pinned explicit
   timestamps / compared shape-only where a timestamp couldn't be injected.
7. **Second tsconfig for standalone emit.** Agent B's rewrite-continuity
   test needs a real compiled `dist/persistence/gitNotes/hookRunner.js` to
   invoke as a live git hook; the shared `tsconfig.json` is `noEmit: true`
   (Agent A/C's convention, paired with esbuild bundling). Added
   `tsconfig.build.json`, scoped to `src/persistence` only (the one subtree
   using Node16 `.js`-extension imports rather than Agent C's
   `.ts`-extension style), for real emit.

## Final status

- `tsc --noEmit -p .` — clean.
- `vitest run` — **183/183 tests passing**, confirmed clean across 5
  consecutive full-suite runs (to rule out the flakiness fixed above).
- `node esbuild.js` — produces `dist/extension.js` (~82KB bundled).
- `activate()` was smoke-tested against a hand-built `vscode` API shim
  (registers 19 subscriptions without throwing); this is **not** a
  substitute for a real Extension Development Host run, which nothing in
  this consolidation pass could perform.

## Remaining gaps — need a specific agent, not papered over

1. **Agent C**: `extension.ts` never constructs or starts any of Agent A's
   real Tier-1/Tier-2a adapters (`hook-log-reader`, `lock-file-watcher`,
   `workspace-watcher`, `shell-integration-bridge`). The real engine is
   wired in, but with no corroboration signal ever fed into it — every
   disk-write-while-clean event will currently fall through to Tier 3
   ("external/unknown") instead of being correctly corroborated as "ai."
2. **Agent A**: `src/adapters/workspace-watcher.ts` never calls
   `engine.setGitOpSuppression`, despite PLAN1.md Part 2 explicitly assigning
   that wiring internally to this adapter. Git checkout/rebase/stash
   suppression is implemented on the engine side but never triggered.
3. **Agent B + Agent C (joint)**: `writeNote`/`readNote` (commit-time
   attribution capture) have no real trigger anywhere in the codebase — no
   on-commit hook is wired to call them — and neither Agent B's
   `AttributionNote` schema nor Agent C's `AttributionNotePayload` carries a
   per-entry fsPath, so a commit touching multiple files has no way to
   disambiguate which file a note entry belongs to. This needs a schema
   decision before it can be wired for real.
4. **Agent D**: Phase 0 experiment 1 (Claude Code VS Code extension
   diff-accept mechanics) is still pending a human clicking through the
   Extension Development Host — unchanged by this consolidation, since no
   agent can perform that step.

## Push status

This branch (`ao/tourist-6/root`) is pushed to the `harshittomar0/Tourist`
remote by the repository owner via GitHub Desktop, due to a GitHub account
mismatch preventing `git push` from this environment. As of the last check,
the public repo's `main` reflected only the pre-consolidation commit
(`36a2c1b`); the merge and reconciliation commits documented above are
committed locally and awaiting that push.
