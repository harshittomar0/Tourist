# Junior-dev code review — Tourist VS Code extension

Reviewed as a first-time onboarder to the codebase, against `origin/main` @
`7c929af` (github.com/harshittomar0/Tourist). Scope: `src/core/`,
`src/adapters/`, `src/persistence/`, `src/vscode-integration/`,
`src/extension.ts`. No commits/edits were made to the reviewed tree itself —
this file is a standalone report.

**Resync confirmation:** review was done on a throwaway branch created from
`origin/main` (`git fetch origin && git branch -f review-tmp origin/main`),
at commit `4b849be` (the merge including Agent B's persistence layer, Agent
C's UI layer, and the mock-to-real reconciliation commit). Afterward, diffed
`4b849be..origin/main` (which had advanced to `7c929af`) to confirm nothing
else changed upstream that would invalidate the review — it hadn't, aside
from the bug noted in finding #2 below, which was fixed in that gap.

---

## 1. Critical — the extension's headline feature isn't actually wired up

`src/extension.ts` (the sole activation entry point) never constructs or
starts any of:

- `FileHookLogReaderAdapter` (Tier 1 — the "ground truth" hook signal)
- `NodeLockFileWatcherAdapter` (Tier 2a)
- `VscodeShellIntegrationBridgeAdapter` (Tier 2b)
- `PsListProcessScanFallbackAdapter` (Tier 2c)
- `WorkspaceWatcherAdapter` (the "track files even when not open" watcher)

...and never calls `engine.setGitOpSuppression(...)`.

Concretely: `AttributionEngine` is constructed with only a bare
`CorroborationStore` and no `hookLogReader`. Nothing ever calls
`corroborationStore.setSignal(...)`. That means in
`src/core/tier-classifier.ts`'s `classifyDiskWrite`, every check
(`lockFile.active`, `shellIntegration.active`, `processScan.active`) is
permanently `false`, and `hookMatch` in `engine.ts`'s `pushChanges` is
permanently `false` too. Every real Claude Code edit that would otherwise
show as "ai" instead falls through to `"external"` (Tier 3) — the opposite
of what GOAL1.md says v1 must do. On top of that, files with no open editor
tab are never tracked at all (no watcher is running), and git
checkout/rebase/stash suppression never fires (the mechanism exists on the
engine but nothing calls it).

To be fair to the project: this exact gap is already self-documented in
`CONSOLIDATION_REPORT.md` (lines 76-94) as a known, unresolved item — it's
not a hidden landmine, but it is still true of the code today and affects
basically every success criterion in GOAL1.md §4.

## 2. Bug I initially missed, already fixed upstream — noting for transparency

`src/adapters/hook-log-reader.ts`'s `attributionDir()` used to do
`path.dirname(override)` when `CLAUDE_CONFIG_DIR` was set, landing the
attribution log as a *sibling* of the configured dir instead of inside it —
silently breaking Tier-1 matching for anyone using a custom config dir. I
read this function during review and didn't catch it on first pass. It's
fixed in `44b325d` (now just `override` directly) with a new regression test
added in `7c929af` (`test/adapters/hook-log-reader.test.ts`). No action
needed — flagging for transparency about what I missed initially.

## 3. Dead/unused config path

`tourist.exclusionPolicy` (`src/vscode-integration/settings.ts:48-50`,
`exclusionPolicyOverride()`) is read from config but never passed anywhere.
`createExclusionPredicate` (`src/core/exclusion.ts`) is never called from
`extension.ts` either — same root cause as #1 (the watcher that would use it
is never started).

## 4. Two divergent implementations of the same thing

`src/adapters/hook-log-reader.ts`'s `install()`/`isInstalled()` and
`src/vscode-integration/hook-install.ts`'s `installHook()`/
`verifyHookState()` both register the Claude Code `PreToolUse`/`PostToolUse`
hook independently, with different script-path resolution
(`__dirname`-relative vs. `extensionPath`-relative). Only the second is wired
to the real `tourist.installHook` command (`commands.ts:45`); the first looks
unused. Confusing for anyone new to the codebase — worth a comment explaining
which is canonical, or deleting the dead one.

## 5. Test coverage gaps

- `src/adapters/*` (lock-file-watcher, hook-log-reader, process-scan-fallback,
  shell-integration-bridge, workspace-watcher) — real fs/process/vscode I/O
  with fiddly matching logic, and (aside from the one new test added for
  hook-log-reader) none of it is unit-tested.
- `src/extension.ts` has no automated test at all — per the consolidation
  report it was smoke-tested once by hand against a shim, never in CI.
- `src/core/corroboration-store.ts` and `src/core/snapshot-store.ts` have no
  dedicated unit test file (only indirect coverage via `engine.test.ts`).

## 6. Confusing-but-correct — flagged per review instructions rather than assumed fine

`matchesSpan`'s overlap check (`src/adapters/hook-log-reader.ts:147`):
`range.start < lineEnd && range.end + 1 > lineStart`. This looks like an
off-by-one at first glance because it treats one side of the range as
inclusive and the other as exclusive. Traced back to
`hooks/attribution-hook.mjs`'s `toRanges()` (inclusive `{start,end}`) vs. the
adapter interface's documented half-open `[lineStart, lineEnd)`, and the math
does check out — but it cost two passes to be sure, and there's no comment at
the call site connecting the two conventions.

## What I did *not* find

Core arithmetic — `piece-table.ts`'s offset splicing, `line-diff.ts`'s
LCS/hunk computation, and the persistence layer's offset↔line reconciliation
in `persistence-adapter.ts` — was unusually well fenced with doc comments
anticipating exactly the off-by-one/ordering traps this review was looking
for, and none were found in any of them.
