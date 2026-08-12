# Orchestrator Handoff — Tourist v2 (Live AI-vs-Human Line Attribution)

Written from the planning conversation that produced RESEARCH1.md, GOAL1.md, and
PLAN1.md, for whoever is coordinating Agents A/B/C/D's actual build. Treat this
as a status snapshot, not a substitute for the three source docs — read those
for full detail; this is the "what's true right now" layer on top.

## 1. What this project is

A new VS Code extension, inspired by (but not a clone of) an existing finished
extension called Tourist (source at `/Users/harshittomar/tourist-raw`). Single
core feature: **live, continuous attribution of every line in the workspace as
AI-written (Claude Code), human-written, or external/unknown** — shown as
gutter markers, a status bar rollup, and a workspace-wide view.

Locked scope (see GOAL1.md for full detail):
- VS Code only.
- Must correctly attribute both the bare Claude Code CLI and the official
  Claude Code VS Code extension (its `ide` MCP integration + native diff view).
- Correctness/robustness prioritized over feature breadth or shipping speed.
- Tracking is workspace-wide and always-on (not just open editor tabs),
  respecting `.gitignore` + default excludes (`node_modules`, build/dist, `.git`).
- Persistence is dual-mode: local-only by default, plus an opt-in git-notes-based
  sharing mode (`refs/notes/tourist-attribution`, toggle `tourist.gitNotesSync`).

## 2. Document map

| File | Contents |
|---|---|
| `RESEARCH1.md` | Deep research pass: competing extensions, VS Code API mechanics, Claude Code hook behavior, confirmed/plausible/unverified tags |
| `GOAL1.md` | Vision, v1 scope (in/out), non-goals, success criteria, risks |
| `PLAN1.md` | Phased technical build plan (Phase 0 spike → 5 packaging) + Part 2: module ownership map, interface contracts, dependency graph, multi-agent execution plan, agent role mandates |
| `spike/FINDINGS.md` | Agent D's Phase 0 experiment results — all 9 experiments attempted, 8 have recorded results, experiment 1 is PENDING (needs a human) |

## 3. Architecture in one paragraph

A 3-tier signal model instead of a single binary heuristic: **Tier 1** = Claude
Code hook (`PreToolUse`/`PostToolUse`) diff = ground truth. **Tier 2** =
disk-write-while-editor-clean, corroborated by evidence of an active Claude
Code IDE session (primarily `~/.claude/ide/*.lock` watching, plus Terminal
Shell Integration and process-scan as weaker fallbacks) = high-confidence "ai".
**Tier 3** = disk-write-while-clean with no corroboration = explicit
"external/unknown" bucket, deliberately NOT defaulted to "ai" (the core
differentiator vs. Tourist and every competing extension). Attribution ranges
are tracked via a piece-table/position-mapped structure (not Tourist's flat
per-line array), fed by two ingestion paths — live editor edits, and a
whole-file-diff path for tracked-but-closed files (needed for workspace-wide
always-on tracking).

## 4. Module ownership map (from PLAN1.md Part 2)

| Path | Owner | Status |
|---|---|---|
| `src/core/`, `src/adapters/` | Agent A | **Built** — see §5 |
| `src/persistence/` | Agent B | **Mode A built**, Mode B status unconfirmed — see §5 |
| `src/vscode-integration/`, `src/extension.ts` | Agent C | **Built against mocks** — see §5 |
| `spike/`, `test/fixtures/` | Agent D | **DONE except experiment 1 (needs a human)** — see §5 |
| `hooks/` | Agent A (fix pending — was missing from the original ownership map, correction in flight) | Exists, ported from tourist-raw |

## 5. Per-agent status as of this handoff

**Agent A — Core Detection Engine + Piece-Table: reported DONE.**
Built in the main checkout (`/Users/harshittomar/tourist/src/core/`,
`src/adapters/`), 45 passing unit tests, `npm run compile` clean. Piece-table
with defensive descending-offset sort (order-independent regardless of
`contentChanges` ordering), tier-classification state machine, corroboration
store, exclusion predicate, lazy snapshot store, all four adapters
implemented, hook script ported from tourist-raw. Several items intentionally
stubbed pending Phase 0 spike findings (lock-file pid-liveness check,
shell-integration confidence handling, hook-schema assumption, process-scan
viability) — each flagged in code with the specific experiment number it's
waiting on. Found and resolved 4 real contract gaps against PLAN1.md's Part 2
(all already folded back into PLAN1.md): nullable `tier` for human/null
origins, self-contained content-hash tracking instead of threading text
through the contract, an additive `setGitOpSuppression()` method, and an
optional `previousContent` with an internal `SnapshotStore` fallback.

**Agent B — Persistence + Git Integration: reported DONE (Mode A and Mode B).**
Built in worktree `tourist-3` (`/Users/harshittomar/.ao/data/worktrees/tourist/tourist-3`).
Mode A (local storage): content-hash-anchored store keyed by `(repoRoot, branch)`,
`vscode.git` API + raw-fs fallback with correct worktree `gitdir`/`commondir`
handling, retention pruning, rename/reconciliation. Did its own Phase 0
experiment 6 check itself (documented in its own `SPIKE_NOTES.md`, inside its
worktree) since `spike/FINDINGS.md` didn't exist yet at the time.
**Update (confirmed by the tourist-project orchestrator directly against the
worker): Mode B is also DONE** — structured JSON notes under
`refs/notes/tourist-attribution`, explicit push/fetch (no auto-sync), verified
zero-I/O-when-disabled via a throwing-spy test, rewrite-continuity confirmed
empirically (amend/rebase via git's native `notes.rewrite` config,
cherry-pick left as a visible stderr-flagged gap, not silent). The
tier-then-recency field-merge is implemented as a pure function; its
git-level wiring was deliberately left pending Phase 0 experiment 7, which is
now CONFIRMED (see below) — that wiring is unblocked. 76/76 tests pass,
typecheck clean. Full detail in `src/persistence/STATUS_REPORT.md` inside
Agent B's worktree.

**Agent C — VS Code UI / Decorations Layer: reported DONE (against mocks).**
Built in worktree `tourist-4`. Full scope implemented against a hand-written
mock engine/persistence and a **manually mirrored copy** of the Part 2
contracts (`contracts.ts`) — not a live import of Agent A's real types, since
worktrees don't share uncommitted files (see §6). Verified `tsc --noEmit`
clean, `esbuild` bundles, 44 unit tests pass on pure-logic modules
(decorations/status-bar/commands/extension.ts need `@vscode/test-electron` or
an F5 debug session for real behavioral verification, per PLAN1.md's own exit
criteria — not yet done). Flagged 6 gaps/conflicts while building (see §7,
items 1–2 and 4–6 — already relayed into a PLAN1.md revision pass).

**Agent D — Test Harness + Edge-Case Verification: DONE except experiment 1
(needs a human). Correction to the previous entry below.**
`spike/FINDINGS.md` now covers all nine experiments: 2, 3 (bash/zsh
confirmed; fish/pwsh not installed on this machine, genuinely untested, not
assumed), 4, 5, 6, 7, 8, 9 all have recorded results, and 1 remains
PENDING (needs a human, see below) — this closes the gap the
tourist-project orchestrator flagged directly to Agent D's worker.
**Correction:** the previous entry's claim that worktree `tourist-5` "was
idle with no `spike/` files of its own" reflected a misunderstanding, not
actual idleness — `tourist-5` *is* Agent D's session; git worktrees don't
share uncommitted files, so Agent D's own worktree never being the place any
of this landed was expected (it was instructed to write into the shared main
checkout via an explicit absolute path), not a sign of no work happening.
Per PLAN1.md's exit criteria, 2/4/5 (the Phase-1 hard blockers) are now
answered: Tier 2a can implement pure fs-watch + a `process.kill(pid, 0)`
liveness check (no TTL needed); Tier 2b's bash/zsh signal is high-confidence
and usable as designed, keyed off `terminal.shellIntegration` for the
no-signal case; the piece-table remap loop should keep its defensive sort
(today's VS Code version showed clean bottom-to-top ordering, but PLAN1.md's
own policy is to keep the cheap defensive sort regardless). **One real bug
found and reported for Agent A to fix:** `CLAUDE_CONFIG_DIR` override
handling in both `hooks/attribution-hook.mjs` and
`src/adapters/hook-log-reader.ts` uses `path.dirname(override)` instead of
`override` directly, misplacing the attribution log one directory level up
when a custom config dir is set (one-line fix, two call sites, already
flagged by the file's own TODO comment) — doesn't affect the default
no-override case. Experiment 4 also has one residual open question (not a
blocker, but worth a human smoke test before fully trusting Tier 1 in
production): live end-to-end hook *dispatch* via a real running `claude`
CLI session wasn't independently re-fired, since doing so needed either a
permission-bypass flag (blocked by this environment's own safety classifier
as a disallowed nested-agent bypass) or the real global `~/.claude/settings.json`
(too risky to mutate on a machine other sessions are concurrently using) —
see `spike/FINDINGS.md` experiment 4 for the full reasoning. **Experiment 1
still structurally requires a human** to click through Accept All / Accept
Hunk / Reject All in a live Extension Development Host — no agent can do
this step; the instrumentation harness for it is built and ready
(`spike/extension.js`), manual steps in
`spike/experiments/01-diff-accept/README.md`.

## 6. Critical structural issue: four disconnected worktrees

Git worktree topology (all branches currently sitting at the same initial
commit `f482c7d` — nothing has been committed since):

```
/Users/harshittomar/Tourist                                        [main]                 — Agent A + Agent D's work
/Users/harshittomar/.ao/data/worktrees/tourist/tourist-2           [ao/tourist-2/root]
/Users/harshittomar/.ao/data/worktrees/tourist/tourist-3           [ao/tourist-3/root]     — Agent B's work
/Users/harshittomar/.ao/data/worktrees/tourist/tourist-4           [ao/tourist-4/root]     — Agent C's work
/Users/harshittomar/.ao/data/worktrees/tourist/tourist-5           [ao/tourist-5/root]     — Agent D's session; work landed in the main checkout (not a duplicate, see §5)
/Users/harshittomar/.ao/data/worktrees/tourist/orchestrator/tourist-orchestrator [ao/tourist-orchestrator]
```

**Git worktrees do not share uncommitted files with each other or with the
main checkout.** Practical consequence already hit: Agent C could not import
Agent A's real types (both uncommitted, in different worktrees) and had to
hand-write a parallel mirrored copy instead, manually verified field-for-field
rather than compiler-enforced. Separately, at least Agent B and Agent C each
independently generated their **own root-level scaffold** (`package.json`,
`tsconfig.json`, `esbuild.js`, likely a `vitest.config.ts` for C) since each
started from what looked like an empty repo from inside its own worktree —
these are almost certainly incompatible with each other and with whatever
Agent A/D built directly in the main checkout.

**Before any real integration (the "mock-to-real swap" PLAN1.md's Sync Point 1
describes) can happen, someone needs to:**
1. Pick one canonical root scaffold and reconcile dependencies/scripts across
   all four agents' needs.
2. Consolidate all four modules (`src/core/`, `src/persistence/`,
   `src/vscode-integration/` + `src/extension.ts`, `spike/` + `test/fixtures/`)
   into one worktree/branch — e.g. each agent commits to its own branch, then
   a merge/integration pass combines them (should be low-conflict at the file
   level, since ownership boundaries were respected — the conflict risk is
   almost entirely in the root scaffold files, not `src/`).
3. Once consolidated, replace Agent C's manually-mirrored `contracts.ts` with
   real imports from Agent A's `src/core/` and Agent B's `src/persistence/`,
   and resolve the two real contract gaps found (see §7, items 1–2) so the
   swap is a clean type-check, not a silent drift.

This has not been decided yet — flagging as the top open question for
whoever picks this up next.

## 7. Contract/doc fixes identified — status

Sent to the agent maintaining PLAN1.md; confirm they landed before continuing
Agent A/B/C's work:

1. **Enumeration methods** — `EngineLike.listTrackedDocIds()` and
   `PersistenceLike.listPersisted()` need to be added; the workspace-wide view
   can't function without them. **Needs to be added to Agent A's and B's real
   code**, not just documented.
2. **Rename entry point on `EngineLike`** — currently only Persistence has
   one; Agent C had to work around this with close+reopen. **Needs a real
   method added to Agent A's engine.**
3. **`hooks/` missing from the ownership map** — documentation-only fix,
   assign to Agent A.
4. **GOAL1.md vs. PLAN1.md conflict on git-notes mode-off behavior** —
   resolved in favor of PLAN1.md's fully-gated version (zero git-notes
   activity of any kind, including local writes, when the toggle is off) —
   this is what Phase 4's "mode-off leak check" test already assumes.
   GOAL1.md's wording is being corrected to match.
5. **Setting name standardized** as `tourist.gitNotesSync` (GOAL1.md had
   drifted to `tourist.shareAttribution` for the same toggle).
6. **Scope narrowing:** the "fix-line-attribution equivalent" command is
   being **dropped from v1 entirely** (not the non-LLM stand-in Agent C built
   as a placeholder) — Tier 3 already resolves the ambiguity that Tourist's
   original LLM-assisted feature existed to handle, so the command no longer
   has an equivalent job to do.

As of this handoff, the message requesting these six fixes has just been sent
to the PLAN1.md-maintaining agent — **confirm it landed in PLAN1.md before
briefing anyone on the corrected contract.**

## 8. Immediate next steps, in order

1. ~~Get Agent D's Phase 0 spike to a recorded result on at least experiments
   2, 4, 5~~ — **done**, see §5 and `spike/FINDINGS.md`. Assign the one real
   bug found (`CLAUDE_CONFIG_DIR` path handling) to Agent A.
2. Arrange for a human to run Phase 0 experiment 1 (diff-accept mechanics) —
   no agent can do this step. Also worth a human smoke-testing experiment 4's
   one residual open question (does the current CLI still dispatch to
   configured hooks end-to-end) at the same time, since both need a human
   anyway and the second one is a five-minute check once someone's already
   there.
3. Get a real status report from Agent B on Mode B (git-notes sync) — last
   known report cut off before that section.
4. Confirm the 6 PLAN1.md/GOAL1.md fixes in §7 landed.
5. Decide and execute the worktree-consolidation approach in §6 before
   attempting the mock-to-real swap.
6. Once consolidated: Agent A adds the two missing methods (§7.1–7.2), Agent C
   swaps its mirrored `contracts.ts` for real imports, and Sync Point 1
   (engine passes fixture suite standalone) can actually be attempted.
