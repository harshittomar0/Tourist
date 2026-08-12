# Senior/Staff Code Review — Tourist v2 Consolidation

Reviewed `origin/main` @ `7c929af` (post-consolidation, post "Reconcile
mock-to-real swap"), read-only from a throwaway branch off `origin/main`.
Cross-referenced against `PLAN1.md` Part 2's interface contracts and module
ownership map, `GOAL1.md`'s success criteria, and `spike/FINDINGS.md`'s
confirmed experiment results. Findings #2 and #3 below were verified
empirically by writing and running throwaway reproduction tests against the
actual code (not left in the tree; working tree confirmed clean before
writing this report).

Ranked most severe first.

---

## 1. [CRITICAL] The extension's core feature does not function — Tiers 1/2a/2b/2c can never fire

**`src/extension.ts:40`**

`AttributionEngine` is constructed as
`new AttributionEngine({ corroborationStore: new CorroborationStore() })` —
no `hookLogReader`, and the `CorroborationStore` is never fed by anything.
Grepping the whole tree confirms zero real callers of
`NodeLockFileWatcherAdapter`, `VscodeShellIntegrationBridgeAdapter`,
`ProcessScanFallbackAdapter`, or `WorkspaceWatcherAdapter` outside their own
definitions/tests, and `setGitOpSuppression` is never invoked anywhere in
production wiring.

**Failure scenario:** a developer runs the real Claude Code CLI with the
hook installed and an active IDE session; the edit lands on disk while the
file is clean. `hookMatch` is always false (no reader wired) and every
corroboration signal is permanently `{active:false}`, so classification
falls through to `{origin:'external', tier:'3'}`. Every genuine AI edit is
misclassified as "external/unknown" — the exact false-negative this project
exists to prevent. A `git checkout`/`rebase` is also never suppressed, so it
gets tagged "external" instead of left unmarked (GOAL1 criteria #5/#6 fail).
This is honestly noted in `CONSOLIDATION_REPORT.md`'s "Remaining gaps," but
it means the shipped extension cannot correctly attribute a single real AI
edit end-to-end.

---

## 2. [CRITICAL, confirmed via test] Persisted attribution silently fails to survive reload for ordinary edits

**`src/vscode-integration/persistence-adapter.ts:113` (save) / `:137` (load)**

`toPersistenceRange` hashes the *exact* character substring of a range
(piece-table ranges are character-precise, not line-aligned). `fromPersistedEntry`
verifies by recomputing text from whole-line boundaries (line-start to
next-line-start, including the trailing `\n`) and rejects on hash mismatch.
These only agree when a range coincidentally spans exactly whole lines.

**Reproduced directly:** saving `{startOffset:10, endOffset:12, origin:'ai'}`
inside `"const x = 42;\nconst y = 2;\n"` (a typical mid-line AI edit) and
immediately reloading the *unchanged* text returns `undefined` for every
range in the file. The shipped test suite
(`test/vscode-integration/persistence-adapter.test.ts`) only exercises
ranges that happen to span whole lines including their trailing newline,
which is why this passes CI while breaking on the common case.

---

## 3. [CRITICAL, confirmed via test] Git-notes sync can never push back after a real concurrent merge

**`src/persistence/gitNotes/commands.ts:38`**

`fetchAttributionNotes` fetches the remote's notes into a disposable temp
ref, merges JSON in Node, and writes the result via `git notes add -f` — a
brand-new commit with no shared ancestry with the remote's notes-ref
history — then deletes the temp ref. It never reconciles the underlying
`refs/notes/tourist-attribution` ref itself.

**Reproduced directly:** repo A pushes a note; repo B independently writes a
diverging note for the same commit; repo B fetches+merges (JSON merge is
correct); repo B's subsequent push throws
`! [rejected] ... (non-fast-forward)`. This is exactly the two-clone
scenario Phase 0 experiment 7 was run to validate — the code's own comment
calls the current approach "a placeholder... possibly not the final
git-level mechanism," but experiment 7 landed with a concrete answer that
was never implemented. Team sharing is broken for the exact case it exists
to serve.

---

## 4. [HIGH] A confirmed spike finding was never applied — stale lock files falsely corroborate

**`src/adapters/lock-file-watcher.ts:58`**

`pidLivenessCheck` still defaults to off, with a comment saying it stays off
"until experiment 2 confirms it's needed." `spike/FINDINGS.md` experiment 2
already confirmed a lock file with a dead PID is never auto-removed and
explicitly recommends the liveness check as necessary, with no TTL needed.

**Failure scenario:** a Claude Code IDE session crashes/is SIGKILL'd,
leaving its lock file behind. Every subsequent disk-write-while-clean in
that workspace (a formatter, an unrelated tool) gets falsely corroborated as
Tier 2a "ai" — the specific false-positive class GOAL1.md was written to
eliminate.

---

## 5. [MEDIUM] Workspace/folder rollups mix incompatible units into one meaningless percentage

**`src/vscode-integration/attribution-rollup.ts:59` vs `:68`**

`computeStats()` treats `endOffset - startOffset` as a character count —
correct for `engine.getRanges()`, but `persistence.listPersisted()` returns
pseudo-offsets that are actually line indices (one unit per line).
`addStats` sums both into one total with no reconciliation, so any folder
mixing open and closed files gets an arithmetically meaningless
ai/human/external percentage, silently presented as a single coherent
number in the status bar and workspace tree view.

---

## 6. [MEDIUM] Cross-repo branch-key collision risk in multi-root workspaces

**`src/persistence/gitContext.ts:106`**

`repositoryForFile`'s fallback does a bare
`fileFsPath.startsWith(repo.rootUri.fsPath)` with no path-separator boundary
check (other similar helpers in the codebase, e.g. `matchesWorkspace`/
`withinFolder`, do check this). Sibling repos like `/work/app` and
`/work/app-legacy` can collide if `vscode.git`'s exact lookup misses, filing
one repo's attribution under the other's `(repoRoot, branch)` key —
violating GOAL1.md success criterion #9 ("a same-named branch in two
different repositories... does not collide").

---

## 7. [MEDIUM] Non-atomic persistence writes; deactivation flush fires them concurrently

**`src/persistence/index.ts:39` / `src/extension.ts:132`**

`PersistenceManager.record`'s load→merge→save cycle has no locking.
`flushPendingSaves()` (called on deactivation — the highest-stakes moment)
loops over every open document and calls `persistDoc()` unawaited,
guaranteeing overlapping `record()` calls whenever multiple open documents
share a repo+branch. Last-to-finish wins; the other document's
just-computed ranges are silently dropped for that store file.

---

## Note on scope

The `CLAUDE_CONFIG_DIR`/`path.dirname` bug from spike experiment 4 was
present when this review started but was fixed live in `origin/main`
(commits `44b325d`/`7c929af`) partway through, so it is excluded from the
findings above as already resolved.
