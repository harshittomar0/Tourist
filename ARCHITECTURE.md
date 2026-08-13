# Architecture

Tourist is a VS Code extension that attributes every line in your workspace to one of three
buckets — **AI** (Claude Code), **human** (you), or **external/unknown** (anything else) — live,
as you edit. This doc is a map of the codebase for someone landing in it for the first time. For
the product-level pitch and user-facing feature list, see `README.md`. For the reasoning behind
the design (why a 3-tier model, why external/unknown is a real bucket, what was deliberately cut
from v1), see `GOAL1.md`; for the phased build plan and the multi-agent execution model this
project was actually built with, see `PLAN1.md`.

## Directory tree

```
tourist/
├── src/
│   ├── core/                  Editor-agnostic detection engine (no `vscode` import)
│   ├── adapters/               Platform signal producers (hook log, lock file, shell, process, fs watch)
│   ├── persistence/             Local JSON store + opt-in git-notes sync
│   │   └── gitNotes/               Git-native storage submodule (notes plumbing, merge, rewrite continuity)
│   ├── vscode-integration/      UI: decorations, status bar, tree view, commands, settings
│   │   ├── knowledge-map/          Knowledge Map webview panel + analyser-CLI bridge
│   │   └── mocks/                  In-memory engine/persistence stand-ins used by tests
│   └── extension.ts             Activation entry point — the one file that wires everything together
├── hooks/
│   └── attribution-hook.mjs     Claude Code PreToolUse/PostToolUse hook script (Tier 1 ground truth)
├── test/
│   ├── core/, adapters/, vscode-integration/   Unit tests mirroring src/ (colocated pattern lives
│   │                                            partly here, partly as __tests__/ next to the code
│   │                                            it covers — see "Tests" below)
│   ├── fixtures/                 Synthetic scenario fixtures shared across unit + edge-case tests
│   └── e2e/                      Real Extension Development Host integration/E2E suite
├── ideation/knowledge-forest/   Knowledge Map feature's analyser CLI + standalone UI prototypes
├── spike/                       Phase 0 throwaway research extension + FINDINGS.md
├── website/                     Marketing/landing page (static HTML/CSS/JS, not part of the extension build)
├── GOAL1.md, PLAN1.md, RESEARCH1.md   Vision, build plan, and background research
└── REVIEW_JRDEV.md, REVIEW_SENIOR.md  Point-in-time code reviews (see "How this was built")
```

## `src/core/` — the detection engine

Pure TypeScript, deliberately free of any `vscode` import so it can be unit-tested with plain
fixtures and no editor. Key files:

- **`types.ts`** — shared shapes: `AttributedRange` (`startOffset`/`endOffset`/`origin`/`tier`/
  `timestamp`), `NormalizedChange`/`NormalizedChangeBatch` (the engine's input contract), and
  `WholeFileDiffInput` (the second ingestion path, for files with no open editor tab).
- **`piece-table.ts`** — the position-mapped range structure every edit is applied against (see
  "Piece table" below).
- **`tier-classifier.ts`** — the pure decision table that turns dirty-state + hook-match +
  corroboration signals into an `{origin, tier}` classification.
- **`engine.ts`** — `AttributionEngine`, the stateful class that owns one `PieceTable` per tracked
  document, feeds it change batches, and exposes `getRanges`, `open`/`close`/`save`/`reload`,
  `renameDocument`, `listTrackedDocIds`, and `setGitOpSuppression`.
- **`corroboration-store.ts`** — the shared map of "is there an active Claude Code signal for this
  workspace right now," written by the adapters and read by the tier classifier.
- **`snapshot-store.ts`** — lazily-seeded per-file content baselines, used by the whole-file-diff
  ingestion path to diff a closed file's new content against what was last seen.
- **`exclusion.ts`** — the `.gitignore` + default-excludes (`node_modules/`, build output, `.git/`)
  predicate that gates whether a file is tracked at all.
- **`hash.ts`**, **`line-diff.ts`** — small internal utilities (content hashing for undo/redo
  history; line-oriented diffing for the whole-file path).
- **`adapter-interfaces.ts`** — the interfaces adapters implement, so `src/core/` never has to
  import a concrete adapter.

## `src/adapters/` — platform signal producers

Each adapter is a thin, OS-facing implementation of an interface `src/core/` defines. They feed
the corroboration store or the engine directly; none of them contain classification logic.

- **`hook-log-reader.ts`** — reads the JSONL log the Claude Code hook script writes, and matches a
  document's content hash against a logged hook event (Tier 1).
- **`lock-file-watcher.ts`** — watches `~/.claude/ide/*.lock` (respecting `$CLAUDE_CONFIG_DIR`) to
  corroborate a disk write against an active, workspace-matched Claude Code IDE session (Tier 2a).
- **`shell-integration-bridge.ts`** — listens to VS Code's integrated-terminal shell-integration
  events to detect an active `claude` invocation (Tier 2b).
- **`process-scan-fallback.ts`** — a `ps`-based fallback that correlates a running `claude`
  process to a workspace via cwd (Tier 2c, weakest signal, macOS/Linux only).
- **`workspace-watcher.ts`** — the whole-workspace file-system watcher that drives the
  closed-file/no-open-tab tracking path, applying the exclusion predicate before anything is
  watched, diffed, or attributed.

## `src/persistence/` — local storage + git-notes sync

- **`store.ts`**, **`types.ts`**, **`hashing.ts`** — the default, always-on local store: a JSON
  file per `(repository root, branch)` pair, upserted by content hash rather than file path (see
  "Content-hash-anchored persistence" below). Writes are atomic (write-to-temp, then rename).
- **`gitContext.ts`** — resolves a file's repository root and branch via the `vscode.git`
  extension API, with a raw-filesystem fallback (including `.git`-as-file worktree indirection)
  when the Git extension is absent.
- **`branchWatcher.ts`** — detects branch/HEAD changes so open documents get reloaded against the
  right `(repoRoot, branch)` key after a checkout/rebase.
- **`rekey.ts`** — re-anchors history under a new path on file rename/move.
- **`retention.ts`** — ages out entries older than `tourist.attributionRetentionDays`.
- **`gitNotes/`** — the opt-in, git-native sharing mode, kept as its own submodule so the default
  local-only path has zero git-notes code in it:
  - **`notesStore.ts`**, **`gitPlumbing.ts`** — read/write `refs/notes/tourist-attribution` via
    git's own notes plumbing.
  - **`commands.ts`** — push/fetch entry points behind `tourist.gitNotesSync`.
  - **`merge.ts`** — structured (field-level, not textual) JSON merge for concurrent note
    divergence between collaborators.
  - **`rewriteContinuity.ts`**, **`hookRunner.ts`** — a `post-rewrite` git hook installed
    alongside the Claude Code hook, so notes survive `amend`/`rebase`/interactive-squash instead of
    silently orphaning on the old commit SHA (a real, git-native gap — see "Persistence" below).
  - **`config.ts`**, **`types.ts`** — the `tourist.gitNotesSync` toggle plumbing and shared shapes.

## `src/vscode-integration/` — the UI layer

Everything here talks to `src/core/` and `src/persistence/` only through the interfaces in
`contracts.ts`, never a concrete implementation, except in `extension.ts` itself.

- **`change-listener.ts`** — normalizes real `vscode.TextDocumentChangeEvent`s into the engine's
  plain `NormalizedChangeBatch` input, including dirty-state tracking (`DirtyTracker`).
- **`decorations.ts`** — the gutter/border decorations: solid blue (AI), solid orange (human),
  dashed magenta with a `?` icon (external/unknown).
- **`status-bar.ts`**, **`stats.ts`**, **`attribution-rollup.ts`**, **`line-buckets.ts`** — the
  workspace-wide ai/human/external percentage rollup shown in the status bar.
- **`workspace-view.ts`** — the `TreeView` backing the Explorer-nested "Attribution" view
  (folder → file rollup).
- **`commands.ts`** — command palette entries (toggle tracking/markers, install/verify hook, open
  workspace view, push/fetch attribution notes) and the `tourist.openMenu` `QuickPick` aggregator.
- **`hook-install.ts`** — writes/verifies the Claude Code `PreToolUse`/`PostToolUse` hook
  registration in `~/.claude/settings.json`.
- **`git-extension.ts`**, **`git-reload.ts`** — resolving the `vscode.git` API and reconciling
  open documents after a git-caused reload (branch switch, stash pop) so content already seen
  before is restored from persisted history instead of misclassified.
- **`settings.ts`**, **`contracts.ts`** — typed settings accessors and the `EngineLike`/
  `PersistenceLike` interfaces that keep this layer swappable against mocks.
- **`persistence-adapter.ts`** — the real adapter wrapping `src/persistence/`'s local store and
  git-notes submodule behind `contracts.ts`'s `PersistenceLike` shape.
- **`mocks/`** — `mock-engine.ts` / `mock-persistence.ts`, in-memory stand-ins used by
  `vscode-integration` tests and (historically) during incremental integration before the real
  engine/persistence were wired in.
- **`knowledge-map/`** — a separate, opt-in feature (off by default, gated by
  `tourist.knowledgeMap.enabled`): a webview panel (`panel.ts`, `html.ts`) that visualizes "what
  this developer knows" using data produced by the analyser CLI in
  `ideation/knowledge-forest/analyser/`. `commands.ts` wires the "Generate"/"Show Knowledge Map"
  commands (with a one-time consent prompt and a CLI-or-API-key backend choice); `store.ts` and
  `paths.ts` handle reading/writing the generated forest JSON and resolving the analyser's
  location on disk. This subfolder is a UI shell over the `ideation/` pipeline described below —
  it does not itself compute attribution.

## `src/extension.ts` — activation entry point

The single integration seam: constructs the real `AttributionEngine`, the real
`RealPersistenceAdapter`, starts every Tier 2a/2b/2c adapter and the workspace watcher, wires
`vscode.workspace`/`vscode.window` event listeners into the engine, registers commands (including
the Knowledge Map commands), and registers the tree view and status bar. Nothing outside this
file constructs a concrete engine or persistence implementation — every other consumer talks to
the `EngineLike`/`PersistenceLike` interfaces in `contracts.ts`, which is what makes the mocks in
`vscode-integration/mocks/` usable as drop-in substitutes for testing.

## `ideation/knowledge-forest/` — the Knowledge Map feature

A self-contained sibling pipeline, deliberately kept separate from Tourist's core attribution
build (own `package.json`/`tsconfig`/`vitest.config.ts`, never touches the root build). It answers
a different question than the rest of the repo — "what does this developer know" rather than "who
wrote this line" — using the attribution log as one of several evidence sources (alongside git
history and, opt-in only, Claude Code session transcripts). `analyser/src/cli.ts` is the ingestion
CLI; it classifies evidence into three "forests" (Tech Stacks, CS Fundamentals, Engineering
Practice) via either the already-authenticated `claude` CLI or a direct Anthropic API key, never
implicitly. `ui/knowledge-forest.html` is a standalone, self-contained prototype UI (currently
loads hardcoded demo data) that `src/vscode-integration/knowledge-map/` embeds into the shipped
extension's webview. See `ideation/knowledge-forest/PLAN.md` for the full data flow and privacy
boundary, and its README's "one thing to not lose sight of" for why this stays a self-contained
spike rather than merging into `src/core/`.

## `website/` — marketing site

Static, self-contained `index.html`/`styles.css`/`script.js`. Not part of the extension's build or
test pipeline — it's the product landing page, built and deployed independently.

## `spike/` — Phase 0 research

A disposable VS Code extension (own `package.json`) whose only job was instrumentation/logging to
answer the open questions PLAN1.md's Phase 0 identified before real architecture work started —
diff-accept mechanics in the official Claude Code VS Code extension, lock-file lifecycle, shell
integration precision, hook coverage, `contentChanges` ordering, git branch-change events, and git
notes conflict/rewrite mechanics. `FINDINGS.md` records, per experiment, what was observed and
what decision it fed into Phase 1+; `experiments/` holds the raw logs/transcripts each finding is
based on. Per plan, this directory is frozen once real implementation starts and is meant to be
excluded from the packaged `.vsix`.

## `test/` — test suites

Two layers:

- **Unit tests**, split across two locations: plain `test/core/`, `test/adapters/`,
  `test/vscode-integration/` (mirroring `src/`'s structure) for most modules, plus `__tests__/`
  directories colocated directly next to the code they cover inside `src/persistence/` and
  `src/persistence/gitNotes/` (e.g. `src/persistence/__tests__/store.test.ts`,
  `src/persistence/gitNotes/__tests__/merge.test.ts`). Both patterns exist in the same repo —
  when adding persistence tests, colocate; everywhere else, mirror under `test/`.
- **`test/e2e/`** — integration/E2E tests that actually launch a VS Code Extension Development
  Host (`runTest.ts`, `esbuild.e2e.js`) and drive real activation, commands, tree view, decorations,
  settings toggles, and a real git stash/reload round trip (`suite/01`–`07`).
- **`test/fixtures/`** — shared synthetic scenario fixtures (JSON scenarios like
  `ai-write-lockfile-corroborated.json`, `external-write-uncorroborated.json`) plus larger fixture
  generators for git-notes-conflict and large-repo-performance testing, consumed by both unit tests
  and the E2E suite so they speak the same fixture format.

## `hooks/` — the Claude Code hook

**`attribution-hook.mjs`** — the script installed into `~/.claude/settings.json`'s
`PreToolUse`/`PostToolUse` events for `Edit`/`Write`/`MultiEdit`. This is Tier 1: the only signal
that is ground truth rather than inference. It logs each tool call's resulting content hash to a
JSONL file that `src/adapters/hook-log-reader.ts` reads back and matches against live document
changes.

---

## Core technical approach

### The 3-tier attribution model

Every attributed range lands in one of three buckets, decided by how much evidence Tourist
actually has — not by assuming an unexplained change is AI:

| Tier | Origin | Evidence |
|---|---|---|
| **1** | `ai` | Claude Code's own `PreToolUse`/`PostToolUse` hook logged this exact edit. Ground truth, not inference. |
| **2a / 2b / 2c** | `ai` | No hook match, but the change was a disk write to a document that was clean before and after — the classic "something rewrote this file" signature — *and* it's corroborated: an active Claude Code IDE session's lock file (2a), integrated-terminal shell-integration evidence of a running `claude` command (2b), or a process-scan match (2c, weakest, macOS/Linux only). |
| **3** | `external` | A clean-before/clean-after disk write with **no** corroborating signal at all. |
| — | `human` | The document was dirty before or after the change — a real keystroke, not a silent disk rewrite. |
| — | `null` | Untouched/committed baseline content, or a change that landed during a git-op suppression window (checkout/rebase/stash), which is deliberately left unmarked rather than guessed at. |

`external/unknown` is the headline design decision, not a residual gap: a formatter, another AI
tool, a background script, or anything else that silently rewrites a clean file is
indistinguishable from Claude Code under a naive "clean-before-and-after = AI" heuristic. Rather
than accept that false positive, Tourist requires corroboration before calling something `ai`, and
renders the honest "I don't know" case as a real, third, visually distinct state (dashed magenta
with a `?` icon) — never silently defaulted to AI and never merged into "human" either. See
`GOAL1.md` §1 for the concrete failure mode this closes off relative to the prior attempt at this
feature, and `tier-classifier.ts`'s `classifyDiskWrite` for the actual decision table.

### The piece table

`src/core/piece-table.ts`'s `PieceTable` tracks attribution as a sequence of contiguous
`{length, origin, tier, timestamp}` pieces spanning the document's current character offsets —
not a flat per-line array. Each incoming edit batch is defensively sorted by descending
`rangeOffset` before being applied, so an edit event whose multiple ranges arrive out of
bottom-to-top order (VS Code does not guarantee this ordering) can never corrupt offsets: applying
strictly right-to-left means every not-yet-applied edit's offset is still valid relative to the
table's current state. The table never stores document content itself, only piece lengths and
their attribution metadata, so it structurally cannot desync from the document the way a flat
line-indexed array can.

### Content-hash-anchored persistence

`src/persistence/store.ts` and `hashing.ts` key persisted entries by a normalized content hash
(trailing whitespace and CRLF/LF differences ignored) rather than by file path. Entries are
upserted into a JSON store file per `(repository root, branch)` pair — the store path itself is
derived from a hash of the repo root plus a slugified branch name — so:

- **Renaming a file doesn't orphan its history** — the same content hash still matches after a
  move, and rename handling explicitly re-anchors history under the new path.
- **Two repos with the same branch name never collide** — keying is `(repoRoot, branch)`, not
  branch name alone.
- Writes are atomic (write to a temp file, then `rename`), so a crash mid-write can't corrupt the
  store.

### Dual local / git-notes persistence

Two independent, non-overlapping modes, gated by a single `tourist.gitNotesSync` toggle
(default **off**):

- **Local (always on)** — the store described above. Zero network calls, zero git-notes commands,
  ever, when the toggle is off. This is the sole mechanism for uncommitted/in-progress work
  regardless of the toggle.
- **Git notes (opt-in)** — once lines are committed, their attribution can additionally be
  exported as a structured JSON note under `refs/notes/tourist-attribution`, keyed by commit SHA
  rather than branch or path — a strictly more robust key once history is committed. Sync is
  manual only (`Tourist: Push/Fetch Attribution Notes` — no silent sync on every commit/push).
  Because notes are commit-keyed and commit rewrites (`amend`/`rebase`/`cherry-pick`) mint new
  SHAs, `gitNotes/rewriteContinuity.ts` installs a `post-rewrite` hook (chained with any existing
  hook, not clobbering it) that carries a note over to its commit's new SHA; `cherry-pick` without
  `-x` has no git-level signal at all and is a documented, accepted gap rather than a silent one.
  Concurrent note divergence between two collaborators is resolved via a field-level structured
  merge (`gitNotes/merge.ts`), since git's built-in textual note-merge strategies would corrupt a
  JSON payload.

---

## How this was built

The core engine, persistence layer, and UI layer were built by separate agents working in parallel
against a shared module-ownership map and a set of stable interface contracts, defined up front so
each agent's work could proceed without blocking on the others — see `PLAN1.md` Part 2 for the full
ownership table (`src/core/` + `src/adapters/` + `hooks/` to one agent, `src/persistence/` to
another, `src/vscode-integration/` + `src/extension.ts` to a third, test fixtures/spike to a
fourth) and the interface contracts each agent built against.

Worth saying plainly, since it's part of the actual approach rather than a footnote: the first
integrated pass did not work correctly. Two independent code reviews after the initial merge
(`REVIEW_JRDEV.md`, `REVIEW_SENIOR.md`) found, among other issues, that `extension.ts` never
actually constructed or started any of the Tier 1/2a/2b/2c adapters — meaning every real Claude
Code edit fell through to `external` instead of `ai`, the exact opposite of the intended behavior —
plus a persistence bug where mid-line (non-whole-line) attributed ranges silently failed to survive
a reload, and a git-notes push path that could never succeed after a genuine two-collaborator
conflict. All three were confirmed by writing and running real reproduction tests against the
actual code, not just read from the source. Those findings, plus gaps subsequently caught by the
E2E suite (`test/e2e/suite/07-git-stash-attribution.test.ts`, added after a stash push/pop round
trip was found to misclassify restored content), drove concrete fixes — the adapters/watcher/
suppression wiring visible in `extension.ts` today is the result of that fix pass, not the first
draft. The takeaway generalizes: multi-agent parallel development against a shared contract gets
the shape of a system built quickly, but the integration seams are exactly where it needs real
review and real end-to-end testing before the result can be trusted, not just a self-report of
"contract satisfied."
