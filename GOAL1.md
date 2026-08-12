# GOAL1 — v1 Goals & Vision: Live AI-vs-Human Line Attribution (VS Code)

Internal planning doc. Grounded in `RESEARCH1.md` (this repo) and the existing
`tourist-raw` extension (`/Users/harshittomar/tourist-raw`), whose Feature 2
(live AI/human line attribution) this project takes as its sole starting
point and aims to make substantially more correct.

---

## 1. Problem statement

Tourist's live attribution already works well enough to be useful, but its
core heuristic — "disk write while the document was clean before and after =
Claude Code" — conflates *any* silent external file rewrite with Claude Code
specifically. Concretely: Tourist's own `README.md` admits any tool that
rewrites an open, unmodified file (a formatter, another AI agent, `git`
itself outside the two operations it explicitly guards against, Live Share,
a codegen script) is indistinguishable from Claude Code under its heuristic
and gets silently mislabeled "ai" (or, for git, merely left unmarked via a
special-cased guard that doesn't generalize). Its persistence is keyed by
`fsPath`, so a rename orphans history; its `.git/HEAD`/`.git/index` watcher
assumes `.git` is a directory, which breaks in git worktrees — the exact
workflow Claude Code's own docs recommend for parallel sessions; its flat
per-line array desyncs from `doc.lineCount` with no self-heal; and its
multi-edit splice loop assumes `contentChanges` arrive bottom-to-top, an
ordering VS Code does not guarantee (Microsoft bug reports #11487, #111548).
On top of all that, Tourist and most competitors only track files that
happen to have an open editor tab — Claude Code's often-larger footprint
across a codebase (scaffolding a new module, editing config files, touching
files a developer never opens in that session) is simply invisible until,
if ever, someone opens that exact file later. The eight competing
marketplace extensions surveyed in `RESEARCH1.md` don't fix any of this
either — most substitute a *fuzzier* signal (keystroke speed, paste-size,
stylometric fingerprints, undisclosed server-side classifiers) for
Tourist's already-fragile one, and none combine Claude Code's own hook
events (true ground truth) with corroborated disk-write inference. The
result across the whole landscape is tools that report a confident binary
ai/human label even when they have no real basis for it. That's the
specific thing worth fixing: a developer relying on this signal (for review
focus, audit trails, or simply trusting their own memory of what they
wrote) is currently better served by an honest "I don't know" than a wrong,
confident answer — and no existing tool, including Tourist, draws that
line.

## 2. v1 scope

**v1 ships:** a VS Code extension whose only feature is live, per-line
AI-vs-human-vs-external/unknown attribution, tracked continuously across
the whole workspace — not gated on whether a file happens to have an open
editor tab — for exactly the two locked-in surfaces: the Claude Code CLI in
a plain terminal, and Claude Code via the official Claude Code VS Code
extension. Nothing else. Concretely, in scope:

- **Tier 1 (ground truth): the Claude Code hook is mandatory, not optional.**
  Unlike Tourist (where hook install is a separate, skippable command), v1
  treats `PreToolUse`/`PostToolUse` hook registration as part of setup,
  because it is the only signal that is ground truth rather than inference,
  and it is confirmed to cover both locked-in surfaces identically (the
  model calls the same `Edit`/`Write`/`MultiEdit` tools regardless of
  terminal-vs-extension). Correctness-over-speed argues for closing this gap
  rather than shipping Tourist's "best-effort, verify it yourself" posture.
- **Tier 2a (lock-file corroboration) is mandatory.** Watching
  `~/.claude/ide/*.lock` (`$CLAUDE_CONFIG_DIR/ide/` override respected) to
  corroborate a disk-write-while-clean event against an active Claude Code
  IDE session for this workspace. This is what lets v1 distinguish "ai" from
  "external/unknown" per the 3-tier model, and it's the direct fix for the
  false-positive class described in §1.
- **Tier 3 (explicit "external/unknown" bucket) is mandatory and is the
  headline differentiator.** A disk write while clean, with no corroborating
  signal, is rendered as a distinct third state — never defaulted to "ai."
- **Whole-workspace, always-on tracking — not gated on an open editor tab.**
  Tier 1 (hook) coverage and Tier 2a (lock-file) corroboration extend to
  every file in the workspace via a workspace-wide file system watcher, not
  just `onDidChangeTextDocument`/`isDirty` events (which only exist for
  documents VS Code currently has open). For a file with no open editor tab
  there is, by construction, no possibility of a VS Code-mediated human
  keystroke, so the 3-tier classification collapses cleanly: hook-covered →
  Tier 1 (ai); uncorroborated-but-lock-file-confirmed → Tier 2a (ai);
  neither → Tier 3 (external/unknown). Decorations still only *render* in
  editors that are actually open (there's no gutter to paint on a closed
  file), but the underlying attribution is recorded the moment the edit
  happens, so opening a previously-untouched file immediately shows correct
  history — this turns what Tourist ships only as an optional, hook-only
  add-on (its own known-gaps list: "AI edits to files you don't have open")
  into mandatory, always-on, multi-signal coverage. By default, tracking
  respects `.gitignore` plus common excludes (`node_modules/`, build/dist
  output directories, `.git/`) — these are never watched or attributed, to
  keep the always-on watcher from wasting cycles on generated/vendored
  content.
- **The piece-table/position-mapped range structure is mandatory,** replacing
  Tourist's flat per-line array, specifically to fix the line-desync bug and
  to defend against unordered `contentChanges` structurally rather than by
  convention.
- **Git-native storage backend, gated entirely behind a single
  `tourist.gitNotesSync` toggle (default: off).** This is a single on/off
  switch for the *whole* git-notes subsystem, not just sharing/sync. **Off
  (default):** the git-notes subsystem is completely inert — zero git-notes
  commands of any kind (no write, no read, no push, no fetch, no merge) and
  zero related network calls. Committed attribution instead persists in a
  local, non-git-notes store (the same live/uncommitted cache described in
  the next bullet keeps holding it after commit too), exactly as private as
  Tourist's local-storage model. **On:** v1 piggybacks on git's own object
  store rather than inventing a custom compressed format — attribution for
  committed lines is written as a git note in a dedicated namespace
  (`refs/notes/tourist-attribution`), read back to restore state (e.g. after
  a fresh clone), and, still governed by the same toggle, pushed to and
  fetched from the user's configured remotes so a team can share attribution
  history for review/audit purposes, with corresponding merge handling for
  concurrent note updates. This is a storage/format decision, not an
  authorship-determination change — the underlying tiered inference (hooks +
  corroborated disk-writes) is unchanged; only *where the result lives, and
  whether it's git-notes-backed at all,* changes. Whenever notes are in use,
  they remain out-of-band by git's own design: they don't touch commit
  hashes, don't appear in `git diff`/`git log -p`, and don't show up in PR
  diffs — a commit and its attribution note can be inspected or shared
  independently.
- **Git-worktree-aware, multi-root-aware branch scoping** using the
  `vscode.git` extension API (`repository.state.HEAD.name`) as the primary
  source of truth for the *live, uncommitted* attribution cache, with
  correct `.git`-as-file (worktree indirection) handling as the fallback
  path — fixing the two file/branch-identity bugs named in the locked
  constraints. With `tourist.gitNotesSync` on, once lines are committed their
  attribution moves to a commit-keyed git note (previous bullet), which has
  no branch-name-collision exposure at all — a strictly more robust key than
  branch+repo-root once history is committed. With the toggle off, committed
  attribution simply stays in this same local, branch-scoped store.
- **File rename/move migrates attribution history** (via
  `onDidRenameFiles`) instead of orphaning it under the old `fsPath`, for the
  live/uncommitted cache; when `tourist.gitNotesSync` is on, attribution
  already captured as a git note stays correctly associated with its
  commit's own tree (notes are commit-keyed, not path-keyed, so a later
  rename doesn't retroactively affect history already committed).
- Colored gutter/border decorations for three distinct, user-visible states
  — ai / human / external-unknown — live as the user types in any currently
  open editor, matching Tourist's baseline UX (this is not a UX redesign
  project). The external/unknown state is a real third color in v1, not
  merely an internal classification bucket that happens to render as
  unmarked.

**Explicitly deferred out of v1 (future direction, not abandoned):**

- **Sub-line / character-level granularity.** The piece-table structure is
  adopted in v1 *because* it's the right foundation for this, but v1 itself
  still attributes at whole-line granularity, same as Tourist. Justification:
  shipping sub-line attribution correctly requires the position-mapped
  structure to already be solid and battle-tested at line granularity first;
  attempting both at once risks getting neither right, which directly
  violates the correctness-over-breadth priority.
- **Tier 2b (shell-integration corroboration) and Tier 2c (process-scan
  fallback).** Both are real per `RESEARCH1.md` §3/§2A, but narrower or more
  fragile than Tier 2a (2b only covers VS Code's integrated terminal with
  shell integration active; 2c is explicitly weaker on Windows and is a
  fallback-of-a-fallback). v1 ships with Tier 2a only; a bare-terminal
  Claude Code session that is never `/ide`-connected and has no hook
  installed falls through to Tier 3 ("external/unknown") rather than being
  guessed at by a weaker signal. This is a deliberate correctness trade-off:
  a known gap surfaced honestly beats a fragile signal papering over it.
- **Tier 4 stylometric/fingerprint fallback.** Off by default, not built in
  v1. Per `RESEARCH1.md` §5, every method in this family (perplexity/
  burstiness, DetectGPT-family, code-fingerprinting) is either compute-heavy
  or self-admittedly brittle/gameable, and none should ever outrank a
  hook or corroborated-disk-write signal. Not worth v1 engineering budget.
- **The "Fix Line Attribution" LLM-assisted correction feature** (Tourist's
  intent-based reclassification of ambiguous lines using recent prompts).
  Deferred, not cut. Justification: it is explicitly best-effort inference
  layered on top of the grounded tiers, not itself a correctness fix to the
  attribution mechanism — v1's job is to get Tiers 1–3 (the mechanism) right
  first. Bolting on an LLM-assisted disambiguator before the underlying
  disk-write/hook signal is proven solid would spend effort polishing a
  layer built on a foundation not yet validated by the open spike questions
  in §5 below.
- **Prompt scoring (Tourist's Feature 1) entirely.** Out of scope by design —
  this project has one feature, not two.
- **Windows: best-effort only, not a v1 correctness target.** Tier 1 (hooks)
  and Tier 2a (lock-file watching) are OS-agnostic and expected to work.
  But `RESEARCH1.md` §2A confirms `ps-list` cannot reliably match a
  Windows `claude` process to a workspace, and §3 confirms shell integration
  excludes plain `cmd.exe` — both irrelevant to v1 anyway since 2b/2c are
  deferred, but it means Windows has no fallback path if hook install or
  lock-file watching fails for any reason. v1 targets macOS/Linux as the
  correctness bar; Windows is expected to work but is not blocking.

## 3. Non-goals

- **Other editors.** VS Code only, per locked scope — no abstraction layer,
  no JetBrains/Neovim/Zed support, ever, for this project.
- **Other AI coding tools.** GitHub Copilot, Cursor, Codeium, Windsurf, ChatGPT
  paste-ins, etc. are not attribution targets. Attributing their edits would
  require different, tool-specific signals (Tourist's README already scopes
  itself this way, and `RESEARCH1.md`'s corroboration signals — hooks, the
  `ide` lock file, `CLAUDECODE=1` — are all Claude-Code-specific by
  construction).
- **Retroactive/historical attribution.** Like Tourist, v1 only attributes
  edits made while the extension is running from that point forward. No
  backfill of a repo's existing history.
- **Server-side or cloud detection of any kind.** No phoning code home to a
  classifier (the Codespy pattern, explicitly flagged in `RESEARCH1.md` §1
  as a "hard no"). Local-first is a constraint, not a v1-only shortcut. This
  is independent of the `tourist.gitNotesSync` toggle (§2), which — even
  when on — only pushes/fetches a git ref between the user's own remotes,
  never to a third-party service, and which makes zero git-notes calls of
  any kind (local or remote) when off.
- **Adopting git-ai's push/self-report model.** v1 still *computes*
  attribution itself via hooks + corroborated inference (a pull-model) — it
  does not ask Claude Code to self-report via a `checkpoint`-style command
  the way git-ai's agents do. What v1 *does* deliberately borrow from git-ai
  is git notes as a storage substrate (§2) — that is a decision about where
  our own computed result lives, not an authorship-determination mechanism,
  and it does not make this a push-model/self-report tool the way git-ai is.
- **Tracking gitignored, vendored, or excluded content.** Files matched by
  `.gitignore`, or by default excludes for `node_modules/`, build/dist
  output directories, and `.git/` itself, are never watched or attributed in
  v1. This is a deliberate boundary for the new whole-workspace/always-on
  scope (§2), not an oversight — most of that content is generated,
  vendored, or binary, and attributing it would be noise at best and a
  performance liability at worst.
- **A defined performance/scale SLA for very large repositories.**
  Whole-workspace, always-on tracking (§2) is a new v1 commitment with a
  real, currently unbenchmarked cost on very large monorepos (100k+ files)
  even with excludes applied. v1 does not promise a specific latency/CPU/
  battery budget beyond "respect the standard excludes and don't block the
  UI thread." See §5 for the associated risk.
- **"Rewrite code to look more human" or any evasion-adjacent feature.**
  Explicitly the opposite of this project's purpose.

## 4. Success criteria

**Must-have (correctness bar — each should have a demonstrable, repeatable
test, not just "seems to work"):**

1. A file edited by the Claude Code CLI in a plain terminal, with the hook
   installed, shows correct per-line "ai" attribution matching exactly the
   lines the `PreToolUse`/`PostToolUse` diff reports changed — verified by
   comparing hook-recorded line ranges against the decorations rendered.
2. The same scenario via the official Claude Code VS Code extension (Manual
   mode, Accept) produces the same correct result. This requires first
   resolving `RESEARCH1.md` §4/§8's open question #1 (diff-accept mechanics)
   empirically — see §5 below; success criterion is contingent on that spike
   being run and its answer being reflected in the implementation, not
   assumed.
3. A multi-cursor or multi-hunk AI edit whose `contentChanges` array is
   fabricated/forced out of bottom-to-top order (test harness, not relying on
   organically reproducing the VS Code bug) is still attributed correctly —
   demonstrating the piece-table remap is order-independent, unlike Tourist's
   splice loop.
4. Running a formatter (e.g., Prettier) on a clean, open file produces
   "external/unknown," never "ai" — the single clearest before/after
   regression test against Tourist's known false-positive class.
5. A `git checkout`/`pull`/`rebase`/`stash` that rewrites a clean open file
   is left unmarked/reconciled against branch history, not tagged "ai" or
   "external/unknown" — matching Tourist's existing (correct) git handling,
   generalized to not depend on `.git` being a directory.
6. The identical git operation performed inside a **linked git worktree**
   is handled correctly — i.e., branch/HEAD state is read via the
   `vscode.git` API (or correctly resolves the `gitdir:` indirection file if
   falling back to raw watching), not silently broken as it would be under
   Tourist's raw `.git/HEAD` watch. This is a named, testable regression
   against a documented Tourist bug class.
7. Renaming or moving an attributed file (`onDidRenameFiles`) preserves its
   attribution history under the new path; Tourist's fsPath-keyed persistence
   orphaning it is the explicit regression being fixed.
8. After many sequential edits (stress test: hundreds of small AI + human
   edits interleaved), `state` line count never desyncs from `doc.lineCount`
   — no unbounded mis-coloring below a divergence point, the specific
   self-heal gap named in Tourist's own known-gaps list.
9. A same-named branch in two different repositories in a multi-root
   workspace does not collide in persisted attribution (keyed by repository
   root + branch, not branch name alone).
10. No code content and no per-line attribution data ever leaves the local
    machine (no network calls other than what the user's own `claude` CLI
    already makes, and — when `tourist.gitNotesSync` is on — explicit git
    `push`/`fetch` of `refs/notes/tourist-attribution` to the user's own
    configured remotes only) — verifiable by inspection/network monitoring.
11. An AI edit made by the Claude Code CLI (hook installed) to a file with
    **no open editor tab** at the time of the edit is correctly recorded,
    and shows correct attribution the moment that file is later opened —
    proving tracking is workspace-wide and always-on, not gated on
    tab-open state (the mandatory generalization of Tourist's optional,
    hook-only "closed file" coverage).
12. A file matched by `.gitignore`, or living under `node_modules/`, a
    build/dist output directory, or `.git/`, is never recorded or
    attributed — verified by confirming no entry exists for it after edits
    that would otherwise trigger tracking.
13. The "external/unknown" Tier-3 state renders as a third, visually
    distinct gutter/border color in the editor — confirmed by inspecting
    the decoration type actually used, not just the internal classification
    value — so it is a real, user-facing signal, not merely an internal
    bucket that happens to render as unmarked.
14. With `tourist.gitNotesSync` **on**, attribution for a committed line
    round-trips correctly through a git note: write a note under
    `refs/notes/tourist-attribution` for a commit, then read it back
    (including from a fresh clone) and confirm the original ai/human/
    external classification is restored without needing any of the
    extension's own local storage.
15. **Mode-off leak check.** With `tourist.gitNotesSync` **off** (the
    default), no git-notes command of any kind — write, read, push, fetch,
    or merge — is ever invoked, and no related network call is ever made,
    across a full edit-and-commit cycle; verified by instrumenting/tracing
    git invocations and network activity, not just checking that push/fetch
    alone are skipped. Committed attribution in this mode is confirmed to
    live entirely in the local, non-git-notes store.
16. With `tourist.gitNotesSync` **on**, an explicit push/fetch of
    `refs/notes/tourist-attribution` correctly round-trips to a remote and
    back into a second clone.
17. Writing or updating a git note (toggle on) never changes the target
    commit's SHA, and the note's content never appears in `git diff`,
    `git log -p`, or a GitHub/GitLab PR diff by default — verified by
    comparing commit hashes before/after a note write and inspecting
    standard diff output.

**Nice-to-have (does not block v1, valuable if time allows):**

- Tier 2b (shell-integration) implemented as an additive precision layer on
  top of 2a for the integrated-terminal case.
- Tier 2c (process-scan) implemented as the bare-terminal fallback on
  macOS/Linux.
- A hover tooltip or similar affordance explaining *why* a line is
  "external/unknown" (e.g., "disk write detected, no active Claude Code
  session found"), beyond just showing the third color.
- Windows parity for Tier 2a beyond "expected to work, untested."

## 5. Key risks / open bets

Pulled directly from `RESEARCH1.md`'s CONFIRMED / PLAUSIBLE / UNVERIFIED
tagging — these are the load-bearing unknowns the whole plan rests on.

- **UNVERIFIED — NEEDS SPIKE, highest-impact: diff-accept mechanics in the
  official VS Code extension (`RESEARCH1.md` §4, §8 item 1).** It is not
  known whether accepting a diff produces a plain `fs.writeFile`-equivalent
  (heuristic works unchanged) or an editor-mediated document apply that can
  transiently dirty the "real" open tab (heuristic mislabels the edit
  "human" the moment a user so much as touches the proposed diff). **If it
  resolves unfavorably:** Tier 1 (the hook) still saves us for files it
  covers, but Tier 2a's fallback value for extension-surface edits degrades,
  and a VS Code-extension-specific document-identity branch becomes
  mandatory v1 work, not a stretch item. This must be the first thing
  spiked, per `RESEARCH1.md`'s own ordering — success criterion #2 above is
  explicitly gated on it.
- **CONFIRMED but narrower than hoped: the `~/.claude/ide/*.lock` mechanism
  only covers Claude Code sessions that are IDE-connected** (native
  extension, or `/ide` run manually in an external terminal). A bare
  terminal session that never connects produces no lock file. **If this
  turns out to be a larger fraction of real usage than assumed:** more edits
  fall into Tier 3 ("external/unknown") than users will expect from a tool
  billed as tracking "Claude Code CLI in a plain terminal" — mitigated by
  the hook being mandatory (§2), but only for files the hook actually
  observes; a session with the hook not yet active when Claude starts (e.g.
  first-run before setup completes) has no safety net. Fallback: message
  this limitation honestly in-product rather than silently degrading.
- **PLAUSIBLE, not demonstrated: correlating a lock file's `pid`/
  `workspaceFolders` to *this specific* workspace in monorepo/`--add-dir`/
  nested-folder setups (`RESEARCH1.md` §2 Approach A/C).** If matching is
  looser than assumed, Tier 2a corroboration could false-positive across
  unrelated workspaces sharing a machine. Fallback: err toward stricter
  matching (exact `workspaceFolders` containment) even if it costs recall,
  consistent with the "don't guess" principle in §3 of this doc.
- **UNVERIFIED — NEEDS SPIKE: exact `vscode.git` `Repository.state`
  change-event names/timing (`RESEARCH1.md` §6, §8 item 6).** If branch-change
  events don't fire promptly (or at all) on worktree switch/rebase, the
  git-guard reconciliation this design depends on for success criteria #5/#6
  could lag or miss transitions. Fallback already named in research: raw
  `.git` watching with correct worktree-indirection handling, at reduced
  responsiveness.
- **CONFIRMED as a real, open bug class, not yet re-verified on current VS
  Code: `contentChanges` ordering (`RESEARCH1.md` §8 item 5, MS issues #11487,
  #111548).** The piece-table design is meant to make this a non-issue
  structurally, but success criterion #3 must actually exercise
  out-of-order changes (synthetically, since it may not reproduce
  organically) to prove the fix, not just assume the new data structure
  handles it.
- **Known git limitation, newly load-bearing now that v1 depends on it:
  git notes do not automatically follow a commit through `amend`/`rebase`/
  `cherry-pick`/squash** unless `git config notes.rewrite.<command>` is
  configured or `git notes copy` is invoked explicitly — the same class of
  gap `RESEARCH1.md` §1 flags for git-ai's use of notes for a different
  purpose. Since v1 now adopts git notes as its own committed-history
  storage substrate (§2), this is a first-party risk, not just an
  observation about a competitor. **If unaddressed:** a routine
  `git rebase -i` or `commit --amend` during normal development could
  silently strand attribution notes on now-unreachable commit objects.
  Fallback: implement (or document a required) `notes.rewrite.rebase`/
  `notes.rewrite.amend` configuration, or a post-rewrite hook that
  re-attaches notes to new commit SHAs — this needs to be a v1 spike item,
  not an afterthought.
- **UNVERIFIED — NEEDS SPIKE: cost of workspace-wide, always-on file
  watching + hook-driven tracking at scale.** No benchmark exists yet for
  CPU/IO/battery cost on a large monorepo (100k+ files), even with
  `.gitignore`/`node_modules`/build-output excludes applied. **If this
  proves too expensive:** the always-on guarantee in §2 may need a
  size-based circuit breaker (e.g., prompt to narrow scope or disable on
  repos above a file-count threshold) — a scope walk-back from "whole
  workspace, always-on" to "whole workspace, always-on, up to size N,"
  which should be flagged back to the human rather than silently shipped.
- **Judgment call flagged for human review: the "closed file is
  trivially clean" reasoning (§2).** Treating an unopened file's document
  state as automatically clean — so Tier 2/3 classification for closed
  files collapses to hook-vs-lock-file-vs-neither — is this document's own
  extrapolation of the existing dirty-state heuristic, not something
  `RESEARCH1.md` verified directly. It should be validated in the same
  empirical spike pass as the other open questions, particularly for edge
  cases like a file open in a *different* VS Code window/workspace on the
  same machine, or an unsaved untitled buffer that later gets saved to that
  path.
- **Judgment call flagged for human review:** treating the hook as
  *mandatory* rather than optional (as Tourist has it) is this document's
  interpretation of "correctness over breadth," but it does add setup
  friction (requires editing `~/.claude/settings.json` and restarting a
  Claude Code session) that Tourist deliberately made skippable. Worth
  confirming this trade-off is acceptable before locking it into v1 scope.

## 6. How this differs from Tourist and the competitive landscape

- **From Tourist specifically:** same core insight (disk-write-while-clean →
  likely Claude Code), but v1 (a) makes the corroborating signal explicit and
  observable (lock-file watching) instead of an unstated assumption, (b)
  introduces a real third state for uncorroborated writes instead of
  Tourist's binary call, (c) makes the hook mandatory instead of an optional
  add-on, (d) replaces the flat per-line array with a position-mapped
  structure to remove a whole bug class rather than mask it, (e) fixes
  three named, concrete Tourist bugs (worktree `.git` handling, rename
  orphaning, unordered `contentChanges`) rather than inheriting them, (f)
  tracks the whole workspace continuously by default rather than gating on
  open editor tabs (Tourist's closed-file coverage is optional and
  hook-only), and (g) can store attribution git-natively (git notes) behind
  the single `tourist.gitNotesSync` toggle, instead of Tourist's
  local-only, per-machine `globalState`/`workspaceState` — off by default
  (git-notes subsystem fully inert, attribution stays local-only, same as
  Tourist), on to make history portable across clones/machines/teammates.
  It does *not* differ in UX (same gutter-color model), audience (VS Code +
  Claude Code users), or in defaulting to local-only privacy when the
  toggle is off.
- **From the competitive landscape:** per `RESEARCH1.md` §1's explicit
  conclusion, none of the eight surveyed tools combine hook-based ground
  truth with corroborated disk-write inference — most substitute weaker,
  more gameable signals (keystroke speed, paste heuristics, undisclosed
  pattern matching, per-model stylometric fingerprints) as their *primary*
  mechanism, several with unverified or misleading accuracy claims (notably
  `vscode-ai-model-detector`'s "100% accuracy," which detects configured
  model, not code authorship). git-ai remains the one genuinely comparable
  architecture, and adopting git notes as a storage format (§2) puts v1
  closer to git-ai's persistence model than an earlier draft of this
  document assumed — the meaningful difference that remains is *how the
  note's content gets computed*: git-ai's notes are populated by agent
  self-report (`git-ai checkpoint`), ours by our own hook-plus-corroborated-
  inference pipeline (§2's 3-tier model), with git-ai's own documented gaps
  (renames, `filter-branch`, multi-repo `cwd`) as a cautionary reference,
  not a template. Two tools can share a storage primitive while differing
  completely in authorship-determination philosophy; that philosophy, not
  the storage format, is the real differentiator. This project's overall
  differentiation is still not "more features" — it is explicitly narrower
  in scope than most competitors (one AI tool, one editor) in exchange for
  being honest about the limits of what disk-write inference can prove,
  which is the thing this whole document keeps coming back to.
