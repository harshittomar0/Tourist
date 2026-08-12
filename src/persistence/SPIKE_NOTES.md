# Phase 0 experiment 6 — quick self-check (git branch-change events)

Agent B's only real dependency on the Phase 0 spike. The spike output wasn't present
anywhere in the repo when this was built, so per instructions this is a quick check
done directly against the `vscode.git` built-in extension's public API surface,
rather than blocking on it.

## Findings

- The git extension exposes API v1 via
  `vscode.extensions.getExtension('vscode.git')!.exports.getAPI(1)`.
- `Repository.state` has **no dedicated branch-change event**. It exposes a single
  generic `onDidChange: Event<void>` that fires on *any* repository state mutation —
  HEAD moves (checkout, commit, merge, rebase step), index/staged changes, working
  tree changes, remotes, submodules, etc. There is no `onDidCheckout` /
  `onDidChangeBranch` in the public surface.
- Consequence: branch-change detection must be synthesized by the consumer:
  subscribe to `onDidChange`, and on each firing diff the new `state.HEAD?.name`
  (and `state.HEAD?.commit` for detached HEAD) against the last-observed value.
  Only emit our own "branch changed" event when the name (or, while detached, the
  commit) actually differs.
- `onDidChange` fires frequently and can burst during a single checkout (VS Code
  updates several pieces of repo state as part of one operation) — consumers should
  debounce (~150–300ms) before reacting to avoid redundant re-resolution.
- New repos are surfaced via `API.onDidOpenRepository`, not automatically visible at
  activation — a global watcher must subscribe there (and to repo removal) to attach
  a per-repo `onDidChange` listener as repos come and go.
- Detached HEAD: `state.HEAD?.name` becomes `undefined` while `state.HEAD?.commit`
  still holds a SHA. A name↔undefined transition must also count as a branch change,
  keyed by commit SHA in the detached case (matches the `detached-<sha>` key our
  raw-fs fallback already produces).

## Implementation consequence

`branchWatcher.ts` implements exactly this pattern: `onDidChange` + diff against a
remembered `(name | commit)` tuple + debounce, with the fs-fallback watcher (polling
`.git/HEAD` / the worktree's private HEAD file) doing the analogous diff when the
vscode.git API isn't available.

## Status

Self-check only — not a substitute for the real Phase 0 experiment. If the actual
spike surfaces different behavior (e.g. a newer VS Code git extension version adding
a real branch event), `branchWatcher.ts` should be revisited; the debounce-and-diff
approach is a safe superset either way.
