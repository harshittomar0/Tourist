# PLAN1.md — Build Plan for Tourist v2 (Live AI-vs-Human Line Attribution)

Grounding documents: `RESEARCH1.md` (this repo) is the primary source for every
tier/signal claim below — tags (`CONFIRMED` / `PLAUSIBLE` / `UNVERIFIED —
NEEDS SPIKE`) are carried over verbatim and drive phase ordering. Structural
reference: `/Users/harshittomar/tourist-raw/src/attribution/` (`tracker.ts`,
`persistence.ts`, `git.ts`, `decorations.ts`, `stats.ts`) is Tourist's
existing, shipped implementation of the same feature — this plan explicitly
supersedes it (flat per-line array → piece-table; fsPath-keyed persistence →
content-hash-anchored; naive `.git/HEAD` watching → `vscode.git` API;
uncorroborated disk-write-while-clean → "ai" becomes a 3-tier model with an
explicit "external/unknown" bucket). Where a Tourist file already solves a
sub-problem well (undo/redo-by-content-hash in `tracker.ts`, structural-only-
insert passthrough, branch-scoped JSON persistence shape in `persistence.ts`),
this plan keeps the idea and upgrades the mechanism; it does not reinvent
things RESEARCH1.md didn't flag as broken.

**Revision note.** This is a revised pass over the initial plan, incorporating
three decisions made after the first draft: (1) persistence is dual-mode —
local storage by default, plus an opt-in git-notes-based sharable mode; (2)
attribution tracking is always-on and workspace-wide, not limited to files
with an open editor tab; (3) the multi-agent build runs fully autonomously
through its full dependency graph, with the human reviewing the integrated
result once at the end rather than gating between phases. Phases 1–4 and the
Multi-Agent Execution Plan below reflect these three decisions throughout;
the biggest structural changes are called out inline where they occur.

Locked scope (not relitigated here): VS Code only; must correctly attribute
both bare Claude Code CLI and the official Claude Code VS Code extension
(local `ide` MCP server, native diff view); correctness/robustness over
feature breadth or speed; attribution tracking runs continuously for every
tracked file in the workspace (not just open tabs), excluding `.gitignore`d
paths and common excludes (`node_modules`, build/dist output, `.git`) by
default; persistence supports two modes — local-only (default, unchanged
from the first draft) and an opt-in git-notes-based mode for cross-machine/
cross-collaborator sharing of committed-history attribution.

---

## Part 1 — Phased Technical Build Plan

### Phase 0 — Empirical Spike (throwaway, blocks real architecture)

**Purpose.** RESEARCH1.md §8 lists seven open questions, several tagged
`UNVERIFIED — NEEDS SPIKE`, that determine whether the Tier-1/2/3 model needs
extra branches (especially for the Claude Code VS Code extension's diff
Accept/Reject) or whether it can be built as currently hypothesized. Writing
Phase 1's tier logic before these are answered risks building the wrong thing
twice.

**Deliverable.** A single disposable VS Code extension at `/spike` (own
`package.json`, not part of the shipped extension's dependency graph, deleted
or archived — not shipped — once Phase 0 exits) whose only job is
instrumentation/logging, plus a short findings write-up (e.g.
`spike/FINDINGS.md`) that records, for each experiment: what was observed,
which RESEARCH1.md tag it resolves (`UNVERIFIED` → `CONFIRMED` or
`CONFIRMED-FALSE`), and the concrete decision it feeds into Phase 1/2/3.

**Experiments, in RESEARCH1 §8's priority order:**

1. **Diff-accept mechanics (§4 — the biggest unknown, do first).** Install the
   real Claude Code VS Code extension. With a file open in a plain editor
   tab, drive Claude Code (Manual permission mode) to propose an edit to that
   same file; instrument `onDidChangeTextDocument`, `onDidSaveTextDocument`,
   and `document.isDirty` on the plain tab throughout. Steps: (a) accept the
   diff unmodified — does the plain tab's document dirty transiently, or does
   it silently reload clean→clean exactly like a bare-CLI write? (b) edit the
   proposed diff before accepting — does that dirty anything observable? (c)
   repeat with `acceptEdits`/auto-accept mode. (d) repeat using "Accept Hunk"
   and "Reject All" specifically, not just whole-file accept.
   **Decision fed:** if (a) is clean→clean identical to bare CLI, Tier 1/2a
   need no VS Code-extension-specific branch. If any path shows transient
   dirtying, Phase 1's tier-classification state machine needs an explicit
   "diff-review-in-progress" state that suppresses misclassifying the human's
   touch of the diff view as an authored "human" edit.

2. **Lock-file lifecycle (§2C).** Watch `~/.claude/ide/*.lock` (and
   `$CLAUDE_CONFIG_DIR/ide/*.lock` if set) with a filesystem watcher while
   opening/closing: (a) a Claude Code VS Code extension session, (b) an
   external-terminal `claude` session that then runs `/ide`, (c) a
   single-root workspace, (d) a multi-root workspace. Record: does the file
   reliably appear within a fixed short window of session start and
   disappear within a fixed short window of session end; does
   `workspaceFolders` match expectations for (c) and (d); what happens if the
   session is killed with `SIGKILL` (does a stale lock survive, for how
   long)? **Decision fed:** Tier 2a's implementation (poll vs. pure fs-watch,
   whether a staleness TTL/liveness check via `pid` is needed on top of file
   existence).

3. **Shell Integration precision (§3).** In VS Code's integrated terminal, on
   bash, zsh, fish, and pwsh (whichever are available on the actual dev
   machine(s) targeted for v1 — see assumption flagged at the end of this
   plan), run a real `claude` invocation and log
   `onDidStartTerminalShellExecution` events: is `commandLine.value` a usable
   string starting with `claude`, is `cwd` populated and correct, what is
   `commandLine.confidence`? Separately, force a "None quality" shell (e.g. an
   unsupported/older shell or `cmd.exe` if Windows is in scope) and confirm no
   event fires, and confirm the extension can detect *that it has no signal*
   (vs. silently assuming "claude not running"). **Decision fed:** whether
   Tier 2b is implemented as designed, and how tier-classification code
   distinguishes "shell integration says no" from "shell integration isn't
   available here at all."

4. **Hook coverage completeness (§8.4).** Reuse/adapt Tourist's existing hook
   installer pattern (`tourist-raw`'s `PreToolUse`/`PostToolUse` hooks
   registered in `~/.claude/settings.json`) and confirm hooks still fire for
   `Edit`/`Write`/`MultiEdit` on the current Claude Code CLI version, in both
   a bare terminal and inside the VS Code extension's terminal, and
   specifically under `--worktree`. **Decision fed:** confirms Tier 1 (ground
   truth) is still solid before anything else is built on top of it; if hook
   config format changed, Phase 1's hook-log reader needs to target the
   current schema, not Tourist's.

5. **`contentChanges` ordering (§8.5, carried over, still open).** On the
   actual VS Code version pinned for this project, force multi-range edits
   (multi-cursor edit, "Replace All" in Find/Replace across multiple matches,
   a formatter rewriting the whole file) and log the raw
   `event.contentChanges` array's range order every time. Confirm whether it
   is still capable of arriving non-bottom-to-top (per MS bug reports #11487,
   #111548) on the pinned version. **Decision fed:** whether Phase 1's
   piece-table remap loop must sort/normalize changes defensively before
   applying them (assume yes unless conclusively disproven — the cost of
   defensive sorting is low and the cost of an unverified assumption is a
   silent corruption bug).

6. **Git extension branch-change events (§6).** Pull the exact `.d.ts` for
   `vscode.git`'s `Repository.state` (specifically the change-event
   name/shape) verbatim from the installed `vscode.git` extension's typings,
   confirm it fires promptly on `checkout`, `rebase`, and switching between
   linked worktrees, and confirm behavior when the Git extension is
   disabled or a folder isn't a git repo. **Decision fed:** Phase 2's
   branch-change listener implementation and its documented fallback path.

7. **NEW — Git notes write/read/sync/conflict mechanics (feeds Phase 2's
   git-notes-mode design, added after the persistence decision below).**
   Create two local clones of a scratch test repo. In each, make a commit and
   write a structured (JSON) attribution note via git's notes plumbing
   (`git notes --ref=tourist-attribution add`) for that commit. Push one
   clone's notes ref, then in the other clone make a *different* note for the
   *same* commit before fetching — a genuine divergence — and fetch/attempt
   to sync. Observe: does git surface this as a real conflict (conflict
   markers under `.git/NOTES_MERGE_WORKTREE`, or a rejected push), and can a
   custom structured-JSON merge (deserialize both note versions, merge
   per-line-range entries by tier-confidence then recency, re-serialize, write
   back) be driven reliably from Node via `child_process`, or does it need to
   hook into git's own merge-driver/strategy-script mechanism instead?
   **Decision fed:** Phase 2's exact conflict-resolution implementation for
   git-notes mode. This is a hard blocker only for the git-notes-mode
   sub-path of Phase 2 — local-mode persistence does not depend on it and can
   proceed without waiting.

8. **NEW — Git notes survival across rebase/amend/cherry-pick (a distinct,
   more dangerous failure mode than item 7's conflict case: silent data
   loss, not a conflict).** Git notes are anchored to a commit **SHA**, and
   `rebase`, `commit --amend`, and `cherry-pick` all produce a *new* SHA —
   which can silently orphan a note on the old, now-unreachable commit with
   **no error and no conflict raised at all**. This was empirically tested
   during this planning pass (git 2.50.1, macOS) and the findings below
   should be **re-confirmed by Phase 0 on the team's actual target git
   version(s)**, since notes-rewrite behavior has changed across git
   releases historically — treat what follows as a strong, pre-validated
   starting hypothesis, not a substitute for re-running it.
   - **Confirmed: `commit --amend` with no config silently orphans the
     note.** Committing, adding a note, then amending produces a new SHA
     with no note; the note remains attached only to the old, now-
     unreachable commit — reproduced directly.
   - **Confirmed: setting `git config notes.rewriteRef
     refs/notes/tourist-attribution` plus `notes.rewrite.amend true` /
     `notes.rewrite.rebase true` makes git auto-copy the note to the new SHA
     correctly** for both `commit --amend` and `rebase` (single-commit and
     multi-commit) — but only because these config values were explicitly
     set; `notes.rewriteRef` is **empty by default**, so this is not
     "automatic" out of the box — Tourist-successor must set this local git
     config itself (e.g. when Mode B is enabled), the same way it already
     installs the Claude Code hook.
   - **Confirmed: `cherry-pick` is never covered by this mechanism at all,**
     with or without `-x`, and regardless of `notes.rewriteRef`/
     `notes.rewrite.cherry-pick` being set — cherry-pick creates a new
     commit via a different code path than "rewrite" commands, so no
     built-in git config closes this gap. `-x` only adds a
     `(cherry picked from commit <sha>)` trailer to the new commit's
     message; it does not itself carry the note over.
   - **Confirmed via a `post-rewrite` hook instrumented for this test:** the
     hook fires (with `class=amend` or `class=rebase` and old-SHA/new-SHA
     pairs on stdin) for `commit --amend` and `rebase`, **including
     multi-commit rebases and interactive-rebase squashes** — a squash of
     two noted commits into one produced **two old-SHA lines both mapping to
     the same new SHA** in a single hook invocation, confirming a custom
     hook can uniformly handle both the simple 1:1 rewrite case and the
     harder N:1 squash case. The hook **never fires for `cherry-pick`**,
     clean or empty, confirmed directly — there is no git hook of any kind
     that observes a cherry-pick's provenance except the optional `-x`
     message trailer.
   - **Decision fed:** Phase 2's Mode B design (below) adopts a **custom
     `post-rewrite` hook** — installed by Tourist-successor when Mode B is
     enabled, analogous to the existing Claude Code hook installer — as the
     primary, reliable mechanism for amend/rebase/squash note continuity,
     rather than depending solely on git's built-in `notes.rewriteMode`
     (whose textual strategies — `concatenate`/`cat_sort_uniq` — are unsafe
     for structured JSON payloads and would corrupt them in the N:1 squash
     case). Cherry-pick remains a **documented, accepted gap** for commits
     picked without `-x` (no git-level signal exists to catch it at all);
     for `-x`-flagged cherry-picks, a `post-commit` hook scanning the new
     commit's message for the trailer can recover the mapping. This mirrors
     git-ai's own documented gaps around `filter-branch`/`filter-repo`
     (RESEARCH1.md §1) — a known-hard problem class industry-wide, not a
     design failure unique to this plan.

9. **Process-scan viability (§2A, lowest priority — only if time allows).**
   Confirm `ps-list` can correlate a running `claude` process to a specific
   workspace path via `cwd`/`cmd` on macOS/Linux. **Decision fed:** whether
   Tier 2c is worth shipping in v1 at all, or whether it's acceptable to ship
   v1 with Tier 2c as a documented "not yet implemented" gap for the
   bare-terminal-never-`/ide` case (a real coverage gap, but an honest one —
   consistent with the "external/unknown, not defaulted to ai" philosophy:
   worst case such edits sit in Tier 3, not misclassified).

**Exit criteria.** All nine experiments attempted (9 is best-effort); 1, 2,
4, and 5 have a definitive recorded answer (not "inconclusive") since Phase 1
cannot start in earnest without them; 7 and 8 have definitive recorded
answers since Phase 2's git-notes-mode sub-path cannot start in earnest
without them (local-mode persistence is unaffected and can proceed
regardless) — item 8 already has strong preliminary findings from this
planning pass to re-confirm rather than start from scratch; `spike/FINDINGS.md`
written; `/spike` directory frozen (no further edits) once Phase 1 begins,
and deleted at Phase 5.

**Depends on:** nothing (first phase).

---

### Phase 1 — Core Detection Engine

**Scope.** A VS Code-independent core module implementing:
- The piece-table / position-mapped range structure that remaps attribution
  ranges through each edit's offset/length/text (replacing Tourist's flat
  `(LineOrigin | null)[]` array), including the defensive change-ordering
  handling Phase 0 item 5 determines is necessary.
- The corroboration-state store (`activeClaudeSessions`-style map keyed by
  workspace, written to by whichever Tier 2a/2b/2c adapters are enabled, read
  by the tier-classification logic) — kept as one reusable fact per
  RESEARCH1.md §7's explicit recommendation, not three scattered ad hoc
  checks.
- The tier-classification state machine: given a document's dirty-before/
  dirty-after state for a change, plus current corroboration state, plus
  (if present) a Tier-1 hook-log match, decide the resulting origin/tier per
  the table in RESEARCH1.md §7 (1 → 2a → 2b-augments-2a → 2c-fallback → 3
  "external/unknown" → optional disabled-by-default 4).
- Preserve Tourist's already-correct sub-behaviors, reimplemented on the new
  data structure: undo/redo restoration by content-hash history, and
  structural-only-insert passthrough (pure whitespace/newline edits inherit
  the touched range's existing origin rather than being reattributed).
- **NEW (per always-on, workspace-wide tracking decision) — a second
  ingestion path for closed/background files.** The prior draft only ever
  fed the engine live, incremental `NormalizedChange`s from an open,
  actively-edited document. That's no longer sufficient: attribution must
  now be tracked continuously for every tracked file in the workspace,
  whether or not it has an open editor tab. For a file with no open
  document, there is no `TextDocument`, no incremental change event, and
  critically no meaningful "dirty" state to check — the entire dirty-before/
  dirty-after signal the whole tier model leans on for Tier 2/3
  classification only exists for open documents. So this phase adds a
  **whole-file diff ingestion path**: when the workspace-wide watcher
  (adapter, see below and Part 2) reports a change to a tracked file with no
  open document, the engine diffs the file's new on-disk content against its
  last-known baseline (from a persisted content-hash anchor if this is the
  first time this session has seen the file, or an in-session snapshot
  otherwise), and classifies the changed spans using the *same* Tier
  1→2a→2b→2c→3 logic as the live path — except it skips the dirty-check
  entirely (meaningless for a closed file) and goes straight to a Tier-1
  hook-log match if one exists, else corroboration-state lookup (2a/2b/2c
  vs. 3). Both ingestion paths converge on the same `AttributedRange` output
  shape, so downstream consumers (persistence, UI) never need to know which
  path produced a given range.
- **NEW — a generalized content-snapshot/baseline store** spanning every
  tracked file in the workspace, not just currently open documents, needed
  to diff against in the path above. Seeded **lazily** (on first observed
  change to a file, or from persisted history) rather than eagerly reading
  every file at extension activation, specifically to bound activation-time
  cost on large repositories — this trade-off (and whether lazy seeding is
  sufficient or a smarter strategy is needed) is validated in Phase 4.
- **NEW — an exclusion-filter predicate** (respects `.gitignore` plus
  default excludes for `node_modules`, build/dist output, `.git`) that both
  this ingestion path and the workspace-watcher adapter (Part 2) consult
  before a file is tracked at all. A file outside this predicate is never
  snapshotted, diffed, watched, or attributed — this is an implementation
  detail with well-documented prior art (e.g. a `.gitignore`-parsing library
  plus a small hardcoded default-exclude list), not a RESEARCH1.md open
  question, so it carries no Phase 0 spike dependency.

**Design constraint.** This module must be testable with plain fixtures (a
sequence of synthetic change events + dirty-state flags + synthetic
corroboration-state snapshots) without a real `vscode.TextDocument` or a real
editor — real VS Code integration is Phase 3's job. Any code that needs the
literal `vscode` module does not belong in this phase's ownership boundary.
The whole-file-diff path shares the same tier-classification and
`AttributedRange` output shape as the live-editing path — it is a second
*ingestion mechanism* into one engine, not a parallel system.

**Exit criteria.** Given a scripted sequence of edits (including reordered
multi-range changes, undo/redo, and every tier-classification branch), the
engine produces the expected `AttributedRange[]` output deterministically;
unit tests cover each tier transition and the two edge cases above. In
addition: a scripted scenario where a tracked-but-never-opened file changes
on disk (once simulating a corroborated Claude Code write, once an
uncorroborated external write) produces the correct Tier-2/Tier-3
classification via the whole-file-diff path alone with no open document
involved; a file matching the exclusion predicate never enters the engine at
all under any ingestion path.

**Depends on:** Phase 0 items 1, 4, 5 (hard blockers on tier semantics and
remap correctness); item 2 (informs the lock-file adapter's shape, but the
adapter itself is a thin implementation of an interface this phase defines,
so the interface can be designed before the spike fully lands — see Part 2).
The workspace-wide watcher/exclusion-filter component has no Phase 0
blocker of its own (well-documented APIs, not an open research question),
but its performance characteristics on large repositories are validated in
Phase 4, not assumed correct by construction.

---

### Phase 2 — Persistence & Git Integration

**Revised for dual-mode persistence (local-only default + opt-in git-notes
sharing).** The first draft assumed local-JSON-only persistence, mirroring
Tourist. That assumption is overturned: v1 must support two modes behind a
single toggle, described below.

**Scope — Mode A: local storage (default, unchanged from the first draft).**
- A read/write persistence API storing attribution snapshots keyed by
  **(repository root, branch name)** pairs (not branch name alone — fixes a
  real multi-root collision case Tourist doesn't handle) and, within that,
  by a **content-hash anchor** rather than raw `fsPath` (fixes Tourist's
  rename/move orphaning: `git.ts`/`persistence.ts` today key purely by
  `filePath`, so a renamed file loses its history).
- Branch/repo resolution via the VS Code Git extension API
  (`vscode.extensions.getExtension('vscode.git')` → `.exports.getAPI(1)` →
  `gitApi.repositories`, matching a file's `Uri` to its `workspaceFolder`
  and then to the right `Repository` by `rootUri`), replacing Tourist's
  `git.ts` raw `.git/HEAD` parsing. Retain a raw-filesystem fallback (with
  correct `.git`-as-file worktree-indirection handling, i.e. the
  `gitdir: <path>` pointer case Tourist's `resolveGitDir` already partially
  handles) only for the case where the Git extension is absent/disabled —
  per RESEARCH1.md §6's explicit recommendation to prefer the API and only
  fall back deliberately.
- Retention/aging logic equivalent to Tourist's `retentionDays` pruning,
  ported to the new keying scheme.
- Rename/move handling: on a detected rename (VS Code rename command, or a
  file-watcher-observed `fs.rename`/git-mv), re-anchor the existing
  content-hash-keyed history under the new path without loss, rather than
  starting a fresh blank history for the new path.
- This mode requires zero git-notes I/O and works with no network/remote at
  all — it remains the always-available baseline, exactly as before.

**Scope — Mode B: git-native sharing via git notes (NEW, opt-in via a
`tourist.gitNotesSync` — or equivalently named — setting, default off).**
Git notes attach to *commit objects*, not working-tree state, so this mode
is a complementary export/import layer over **committed history**, not a
replacement for Mode A's live/in-progress local store — Mode A keeps
tracking uncommitted work exactly as today regardless of the toggle.
- **Write path.** Tourist already has (per Tourist's existing "commit
  retires the work it captures" reconcile logic, ported into Phase 1's
  engine) a hook into the moment a commit happens. When the toggle is on,
  at that same moment, export the attribution breakdown for the lines that
  just got committed into a structured (JSON) note, and write it under
  `refs/notes/tourist-attribution` for the new commit (via git's notes
  plumbing, e.g. `git notes --ref=tourist-attribution add`). Keep each
  note's payload scoped to *that commit's own diff* (line-ranges → origin/
  tier for the lines that commit actually touched), not a full-file
  snapshot — smaller notes are both cheaper and, per the conflict strategy
  below, easier to merge correctly.
- **Read path.** When resolving "who wrote this line of this historical
  commit" and local session history doesn't have it (e.g. a fresh clone, a
  teammate's machine, or CI), look up the corresponding note for that commit
  SHA under `refs/notes/tourist-attribution` instead of requiring local
  per-machine history to exist. This is the actual value of this mode:
  portability of attribution across machines and collaborators, which
  Mode A structurally cannot offer.
- **Sync.** Because this is explicitly "opt-in" and "pushed/fetched
  separately" per the decision, v1 ships **explicit commands** — "Tourist:
  Push Attribution Notes" (`git push <remote> refs/notes/tourist-attribution`)
  and "Tourist: Fetch Attribution Notes" (`git fetch <remote>
  refs/notes/tourist-attribution:refs/notes/tourist-attribution`) — rather
  than silently syncing on every `git push`/`git pull`, since a silent
  background push has real surprise/permissions/network-failure surface.
  Auto-sync-on-push/pull as a convenience layer on top is deferred as a
  stretch goal, flagged as an open assumption below.
- **Conflict handling.** Two collaborators can each commit + write a note
  for a shared ancestor commit before syncing, producing a genuine
  divergence in the `refs/notes/tourist-attribution` ref — the same shape of
  problem git's own `git notes merge` machinery exists to handle, with
  built-in strategies (`manual`, `ours`, `theirs`, `union`,
  `cat_sort_uniq`). None of the built-in *textual* strategies are safe here
  as-is, because our note payload is structured JSON, not freeform text — a
  line-level `union`/`cat_sort_uniq` merge would produce invalid or
  duplicated JSON. The designed approach: on a detected note conflict for a
  commit, deserialize both diverging note versions, merge them at the
  field level (per line-range entry, preferring the higher-confidence tier,
  then the more recent timestamp for same-tier entries), re-serialize, and
  write the merged note back — effectively a custom merge driver layered on
  top of git's notes-merge detection rather than trusting its textual
  strategies. **The exact git-level mechanics this depends on (whether git
  reliably surfaces the conflict for us to intervene on via
  `git notes merge -s manual`, or whether a custom merge driver script must
  be registered, and whether this is reliably drivable from Node via
  `child_process`) is genuinely unverified** — this is Phase 0's new
  experiment 7 (see above), added specifically because of this decision,
  and is a hard blocker for this sub-path only.
- **Rewrite continuity (NEW — distinct from, and more dangerous than, the
  conflict case above: this is silent data loss, not a conflict to
  resolve).** Notes anchor to a commit SHA; `rebase`, `commit --amend`, and
  `cherry-pick` all mint a new SHA, which can silently orphan a note on the
  old, now-unreachable commit with no error at all. Per Phase 0 experiment
  8's findings, this is only partially solvable via git configuration alone:
  - When Mode B is enabled, Tourist-successor sets
    `git config notes.rewriteRef refs/notes/tourist-attribution` and the
    corresponding `notes.rewrite.amend`/`notes.rewrite.rebase` flags
    locally — the same one-time, repo-local setup pattern as installing the
    Claude Code hook — as defense-in-depth. But the **primary** mechanism is
    a **custom `post-rewrite` git hook** Tourist-successor installs
    alongside it: git supplies old-SHA→new-SHA pairs on stdin for both
    `amend` and `rebase` classes (confirmed to include multiple old-SHA
    lines mapping to one new SHA for interactive-rebase **squashes**), so
    the hook copies/merges the relevant note(s) onto the new SHA using the
    **same structured, field-level merge logic** as the cross-collaborator
    conflict case above — this handles the simple 1:1 rewrite and the
    harder N:1 squash case uniformly, and avoids relying on git's own
    `notes.rewriteMode` textual strategies, which would corrupt structured
    JSON payloads in the squash case. The hook must be idempotent-safe,
    since a single squash was observed to fire the hook more than once
    (once with an intermediate `amend`-class call, then a final
    `rebase`-class call).
  - `cherry-pick` is **never** covered by any git hook or config, confirmed
    empirically — this is a structural gap, not an implementation bug. A
    `post-commit` hook can recover the mapping only when `-x` was used
    (via the `(cherry picked from commit <sha>)` message trailer it adds);
    cherry-picks made without `-x` have no git-level trace at all and are a
    **documented, accepted v1 limitation** — Tourist-successor should
    recommend `-x` in its docs when Mode B is enabled, and surface an
    explicit (non-silent) indication when a cherry-picked commit has no
    recoverable note, rather than saying nothing.
  - Installing these hooks must **chain with, not clobber**, any
    pre-existing `.git/hooks/post-rewrite`/`post-commit` script — real repos
    commonly already have hook-management tooling (husky, the `pre-commit`
    framework, etc.) occupying those slots.
  - Full-history rewrites (`git filter-branch`/`filter-repo`) remain
    out of scope for v1, consistent with git-ai's own documented gap in the
    same area (RESEARCH1.md §1) — a known-hard problem industry-wide.
- **Mode-off guarantee.** When the toggle is off (the default), this module
  must issue zero `git notes`-related commands and zero related network
  calls — verified explicitly in Phase 4.

**Exit criteria.** *Mode A:* given a persisted snapshot, closing and
reopening the (mock) editor restores identical `AttributedRange` data when
content hash matches; a simulated rename preserves history; a simulated
branch switch (via a mocked `vscode.git` API) and a simulated worktree switch
each resolve to the correct, distinct storage key; disabling the Git
extension falls back correctly without crashing. *Mode B:* a commit's
attribution round-trips through a written-then-read note correctly; a
simulated two-clone divergence (per Phase 0 experiment 7's scenario)
resolves through the structured merge to a sane combined result with no data
loss; toggling the mode off produces provably zero git-notes I/O.

**Depends on:** Phase 0 item 6 (branch-change event shape) for Mode A;
Phase 0 item 7 (git notes mechanics) for Mode B specifically — **Mode A does
not depend on item 7 and can be fully implemented and shipped without it**,
so this phase's two modes can proceed on different timelines rather than
both blocking on the newer, less-precedented spike item. Phase 1's
`AttributedRange` schema (persistence stores what the core engine produces,
so the shape must be settled, though it can be stubbed/mocked early — see
Part 2).

---

### Phase 3 — VS Code Integration Layer

**Scope.** Wires the core engine (Phase 1) and persistence (Phase 2) to the
actual editor:
- `onDidChangeTextDocument` / `onDidOpenTextDocument` /
  `onDidSaveTextDocument` / `onDidCloseTextDocument` listeners that normalize
  real VS Code events into the core engine's plain input shape and feed them
  in.
- Gutter/border decorations (equivalent to Tourist's `decorations.ts`
  blue/orange border approach, extended with a third visual treatment for
  the new "external/unknown" Tier-3 bucket so it's visibly distinct from
  both "ai" and "human" rather than silently merged into one of them).
  Decorations remain inherently scoped to **open editors** — there is no way
  to render a gutter border on a file with no open tab — so the workspace-
  wide view below is what surfaces attribution for tracked-but-closed files,
  not an extension of the decoration mechanism itself.
- **NEW (per always-on, workspace-wide tracking decision) — a workspace-level
  attribution view.** Because tracking is now continuous for every tracked
  file rather than only files that happen to be open, add an aggregate view
  extending Tourist's existing "AI vs human lines" report-tile concept —
  simplified relative to Tourist's version, since Tourist had to mix "live
  state for open files" with "saved state for closed files" and this design
  no longer needs that distinction (closed files now have live state too,
  via Phase 1's whole-file-diff path). Surfaced as a command/panel (tree view
  or webview) showing ai/human/external rollups per folder or per file
  across the whole workspace, including files never opened this session.
- Status bar summary (equivalent to Tourist's `stats.ts` percentage
  rollup, now backed by continuously-updated whole-workspace state rather
  than a mix of live-and-saved data), commands (toggle tracking, toggle
  markers, install/verify hook, open the new workspace-level view — **NOT**
  a "fix line attribution" equivalent, deliberately dropped from v1 scope;
  see the note below), and settings: tracking on/off, markers on/off,
  retention days, an exclusion-policy override (for excludes beyond the
  `.gitignore` + `node_modules`/build-dist/`.git` default), the
  `tourist.gitNotesSync` toggle plus its "Push Attribution Notes"/"Fetch
  Attribution Notes" commands (the commands live here in the UI layer; the
  actual git-notes read/write/merge logic lives in `src/persistence/`, Part
  2), and any settings Phase 0/1 introduce — e.g. a toggle for the optional
  Tier-4 stylometric fallback, off by default.
- Wiring the platform adapters (lock-file watcher, terminal shell
  integration listener, process-scan fallback, hook-log reader, and the
  new workspace-wide file watcher/exclusion-filter adapter) into the core
  engine's corroboration-state input and whole-file-diff ingestion path.

**Scope narrowing — the "fix line attribution" equivalent is dropped from
v1 entirely (recorded after Agent C's Phase 3 implementation hit this gap
and, in its absence, built a placeholder "recompute this file" command that
should not ship).** Tourist needed that LLM-assisted command because its
flat heuristic left a genuinely ambiguous middle zone that only an LLM pass
could disambiguate. This design's Tier 3 ("external/unknown") resolves that
same ambiguity structurally, at classification time, not after the fact —
there is no equivalent leftover ambiguity for a command to clean up.
Agent C's mandate (Part 2) and this scope list should not include it, and
any placeholder built to fill the gap while this contract was incomplete
should be removed before Phase 3 is considered done.

**Exit criteria.** Manually opening a file, editing it by hand, then having
Claude Code (both bare CLI and VS Code extension) edit it, produces visibly
correct, distinctly colored decorations for "ai" vs "human" vs
"external/unknown," status bar percentages update live, and settings/commands
behave as documented. Additionally: the workspace-level view correctly
reports aggregate stats for files that were never opened in the current
session (attributed purely via the whole-file-diff ingestion path and/or the
Tier-1 hook log), and a file matching the exclusion policy never appears in
either the decorations or the workspace-level view.

**Depends on:** Phase 1's public engine API (can start against a mocked
engine before Phase 1 is real — see Part 2); Phase 2's persistence API for
load-on-open/save-on-change wiring.

---

### Phase 4 — Hardening & Edge-Case Coverage

Each item below is a concrete edge case (from RESEARCH1.md and the locked
scope's own list), with a specific test method — not just "handle it."

| Edge case | Why it matters | Test method |
|---|---|---|
| `contentChanges` non-bottom-to-top ordering under real load | Confirmed MS bug (#11487, #111548); a naive remap loop corrupts ranges silently | Fixture-driven unit tests feeding the piece-table deliberately reordered (ascending, descending, random-shuffled) synthetic change arrays for the same logical edit and asserting identical output; a real-editor smoke test forcing multi-cursor/Replace-All edits while logging actual order (built on the Phase 0 spike harness) |
| External tool rewrites file on disk while open+clean, no Claude session active (formatter, git hook, another AI agent, Live Share sync) | Must land as Tier 3 "external/unknown," never "ai" — the core differentiator vs. Tourist | Run `prettier --write` (or equivalent) on an open, unmodified file with lock-file/shell-integration/process-scan all confirmed inactive; assert Tier 3 classification, not Tier 2 |
| File rename/move | Tourist keys by `fsPath` only and orphans history on rename | Attribute a file, rename it via VS Code's rename command and separately via raw `fs.rename`/`git mv` outside the editor, reopen, assert history is found under the new path; also test edit-immediately-after-rename |
| Git worktrees breaking naive `.git/HEAD` watching | Claude Code itself documents/encourages `--worktree`; target users are likely worktree-heavy | Create a linked worktree (`git worktree add`), open it as a VS Code root, confirm `vscode.git`-based branch resolution returns the worktree's actual branch (not null, not the main worktree's), confirm attribution persists under a key distinct from the main worktree |
| Claude Code VS Code extension diff Accept/Reject full matrix | Top unresolved item in RESEARCH1.md §4; wrong assumption here breaks Tier 2a for the whole extension surface | Re-run Phase 0 experiment 1's full matrix (Accept All, Accept Hunk, Reject All, edit-then-accept, auto-accept mode) as a regression suite, not just a one-time spike |
| Undo/redo across tier boundaries | An AI-attributed edit undone/redone (or a mixed AI+human multi-change undo group) must restore original tags, not re-tag by current dirty-state heuristic | Script sequences: AI edit → undo → redo; human edit → undo → redo; a single undo group spanning both; assert content-hash-keyed history restores exact prior tags in every case |
| Multi-root workspaces, same branch name in different repos | Naive branch-name-only keying would collide two unrelated repos' `main` history | Open a 2-root workspace where both roots are separate repos both on a branch named `main`; attribute both; assert no cross-contamination in persisted storage |
| Small-paste false negatives (paste from a chat UI/clipboard, not via CLI or IDE MCP edit) | Locked scope only requires attributing the two named surfaces (bare CLI, Claude Code VS Code extension edits); a clipboard paste dirties the document like any human keystroke | Assert a clipboard paste is consistently classified "human" (correct, not a false negative, given scope) — document this explicitly as expected behavior/known limitation rather than silently leaving it ambiguous |
| Lock-file staleness after a crashed session | A `SIGKILL`'d Claude session could leave a stale lock file, causing Tier 2a to over-corroborate after the session is actually gone | Kill a session mid-edit with `SIGKILL`, measure how long the stale lock persists, and decide (per Phase 0 experiment 2's findings) whether a `pid`-liveness check is needed on top of file existence |
| Live Share guest edits | A guest's edit arrives on the host's document through the text-document model, not a disk write — must not be misclassified as Tier 2/3 "ai"/"external" | Host + guest Live Share session; guest types; assert host-side classification is the same "human" path a local keystroke would take (dirty-before/after via the document model), not routed through the disk-write tiers at all |
| Reconcile-on-commit / reconcile-on-git-op correctness | Tourist's existing git-guard-and-reconcile logic (suppress "ai" during git ops, then reconcile against post-op branch history) is correct in spirit and must survive the persistence rewrite | Port Tourist's existing manual test flow (edit → commit → confirm markers clear to match `HEAD`; checkout mid-edit → confirm no mislabeling) against the new content-hash-anchored store |
| **NEW — large-repo activation/scan performance** (risk introduced by always-on, workspace-wide tracking) | Eager, whole-repo content snapshotting at activation could make the extension slow to start or memory-heavy on large monorepos | Benchmark against a large-repo fixture (tens of thousands of tracked files after exclusion filtering); measure activation-time cost, confirm lazy snapshot seeding (Phase 1) keeps activation near-instant, measure snapshot-store memory footprint under realistic file counts |
| **NEW — workspace-watcher OS-level overhead/limits** (risk introduced by always-on, workspace-wide tracking) | Per-file watchers can hit OS watcher-handle limits (Linux inotify limits, macOS FSEvents behavior) on large trees | Open a large-repo fixture and confirm no "too many open files"/watcher-registration errors; validate whether a directory-level-watch-plus-in-process-filter strategy is needed instead of per-file watches, and confirm exclusion filtering is applied *before* a path is ever watched, not after |
| **NEW — bulk background-change bursts** (e.g. a branch switch or rebase touching thousands of files at once) | Could trigger a burst of whole-file diffs computed as if each were a live edit, both slow and semantically wrong (these are git ops, not authorship) | Time a large branch switch on the repo fixture; confirm the existing git-op-suppression window (extended to the workspace-wide watcher, not just open documents) correctly suppresses the burst instead of diffing/attributing every touched file |
| **NEW — git notes concurrent-write conflict** (Mode B, per the dual-persistence decision) | Two collaborators can independently write notes for the same commit before syncing; a naive merge could silently drop one side's attribution | Two-clone simulation per Phase 0 experiment 7: both commit + note the same ancestor commit, one pushes, the other fetches and merges; assert the structured JSON merge produces a sane combined result with no silent data loss |
| **NEW — rebase/amend/cherry-pick does not silently drop attribution notes** (Mode B; distinct from the row above — this is data loss, not a conflict) | Notes anchor to a commit SHA; rewriting a commit mints a new SHA and can silently orphan the note with no error at all (confirmed during planning, Phase 0 experiment 8) | Commit + note a change, then (a) amend it, (b) rebase it onto a divergent branch, (c) interactively squash it with another noted commit, (d) cherry-pick it with `-x`, (e) cherry-pick it without `-x` — assert the note survives intact on the new SHA for (a)-(d) via the installed `post-rewrite`/`post-commit` hooks, and assert (e) produces an explicit, visible "no recoverable note" indication rather than silently vanishing; also verify hook installation chains with a pre-existing husky/`pre-commit`-framework hook rather than clobbering it |
| **NEW — git-notes-mode-off leak check** (Mode B, per the dual-persistence decision) | The default (off) mode must have zero git-notes-related behavior, network calls, or side effects | Run the full edit/commit/branch-switch flow with the toggle off and assert (e.g. via a git command-execution spy) that no `git notes`-prefixed command or notes-ref network operation ever fires |

**Exit criteria.** Every row above has a passing automated test (unit or
scripted integration) or, where true end-to-end manual driving is
unavoidable (the diff-accept matrix, Live Share, worktree creation), a
documented, repeatable manual test procedure that was actually executed and
whose result is recorded.

**Depends on:** Phases 1–3 substantially complete (this phase tests the
integrated system, not isolated modules).

---

### Phase 5 — Packaging & Release Readiness

**Scope.**
- Marketplace metadata (`package.json` contributes: commands, configuration,
  menus — following Tourist's existing pattern), `README.md`, `CHANGELOG.md`.
- Explicit privacy/no-phone-home confirmation in the README — RESEARCH1.md
  §1's Codespy finding (sending code to a third-party server) is called out
  as a hard anti-pattern; state plainly that all detection is local-only.
- Delete or archive the `/spike` throwaway extension; confirm it is not
  bundled into the shipped `.vsix`.
- Final manual smoke pass on both required surfaces (bare CLI in an external
  terminal; Claude Code VS Code extension with the native diff view) on a
  clean profile, covering: fresh install, hook install command, a full
  edit-attribute-persist-restart-restore cycle, and at least one item from
  each Phase 4 row as a final regression pass.
- Versioning and build scripts (`esbuild`, `tsc --noEmit`) mirroring
  Tourist's existing `scripts` block.

**Exit criteria.** Clean install on a fresh VS Code profile passes the full
smoke pass above with no manual workarounds; `/spike` is absent from the
packaged output.

**Depends on:** Phase 4 complete.

---

## Part 2 — Multi-Agent Execution Plan

### Module ownership map

Directory layout for the new project (each top-level directory under `src/`
has exactly one owning agent, so parallel agents never edit the same files):

| Path | Owner | Contains |
|---|---|---|
| `spike/` | Agent D (Test Harness) | The Phase 0 throwaway extension and `FINDINGS.md`. Frozen once Phase 0 exits; deleted in Phase 5. |
| `src/core/` | Agent A (Core Engine) | Types, piece-table, tier-classification state machine, corroboration-state store, **and (NEW) the whole-file-diff ingestion path + generalized content-snapshot/baseline store spanning all tracked files**, per the always-on workspace-wide tracking decision. No `vscode` import allowed here except in clearly isolated, injectable interface definitions. |
| `src/adapters/` | Agent A (Core Engine) | Platform-facing signal producers that feed the corroboration-state store: lock-file watcher, process-scan wrapper, terminal-shell-integration bridge, hook-log reader/installer, **and (NEW) the workspace-wide file-system watcher + `.gitignore`/default-exclude filter** that drives the whole-file-diff ingestion path above. Each adapter is a thin implementation of an interface Agent A defines in `src/core/`; kept in a separate directory from `src/core/` so Agent C never needs to touch OS-level IO code, but still owned by Agent A since adapter behavior is tightly coupled to tier semantics. |
| `src/persistence/` | Agent B (Persistence & Git) | Store read/write API, schema, content-hash anchoring, rename handling, `vscode.git`-based repo/branch resolution, raw-filesystem worktree-aware fallback (Mode A, local); **(NEW)** the git-notes read/write/push/fetch/conflict-merge logic and the local-vs-git-notes mode toggle (Mode B), likely as its own `src/persistence/git-notes.ts` submodule kept distinct from the Mode A store so Mode A remains fully functional and independently testable with zero git-notes code in its path. |
| `src/vscode-integration/` | Agent C (VS Code UI) | Decorations, status bar, commands, settings, the document-change listener that maps real `vscode.TextDocumentChangeEvent`s into the core engine's plain input shape, **and (NEW) the workspace-level attribution view/panel**, the exclusion-policy setting, and the git-notes-sync toggle + push/fetch commands (UI-side only — the underlying logic is Agent B's). |
| `hooks/` | Agent A (Core Engine) | **NEW — missing from the original map entirely.** The Claude Code `PreToolUse`/`PostToolUse` hook script, ported from `tourist-raw`'s `hooks/tourist-hook.mjs`, and its install/registration logic in `~/.claude/settings.json` (Tier 1 ground truth). Owned by Agent A since Agent A is the one who ported and owns the hook-log reader that consumes its output (`src/adapters/`); Agent C's "install hook"/"verify hook" commands only reference this directory's script as an external file, they don't own its contents. |
| `src/extension.ts` | Agent C (VS Code UI) | Activation entry point; wires A+B+C together at startup. |
| `test/fixtures/` | Agent D (Test Harness) | Shared synthetic-edit-sequence fixtures used by Agent A's unit tests and Agent D's edge-case suite, **plus (NEW) a large-repo performance fixture and a two-clone git-notes-conflict fixture** for Phase 4 — Agent D owns the fixture format so all consumers speak the same language. |

No two agents write into the same directory. `src/extension.ts` is the one
integration point Agent C alone owns and is where the wiring described below
literally happens — the "seam" is a file, not a shared editing surface.

### Interfaces / contracts (define before parallel work starts)

These are the stable shapes agents build against so they can work
simultaneously without blocking on each other. Treat this section as the
contract; any agent who needs to change a shape here must flag it as a
cross-cutting change, not silently redefine it locally.

**Update note.** The passages below marked "REVISED", "NEW", or "Pending"
were added after Agent A actually implemented Phase 1 against the first
version of this contract and reported back concrete, justified deviations.
Agent B and Agent C should brief and build against this corrected version —
it is the authoritative contract now, not the shapes as originally drafted.

**1. Core engine input (what Agent C's document-change listener calls into
Agent A's engine with) — a `NormalizedChange`:**
- `rangeOffset` (number, UTF-16 code unit offset into the pre-edit content)
- `rangeLength` (number, length of the replaced span)
- `text` (string, the replacement text)
- A `NormalizedChange[]` per document event, plus, alongside it: the
  document's identity (a stable string key, not a raw `vscode.Uri`, so the
  core stays `vscode`-free), `dirtyBefore` (boolean), `dirtyAfter` (boolean),
  and the change `reason` (`"typed"` / `"undo"` / `"redo"`).

**Content-hash note — REVISED per Agent A's Phase 1 implementation, two
distinct hashes, not one.** The original contract specified no content-hash
field on `NormalizedChange` batches at all, but undo/redo restoration (the
content-hash-keyed history mechanism ported from Tourist's `tracker.ts`)
needs one internally. Rather than expand the contract to require Agent C to
thread full document text or a hash through every batch call, Agent A made
the engine self-sufficient: it maintains its **own internal mirror text
buffer** per document identity purely for its own undo/redo-history hashing,
computed and owned entirely inside `src/core/`. This is a **separate
concern** from the content hash Agent C computes independently at the
`extension.ts` boundary when calling Agent B's Persistence Load/Save API
(contract item 4) to decide whether a persisted snapshot still matches the
file on disk. Agent B and Agent C should not assume there is a missing
wiring step connecting these two hashes, and should not try to reuse one for
the other's purpose — they answer different questions (Agent A's: "have I
seen this exact content state before, for undo/redo?" vs. Agent B's: "does
this file's current content still match what was last persisted?").

**Pending design decision — "diff-review-in-progress" state (tentatively
Agent C's responsibility, pending Phase 0 experiment 1's outcome).** Agent
A's tier-classifier currently has no notion of a transient "the user is
reviewing/editing a proposed Claude Code diff before accepting it" state.
This only matters if Phase 0 experiment 1 finds that the Claude Code VS Code
extension's diff-accept flow transiently dirties the real, open document
(resolution 2 in RESEARCH1.md §4) — if experiment 1 instead confirms
clean-to-clean behavior identical to bare-CLI writes, this state is never
needed at all. **Tentative ownership call, recorded now so it isn't
ambiguous when Agent C is briefed:** if this state turns out to be
necessary, it belongs in **Agent C's document-change listener** (the layer
translating real `vscode.TextDocumentChangeEvent`s into `NormalizedChange`
calls) — e.g. by detecting the diff-view-specific editor/document and
suppressing or specially tagging changes originating from it before they
ever reach Agent A's engine — rather than inside Agent A's tier-classifier
itself, which has no visibility into VS Code's diff-editor UI concepts by
design (it only ever sees plain `NormalizedChange` batches). This is Agent
A's stated position, not yet exercised against a real extension-diff-accept
flow; Agent D's Phase 4 edge-case pass (the "Claude Code VS Code extension
diff Accept/Reject full matrix" row) is what will actually validate whether
this placement is sufficient once Phase 0's finding is in.

**2. Core engine output — an `AttributedRange`:**
- `startOffset`, `endOffset` (numbers, current-document offsets)
- `origin`: one of `"ai"`, `"human"`, `"external"`, or `null` (unmarked/
  committed baseline — mirrors Tourist's existing three-state-plus-null
  model, with `"external"` newly added for Tier 3)
- `tier`: one of `"1"`, `"2a"`, `"2b"`, `"2c"`, `"3"`, `"4"`, **or
  absent/null — REVISED per Agent A's Phase 1 implementation.** `tier` is
  only ever populated for `origin: "ai"` and `origin: "external"` ranges,
  since those are the only origins that actually go through the Tier
  1→2a→2b→2c→3(→4) ladder. Ranges with `origin: "human"` or `origin: null`
  never entered that ladder at all — a human keystroke or an
  untouched/committed line has no "tier"; forcing one onto them would be
  misleading, not just unused. Agent B, Agent C, and Agent D should treat
  `tier` as optional and must not assume it is present on every range.
- `timestamp` (number)

The engine exposes: a way to push a `NormalizedChange` batch for a document
identity in; a way to read the current `AttributedRange[]` for a document
identity; a subscribable event that fires whenever a document's ranges
change (so Agent C's decoration refresh doesn't have to poll). It also
exposes document lifecycle entry points (open — optionally seeded with a
restored `AttributedRange[]` from Agent B's persistence layer — close,
save) mirroring Tourist's `onOpen`/`onClose`/`onSave`.

**NEW — `listTrackedDocIds()` (added after Agent C's Phase 3 implementation
surfaced a real gap).** The engine also exposes a method returning every
document identity it currently holds state for, tracked or untouched. This
was simply missing from the first version of this contract — it predates
the always-on, workspace-wide tracking decision being fully threaded through
every contract shape, and without it the workspace-level attribution
view/panel (Phase 3) has no way to enumerate "every tracked file" at all,
open or closed. Agent C's workspace-level view calls this (plus Agent B's
matching `listPersisted()`, contract item 4) to build its aggregate rollup.

**NEW — `renameDocument(oldId, newId)` (added after Agent C's Phase 3
implementation).** Only the Persistence API (item 4) had a rename-notification
method in the original contract; the engine also keeps in-memory per-docId
state (piece-table ranges, undo/redo content-hash history, the internal
mirror text buffer) that must be re-keyed on rename too. Without this,
Agent C had to work around the gap with a close-then-reopen hack, which
loses in-memory state a real rename shouldn't lose. `renameDocument` moves
all of a document's live in-memory engine state from `oldId` to `newId`
in place; Agent C's rename handling should call this **and** Agent B's
persistence rename-notification together (both are needed — one re-keys
live engine state, the other re-keys persisted history).

**1b. NEW — whole-file-diff ingestion (what Agent A's own workspace-watcher
adapter feeds into Agent A's own engine, for tracked files with no open
document — internal to Agent A's ownership, listed here because Agent D's
edge-case tests assert against its output the same way they do for the live
path):** a document identity, the newly read on-disk content, a timestamp,
and an **optional** `previousContent` override. **REVISED per Agent A's
Phase 1 implementation:** the original contract specified the baseline
content as a required input resolved from "Agent B's persisted history" —
implemented literally, that would force Agent A's workspace-watcher adapter
to reach directly into Agent B's persistence layer to fetch a baseline,
crossing the Agent A/Agent B ownership boundary this plan otherwise keeps
clean. Instead, `previousContent` is optional: when the caller omits it, the
engine resolves its own baseline via its own injectable `SnapshotStore`
(owned inside `src/core/`, per Phase 1's generalized content-snapshot
store), itself seeded lazily from whatever it has already observed this
session. A caller may still pass `previousContent` explicitly as an
override (e.g. if Agent C's activation wiring already has a
persisted-history baseline in hand from Agent B and wants to seed the
engine's snapshot store directly on first load, avoiding a redundant disk
read), but nothing requires it. The engine computes the diff internally and
classifies it through the same tier logic, skipping the dirty-before/after
check entirely, and emits ordinary `AttributedRange`s indistinguishable in
shape from the live path's output.

**1c. NEW — tracking-scope / exclusion predicate contract:** a single
function-shaped contract — given a file path, return whether it is tracked
— owned by Agent A (backed by `.gitignore` parsing plus the default
excludes) and exposed for reuse. Agent C's workspace-level view and any
future file-listing UI must call this same predicate rather than
reimplementing exclusion logic, so "what's tracked" never disagrees between
the engine and the UI.

**1d. NEW — git-operation suppression (added after Agent A's Phase 1
implementation; Phase 4's hardening checklist required this behavior but the
original contract had no mechanism for it).** A method on the core engine's
public API: `engine.setGitOpSuppression(workspaceId, boolean)`. While
suppression is on for a workspace, changes that would otherwise land as Tier
2 ("ai") or Tier 3 ("external") are held back as unmarked (`null`) instead —
the git-guard-and-reconcile behavior ported from Tourist's
`tracker.ts`/`git.ts`, so checkout/pull/merge/rebase/stash aren't
misattributed.

**Ownership call (explicit, recorded now so it isn't ambiguous when Agent C
is briefed):** this method is called **internally, by Agent A's own
workspace-wide watcher adapter** (`src/adapters/`), not by Agent C. Agent
A's watcher already observes the whole workspace tree for the whole-file-
diff path; it additionally watches for git-internal-directory activity
(`.git/HEAD`, `.git/index`, `.git/MERGE_HEAD`, `.git/rebase-merge`, etc.),
resolved through the same worktree-`.git`-as-file indirection handling
Agent B's Phase 2 fallback resolver already implements. **This resolution
logic must be shared, not duplicated:** factor the worktree-aware
`.git`-directory resolver Agent B builds for its raw-filesystem fallback
(Phase 2) out into a small utility both Agent A's adapter and Agent B's
fallback path import, rather than each agent re-implementing `.git`-as-file
parsing independently and risking the two silently diverging over time.
Keeping suppression self-contained inside Agent A means Agent C does not
need to detect or wire anything for this to work, and it keeps working even
when the VS Code Git extension is disabled. If Phase 0 experiment 6 finds
that `vscode.git`'s `Repository.state` exposes a clean, sufficiently timely
"operation in progress" signal, Agent C's git-integration wiring **may**
additionally call `setGitOpSuppression` as a higher-precision corroborating
layer on top — mirroring the Tier-2a-primary/Tier-2b-additive pattern used
elsewhere in this plan — but that is an optional future enhancement, not a
v1 requirement; Agent A's adapter-based path is the one Agent B and Agent C
should assume is authoritative for now.

**3. Corroboration-state input (what Agent A's adapters write into the core's
shared corroboration-state store):**
- A signal record per workspace identity: `source` (`"lock-file"` /
  `"shell-integration"` / `"process-scan"`), `active` (boolean), `since`
  (timestamp), and adapter-specific metadata (e.g. matched `workspaceFolders`
  for the lock-file adapter, `commandLine`/`cwd` for shell-integration). The
  tier-classification logic in `src/core/` reads this store; only Agent A's
  own adapters and Agent A's own engine touch it, so this is an internal
  contract within Agent A's ownership, not a cross-agent one — listed here
  for completeness since Agent D's edge-case tests will assert against it.

**4. Persistence API (what Agent C's `extension.ts` and Agent A's engine —
for restore-on-open — call into Agent B's module):**
- Load: given a document identity's content-hash and its resolved
  `(repoRoot, branch)` key, return a previously persisted `AttributedRange[]`
  if the content hash matches, else nothing.
- Save: given a document identity, its current content hash, its resolved
  `(repoRoot, branch)` key, and its current `AttributedRange[]`, persist it.
- Resolve key: given a document identity (its `vscode.Uri`, which only
  Agent C's side of the boundary ever touches — Agent B's core save/load
  functions take an already-resolved `(repoRoot, branch)` string pair, not a
  `Uri`, keeping Agent B's storage logic itself editor-API-free where
  possible), return the current `(repoRoot, branch)` pair via the
  `vscode.git` API, or the raw-filesystem fallback.
- Rename notification: given an old and new document identity, re-key
  existing persisted history from old to new without loss.
- **NEW — `listPersisted()` (added after Agent C's Phase 3 implementation
  surfaced a real gap, paired with the engine's `listTrackedDocIds()`
  above):** returns every document identity this module has a persisted
  snapshot for, per `(repoRoot, branch)` key. Needed for the same reason as
  `listTrackedDocIds()` — the workspace-level view can't enumerate
  closed-and-never-opened-this-session files without it, and this was
  simply missing from the first version of the contract.
- **Mode toggle:** a single boolean (or equivalent setting-backed flag),
  read by Agent B's module itself — Agent C's settings UI only flips the
  setting, it never branches on mode; all mode-branching logic lives inside
  Agent B's module so the contract Agent C and Agent A build against never
  changes shape regardless of which mode is active.
- **git-notes API (Mode B only) — the toggle fully gates the whole API, not
  just sync. Made unambiguous here after a real drift was found between this
  document and GOAL1.md, not just an ambiguity in either one.** When
  `tourist.gitNotesSync` is off (the default), **every** git-notes
  operation — write, read, push, fetch, and merge — is a no-op, including
  local write/read. This is deliberate, not an oversight: Phase 4's
  hardening checklist already has an explicit "git-notes-mode-off leak
  check" row (zero git-notes commands, zero related network calls when the
  toggle is off) that only makes sense under this fully-gated
  interpretation — a version where local write/read stayed active
  regardless of the toggle (with only push/fetch gated) would fail that
  test outright, since it would still issue `git notes` commands with the
  toggle off. **PLAN1.md's fully-gated version is authoritative**; if
  GOAL1.md's wording implies otherwise (e.g. "only push/fetch are
  gated"), GOAL1.md is the one being corrected to match this document, not
  the reverse. The API itself: write a note for a commit SHA given a
  structured attribution payload; read a note for a commit SHA, returning
  the structured payload or nothing if none exists; push notes to a named
  remote; fetch notes from a named remote; and a merge operation that, given
  a local and a remote note version for the same commit, returns a merged
  payload per the field-level, tier-then-recency merge strategy described in
  Phase 2 (exact mechanics pending Phase 0 experiment 7's findings). The
  setting name is **`tourist.gitNotesSync`** — standardized here as the one
  authoritative name; GOAL1.md's apparent use of `tourist.shareAttribution`
  for the same toggle is being corrected to match, not the reverse.

**5. Decoration/status-bar consumption (entirely inside Agent C's ownership,
listed for clarity):** Agent C's rendering code subscribes to the core
engine's range-changed event and maps `origin` → decoration type (three
visually distinct treatments: ai / human / external — `null` renders
nothing), and separately aggregates `AttributedRange[]` lengths into the
status-bar percentage rollup (`ai` / `human` / `external` / total, extending
Tourist's `stats.ts` two-bucket model to three).

Because these contracts are specified up front, Agent B can build and
unit-test the persistence module (both modes) against a hand-written fixture
`AttributedRange[]` before Agent A's real engine exists, and Agent C can
build decorations and the workspace-level view against a hand-written mock
engine (a fake object implementing the same subscribe/read shape, returning
fixture data) before Agent A's real engine exists.

### Dependency & sequencing graph

**Stage 0 (sequential, blocking, short — days not weeks).** Agent D runs the
Phase 0 spike alone. While this runs, Agents A/B/C do *not* sit idle — they do
contract-driven scaffolding in parallel: agree the exact field lists above
(this document is the starting draft; any agent who thinks a shape is wrong
raises it before writing real logic against it), set up each module's
directory/build/test skeleton, and (for Agent A) begin the parts of Phase 1
that Phase 0 cannot change no matter the outcome — e.g. the piece-table's
core splice/remap algorithm structure, independent of whether ordering
defense turns out to be strictly necessary (build it defensively either way;
Phase 0 item 5 only confirms whether that defensiveness is load-bearing or
merely cheap insurance).

**Stage 1 (parallel, starts once Stage 0's findings land for items 1, 4, 5 —
these are the hard blockers).**
- Agent A finalizes and implements the real Tier 1/2a/2b/2c/3 classification
  logic and the piece-table, using Stage 0's answers (especially whether a
  VS Code-extension-specific "diff review in progress" state is needed).
- Agent B implements persistence against the *contract* (not the real
  engine) — this can genuinely start at Stage 0 in parallel and does not
  need to wait for Stage 1. Mode A (local storage) only needs Stage 0 item 6
  (git branch-change events), independent of items 1/4/5, and can be
  finished and shipped on its own timeline. Mode B (git notes) additionally
  needs Stage 0's new item 7 (git notes mechanics) before its
  conflict-resolution logic is finalized — since Mode A and Mode B are
  separate submodules behind one toggle (per the module ownership map),
  Agent B is not blocked end-to-end by item 7, only on completing Mode B
  specifically.
- Agent A's workspace-wide watcher/exclusion-filter adapter (new, per the
  always-on tracking decision) has no Phase 0 dependency at all and can be
  built from Stage 0 alongside the rest of Agent A's scaffolding — its
  *performance* characteristics are validated later, in Stage 2/Phase 4,
  against Agent D's large-repo fixture.
- Agent C implements decorations/status bar/commands/settings and the new
  workspace-level view against the *mocked* engine and a *mocked*
  persistence API — also genuinely parallelizable from Stage 0, blocked only
  on the contract being stable enough to mock, not on any real
  implementation existing.

**Sync point 1 — mock-to-real swap.** Once Agent A's real engine passes its
own unit tests against Agent D's fixtures (Phase 1 exit criteria), Agent C
swaps its mock engine for the real one and Agent B's persistence module is
wired to the real engine's actual `AttributedRange[]` shape (should be a
non-event if the contract held; a real integration bug if it wasn't). Agent D
re-runs its fixture suite against the real engine directly (not just through
mocks) at this point.

**Sync point 2 — full wiring.** Agent C's `extension.ts` wires Agent A's
engine + Agent B's persistence + Agent C's own rendering together for the
first time as a complete, runnable extension. This is the first point a
human (or Agent D) can actually open VS Code and see decorations driven by
real Claude Code edits end to end.

**Stage 2 (Phase 4, hardening) — mixed ownership, cross-review required.**
Agent D drives the full edge-case checklist from Part 1 against the
integrated system. Findings route back to the owning agent (Agent A for
tier/piece-table bugs, Agent B for persistence/rename/worktree bugs, Agent C
for rendering/wiring bugs) rather than Agent D fixing things itself, except
genuinely trivial one-line fixes — the point is that the agent who built a
piece of edge-case handling does not get to be the sole judge of whether it
actually works; Agent D (or, resource permitting, a rotation where Agent B
reviews Agent A's tier logic and vice versa) independently verifies it.

**Stage 3 (Phase 5, packaging) — single agent, likely Agent C or Agent D**,
since it's mostly metadata/README/cleanup and a final smoke pass rather than
new module work; no parallelism benefit here.

### Integration / review checkpoints

**Execution model: fully autonomous, human reviews once at the end.** The
human does not gate or approve progress between phases or between the
stages/sync points above. Once kicked off, the four agents run the full
dependency graph (Stage 0 through Stage 3) autonomously: an agent advances
past a dependency the moment its upstream exit criteria are actually met,
and the checkpoints below are **agent-to-agent** sign-offs (cross-checking
each other's work, since correctness is the top priority and no agent
should self-certify its own edge-case handling) — not points where a human
needs to review and say "go." The human's single review happens once, after
Stage 3 / Phase 5's release gate, over the fully integrated, packaged
result — not mid-build.

1. **Post-spike checkpoint.** Agent D presents `spike/FINDINGS.md` to all
   agents before Stage 1's "hard blocker" work begins. Any contract field in
   Part 2 that a finding invalidates gets updated here, once, in this
   document (or a superseding note), not silently reinterpreted per-agent.
2. **Contract-freeze / mock-to-real checkpoint (Sync point 1 above).**
   Agent A's engine must pass Agent D's fixture suite standalone before
   Agent C is asked to integrate the real engine — catches contract drift
   before it becomes a UI bug that's hard to attribute to the right layer.
3. **Full-wiring checkpoint (Sync point 2 above).** First end-to-end manual
   run: real editor, real Claude Code CLI edit, real Claude Code VS Code
   extension edit, both observed to decorate correctly. This is a go/no-go
   gate for entering Phase 4 — if either surface is visibly wrong here,
   Phase 4's edge-case work is premature.
4. **Independent edge-case review (Stage 2).** For each Phase 4 checklist
   row, the agent who did *not* write the relevant module signs off on the
   test result, not the implementing agent alone. Concretely: Agent A does
   not self-certify the `contentChanges`-ordering fix or the Tier-3
   external-tool test; Agent B does not self-certify the worktree/rename
   tests; Agent C does not self-certify the Live-Share/decoration-rendering
   test. Agent D coordinates this rotation and has final sign-off authority
   on the Phase 4 exit criteria.
5. **Release gate (Stage 3).** Full manual smoke pass on both surfaces from
   a clean VS Code profile before packaging; treated as a hard gate, not a
   formality, given the "correctness over shipping speed" priority. This
   pass (run by Agent D, per its mandate) is also the point at which the
   human's one-time end-of-build review takes place — the human reviews the
   integrated, packaged result and this pass's findings together, rather
   than any earlier phase's output in isolation.

### Suggested agent roles for v1 (self-contained mandates)

**Agent A — Core Detection Engine + Piece-Table.** Owns `src/core/` and
`src/adapters/`. Mandate: implement the 3-tier (+ optional Tier 4) signal
model and the position-mapped range structure exactly as specified in
RESEARCH1.md §7 and this plan's Phase 1, as a `vscode`-independent module
consuming `NormalizedChange` input and producing `AttributedRange` output per
the contracts above, plus the four platform adapters (lock-file watcher,
terminal-shell-integration bridge, process-scan fallback, hook-log
reader/installer) that feed its corroboration-state store. **Also owns the
always-on, workspace-wide tracking design**: the whole-file-diff ingestion
path for tracked files with no open document, the generalized
content-snapshot/baseline store, the workspace-wide file-system watcher
adapter, and the `.gitignore`-plus-default-excludes tracking-scope predicate
that Agent C's UI must reuse rather than reimplement. Must not import
`vscode` in `src/core/` except behind clearly injectable interfaces. Consumes
Phase 0 spike findings for items 1, 2, 4, 5 before finalizing tier semantics
(the workspace-watcher work itself has no Phase 0 dependency and can proceed
immediately). Deliverable is fully unit-testable against fixtures without a
real editor. Proceeds autonomously per the dependency graph above — no
mid-build human sign-off is expected before moving from one sub-task to the
next.

**Agent B — Persistence + Git Integration.** Owns `src/persistence/`.
Mandate: implement dual-mode storage per the revised Phase 2 — **Mode A**
(default): branch/worktree-scoped, content-hash-anchored local storage, a
read/write API keyed by `(repoRoot, branch)`, `vscode.git`-based repo/branch
resolution with a documented raw-filesystem worktree-aware fallback,
rename/move re-keying so history survives a file move, and retention/aging
equivalent to Tourist's existing `retentionDays` behavior. **Mode B**
(opt-in, toggle-gated): git-notes-based write/read/push/fetch under
`refs/notes/tourist-attribution`, scoped to each commit's own diff, plus a
structured (field-level, tier-then-recency) merge strategy for concurrent
note conflicts — build this sub-path against Phase 0 experiment 7's findings
once available, but do not block Mode A's completion on it; ship Mode A
fully functional independently. **Also owns rewrite continuity** (a
distinct, more dangerous failure mode than the conflict case: silent data
loss, not a conflict to resolve): installing a custom `post-rewrite` hook
(chaining with, not clobbering, any pre-existing husky/`pre-commit`-
framework hook in that slot) that carries notes across
`amend`/`rebase`/interactive-rebase-squash onto their new SHA using the same
structured merge logic, a `post-commit` hook to recover `-x`-flagged
cherry-picks via their message trailer, the one-time local
`notes.rewriteRef`/`notes.rewrite.*` git-config setup, and a visible (not
silent) indication when a cherry-pick without `-x` leaves a note
unrecoverable — build this against Phase 0 experiment 8's findings (already
strongly pre-validated during planning on git 2.50.1; needs re-confirmation
on the team's actual target git version, not from-scratch investigation).
Also owns proving the mode-off state has zero git-notes side effects. Can
start immediately against the `AttributedRange` contract shape without
waiting for Agent A's real engine. Proceeds autonomously through Mode A and,
once experiments 7 and 8 land, Mode B, without waiting for a human
checkpoint between them.

**Agent C — VS Code UI / Decorations Layer.** Owns `src/vscode-integration/`
and `src/extension.ts`. Mandate: implement Phase 3 — the document-change
listener translating real VS Code events into Agent A's `NormalizedChange`
input shape, three-way (ai/human/external) gutter decorations extending
Tourist's existing blue/orange border pattern, status bar percentage rollup,
**the new workspace-level attribution view/panel** (reading the whole-
workspace state Agent A's engine and Agent B's persistence now maintain
continuously), commands (toggle tracking, toggle markers, install/verify
hook, push/fetch attribution notes), and settings (including the new
exclusion-policy override and the `gitNotesSync` toggle). **Explicitly out
of scope: no "fix line attribution" equivalent command** — dropped from v1
per the scope-narrowing note in Phase 3; do not build a placeholder for it.
Build and validate
against a hand-written mock engine and mock persistence module first (per
the contracts above); swap to the real modules at Sync point 1/2. Owns the
final activation wiring in `extension.ts`. Proceeds autonomously; integrates
with Agent A/B's real modules as soon as they clear their own exit criteria,
without waiting on a human review in between.

**Agent D — Test Harness + Edge-Case Verification.** Owns `spike/` and
`test/fixtures/`; drives Phase 0 first (before the other three agents do
non-scaffolding work), then owns Phase 4 end to end. Mandate: build and run
the Phase 0 throwaway spike extension per the exact experiment list in Part
1 — **including the new experiment 7 (git notes write/read/sync/conflict
mechanics)**, coordinating its scenario design with Agent B since Agent B
implements against its findings; produce `spike/FINDINGS.md`; design the
shared fixture format other agents' unit tests build on, **plus the new
large-repo performance fixture and two-clone git-notes-conflict fixture**
needed for Phase 4's new rows. Then, once Sync point 2 is reached,
independently drive every row of the Phase 4 edge-case checklist (including
the new performance/scale and git-notes-conflict rows) against the
integrated system and route findings back to the owning agent rather than
self-certifying or silently patching around them. Also runs the final Phase
5 smoke pass unless reassigned to Agent C — this pass is where the human's
one-time, end-of-build review takes place; Agent D does not need or wait for
any human sign-off before or between the phases leading up to it.

---

## Assumptions made while writing this plan (confirm before Phase 0 starts)

RESEARCH1.md leaves several things genuinely open or defers them to "worth a
deliberate comparison" without deciding; this plan had to make calls to stay
concrete. Flagging the load-bearing ones:

1. **Adapter ownership.** RESEARCH1.md doesn't specify module boundaries at
   all — the decision to put all four platform adapters (lock-file,
   shell-integration, process-scan, hook-log) under Agent A (Core Engine)
   rather than splitting them out as a separate "platform adapters" agent or
   folding shell-integration into Agent C (since it's a `vscode` API) is this
   plan's own architectural call, made to keep tier semantics and their
   signal sources co-owned by one agent.
2. **Superseded — persistence format.** The first draft assumed local-JSON-
   only persistence; the human has since decided on dual-mode (local default
   + opt-in git notes), which this revision implements throughout Phase 2
   and Part 2. That top-level decision is no longer an open assumption, but
   it introduces several new, genuinely unresolved sub-questions the human
   should confirm before Phase 0 starts, since RESEARCH1.md never researched
   git notes at all:
   - **Git notes conflict-merge exact mechanics.** This plan proposes a
     custom field-level JSON merge (by tier confidence, then recency) rather
     than trusting git's built-in textual notes-merge strategies, but
     whether that's driven through `git notes merge -s manual` interception,
     a registered custom merge driver, or a fully separate fetch-merge-write
     flow outside git's own notes-merge machinery is unverified — this is
     now Phase 0 experiment 7, but the *design direction* (custom structured
     merge over git's textual strategies) is this plan's own call, not
     something RESEARCH1.md validated.
   - **Git notes rewrite continuity — largely de-risked, one accepted gap
     remains.** Unlike the item above, this sub-question (Phase 0 experiment
     8) was empirically tested during this planning pass, not left purely
     theoretical: on git 2.50.1, `commit --amend` and `rebase` (including
     squash) reliably preserve notes once `notes.rewriteRef` is configured
     and a custom `post-rewrite` hook is installed, but `cherry-pick` is
     **structurally uncoverable** by any git hook or config — confirmed
     directly, with and without `-x`. This plan accepts "cherry-pick without
     `-x` silently loses the note, with an explicit UI indication rather
     than silence" as a documented v1 limitation rather than a solvable
     gap — confirm this trade-off is acceptable, since fully closing it
     would require either mandating `-x` usage or a much heavier
     content-similarity-based reattribution heuristic this plan does not
     propose. Also confirm before Phase 0: the exact target git version(s)
     in use, since notes-rewrite behavior is not guaranteed stable across
     git releases and this finding should be re-verified, not assumed
     to generalize.
   - **Sync policy: manual commands only, no auto-sync.** This plan assumes
     v1 ships explicit "Push/Fetch Attribution Notes" commands only, with
     auto-sync-on-`git push`/`git pull` deferred as a stretch goal. Confirm
     this is the right default rather than wanting auto-sync in v1 despite
     the added silent-network-call surface that implies.
   - **Note granularity.** This plan assumes each git note is scoped to just
     the lines a single commit's diff touched (not a full-file snapshot), to
     keep notes small and more mergeable. Not validated against real note
     size/performance on a large commit.
   - **Exclusion-policy implementation choice.** Respecting `.gitignore` plus
     hardcoded default excludes (`node_modules`, build/dist, `.git`) is
     assumed to use a standard `.gitignore`-parsing approach (e.g. an
     existing, mature library) rather than a hand-rolled parser — a
     reasonable industry-standard choice, but not specifically vetted for
     this project's needs.
   - **Workspace-watcher performance strategy for large repos.** The
     always-on, workspace-wide tracking decision introduces a real
     engineering risk RESEARCH1.md never considered (it predates that
     requirement): per-file OS watcher overhead, activation-time snapshot
     cost, and memory footprint on large monorepos. This plan defers
     resolving the exact strategy (lazy seeding, directory-level vs.
     per-file watching) to Phase 1's design and Phase 4's benchmarking
     rather than treating it as settled. If the target repos are known to be
     very large, consider adding a lightweight watcher-scaling prototype to
     Phase 0 rather than discovering the answer only at Phase 4.
3. **Tier 4 (stylometric) is out of v1 scope entirely**, not even stubbed,
   consistent with "correctness over feature breadth" — RESEARCH1.md itself
   calls it "explicitly optional/experimental." Confirm this is acceptable
   rather than wanting a disabled-by-default stub shipped in v1.
4. **Rename detection is exact-content-hash-match only** (no fuzzy/
   similarity matching for a file that was renamed *and* edited in the same
   operation, e.g. a large refactor-and-rename). RESEARCH1.md doesn't address
   this gap; this plan treats it as an acceptable, documented v1 limitation
   rather than a blocking design problem.
5. **Target shells/platforms for Phase 0 experiment 3** (which of bash/zsh/
   fish/pwsh, and whether Windows is in scope at all for v1) aren't specified
   anywhere in RESEARCH1.md or the locked scope beyond "VS Code only" — this
   plan assumes macOS/Linux with bash/zsh as the primary spike targets (matching
   the actual dev environment this plan was written in) and treats Windows/
   pwsh/fish as best-effort. Confirm the real target platform matrix before
   Phase 0 runs, since it changes which shell-integration and process-scan
   findings actually matter.
