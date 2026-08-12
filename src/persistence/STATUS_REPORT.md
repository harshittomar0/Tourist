# Agent B (Persistence + Git Integration) — status report

Scope owned: `src/persistence/` only. Nothing touched under `src/core/`,
`src/vscode-integration/`, `spike/`, or `test/fixtures/` — none of those
existed in this branch at the start of this work (repo had only an initial
commit), so there was nothing to avoid touching, but the boundary was kept in
the design too: `src/persistence` has zero imports of `vscode` (see
"Contract mismatches" below).

## Scaffold caveat (read first)

The repo was empty — no `package.json`/`tsconfig.json` existed anywhere. A
minimal root scaffold was added (`package.json`, `tsconfig.json`,
`vitest.config.ts`, `.gitignore`) so `src/persistence/` had something to build
against. If Agent A (core, on a sibling branch) also created a root scaffold
independently, these will need to be reconciled by whoever merges — this one
is intentionally minimal (TypeScript + vitest only, ES2022/ESM, strict mode)
so reconciling should just mean picking one and re-running installs.

## Mode A — local, content-hash-anchored persistence: done

All of the following are implemented and unit-tested (42 tests) against a
hand-written `AttributedRange[]` fixture (`src/persistence/__fixtures__/`, not
`test/fixtures/`, which is off-limits):

- **Content-hash anchoring** (`hashing.ts`, `store.ts`): entries are keyed by
  a normalized SHA-256 of the range's text (CRLF/trailing-whitespace
  insensitive), not by fsPath. This is the actual fix for the rename-orphaning
  bug — a rename is just a `lastSeenFsPath` bookkeeping update, never a loss
  of history.
- **Storage keyed by (repo root, branch)** (`store.ts`): one JSON file per
  `sha256(repoRoot).slice(0,16)/slugify(branch).json` under a caller-supplied
  base dir. Atomic writes (temp file + rename).
- **Branch/repo resolution** (`gitContext.ts`): primary path takes an
  injected `VscodeGitAPI`-shaped object (see contract note below) and reads
  `repository.state.HEAD.name`; falls back to raw-fs parsing of `.git`
  when that's unavailable or reports detached HEAD. The fs fallback correctly
  handles worktrees — `.git` as a *file* with a `gitdir:` pointer, resolving
  to the worktree-private HEAD (not the main repo's) and, separately, to the
  *common* git dir for anything worktree-shared (hooks, notes, objects) via a
  `commondir` pointer. Verified against real `git worktree add` repos.
- **Retention/aging pruning** (`retention.ts`): ported `retentionDays`
  semantics — `<= 0` means "keep forever," otherwise entries older than N
  days (by `attribution.updatedAt`) are dropped on load/record.
- **Rename/move re-keying** (`rekey.ts`): `applyRenameEvents` for the happy
  path (editor/workspace-watcher rename events just update display bookkeeping);
  `reconcileOrphanedEntries` as a fallback reconciliation pass for renames that
  happened outside the editor (e.g. a terminal `git mv`) — relocates an entry
  by re-matching its content hash against currently-known file contents, and
  deliberately refuses to guess when a hash matches multiple candidates.
- **Branch-change events** (`branchWatcher.ts`) — see the spike section below.

`index.ts` exposes all of this as `PersistenceManager`, the intended Mode A
entry point for whoever wires up `src/vscode-integration`.

## Phase 0 experiment 6 — done via quick self-check, not blocked on

No spike output existed anywhere in the repo. Per instructions, did the check
myself rather than block: `vscode.git`'s `Repository.state` has no dedicated
branch-change event, only a generic `onDidChange` that fires on any repo
state mutation. Branch changes have to be synthesized by diffing
`state.HEAD?.name` (falling back to `state.HEAD?.commit` while detached)
across that signal, debounced since a single checkout can fire it several
times. Full writeup: `src/persistence/SPIKE_NOTES.md`. `branchWatcher.ts`
implements exactly this pattern for both the vscode API and the fs fallback
(the fs fallback watches HEAD's *parent directory* rather than the file
directly, since git replaces HEAD via lock-file-then-rename and a direct file
watch can silently stop reporting after that on some platforms — confirmed by
a real flaky-then-fixed test run).

If the real Phase 0 experiment 6 later contradicts this (e.g. a newer
`vscode.git` adds a real branch event), `branchWatcher.ts` is the only file
that needs revisiting — everything else consumes it through the
`BranchChangeListener` callback shape, not the underlying mechanism.

## Mode B — git-notes sharing: mostly done, one piece deliberately pending

Off by default (`config.ts`: `enabled: false`). **Zero I/O when disabled is
proven, not just asserted** — `zeroIoWhenDisabled.test.ts` injects a
`GitRunner` that *throws* on any invocation and asserts every public entry
point (`pushAttributionNotes`, `fetchAttributionNotes`, `handlePostCommit`,
`handlePostRewrite`) returns a skip result without ever calling it.

Done:
- **Structured JSON notes, per-commit** under `refs/notes/tourist-attribution`
  (`notesStore.ts`) — not full-file snapshots; an `AttributionNote` holds a
  `contentHash`-keyed array of entries for that one commit.
- **Explicit Push/Fetch commands** (`commands.ts`) — no automatic sync
  anywhere; both are only reachable by direct call.
- **Rewrite continuity — built now, and empirically validated against real
  git**, not just assumed:
  - `commit --amend` / `git rebase`: confirmed (by actually running both
    against a real repo, see `rewriteContinuity.test.ts` and
    `configureNotesRewrite`) that git's *own* `notes.rewrite.<amend|rebase>` +
    `notes.rewriteRef` config copies notes across rewrites with no custom
    hook logic needed. `configureNotesRewrite()` turns that on when Mode B is
    enabled. The custom `post-rewrite` hook (`handlePostRewrite`) is a
    safety net on top of that — it double-checks each old→new pair from
    git's stdin and copies a note itself only if the builtin path somehow
    didn't (e.g. Mode B was enabled after history already existed).
  - `git cherry-pick`: has no post-rewrite hook at all and isn't covered by
    `notes.rewrite.*`. Confirmed empirically that `CHERRY_PICK_HEAD` still
    exists (holding the source SHA) at the moment `post-commit` fires,
    whether or not `-x` was used. So: with `-x` (trailer present),
    `handlePostCommit` copies the note from the trailer's source SHA. Without
    `-x`, there is no trailer and thus no way to identify the source —
    this is the documented gap, and it's **visibly flagged**: a clear stderr
    warning naming the commit and explaining `-x` would have preserved
    continuity, not a silent no-op. Verified end-to-end with a real installed
    hook (`hookRunner.ts`) invoked live by git, not just a direct function
    call (an earlier version of these tests called the handler directly
    after `git cherry-pick` returned and passed by accident — that's too
    late, since git's own sequencer removes `CHERRY_PICK_HEAD` right after
    the hook fires; fixed by installing the real hook and letting git invoke
    it, which is also how this will actually run in production).
  - **Hook chaining**: `installHook` appends to whatever's already in
    `post-commit`/`post-rewrite` (husky, pre-commit, hand-written) rather than
    overwriting, is idempotent (marker comment, safe to re-run), and a test
    confirms both the pre-existing hook's output and ours both actually run,
    in order, when git invokes the file.

Deliberately pending Phase 0 experiment 7:
- **Field-level JSON merge policy** (`merge.ts`) — higher tier wins, then
  recency — is implemented and unit-tested as a pure function, and
  `fetchAttributionNotes` currently applies it in-process (fetch remote notes
  into a throwaway ref, merge entry-by-entry, write back, delete the
  throwaway ref) rather than through `git notes merge`. This is correct
  behavior today, but the exact git-level mechanism (custom `git notes merge
  -s manual` resolver vs. a `merge=driver` config vs. the current
  fetch-then-merge-in-process approach) is explicitly left open pending
  experiment 7's findings — see the comment block above `mergeNotes` in
  `merge.ts`. Don't read the current implementation as the final wiring.

## Contract mismatches / things Agent A should check

- **`AttributedRange` shape is a guess** (`types.ts`): `{ id, fsPath, range:
  {startLine, endLine}, text, attribution: {author, tier, createdAt,
  updatedAt, note?} }`. In particular `text` (the exact span content, needed
  to derive the content hash) and a fixed `tier: 'verified'|'inferred'|
  'heuristic'` vocabulary are assumptions Agent A's real engine may not match
  exactly. If the real shape differs, the only place that needs to change is
  `hashing.ts`'s `toPersistedEntry` (the one function that reads
  `AttributedRange` fields) — everything downstream operates on
  `PersistedEntry`/`AttributionNoteEntry`, which persistence itself owns.
- **No `vscode` dependency, by design**: persistence never imports the
  `vscode` module. `gitContext.ts` and `branchWatcher.ts` take an optional
  `VscodeGitAPI`-shaped object (a minimal ambient interface in
  `vscodeGitTypes.ts`, not the real `@types/vscode`) as a parameter. Whoever
  builds `src/vscode-integration` is expected to do
  `vscode.extensions.getExtension('vscode.git')!.exports.getAPI(1)` and pass
  the result in — persistence doesn't reach for it itself. Flagging this now
  in case that integration point was assumed to work the other way around.
- **Scaffold duplication risk** — see the caveat at the top.

## Verification

`npm test` (vitest): **76/76 passing**, `npx tsc --noEmit`: clean. Tests
exercise real temporary git repositories (init, worktrees, rebase, amend,
cherry-pick with and without `-x`, remotes via a bare repo + two clones) —
not just mocked git calls — wherever the behavior in question is about git's
actual semantics rather than pure logic.
