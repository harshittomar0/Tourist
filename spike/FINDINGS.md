# Phase 0 Spike -- FINDINGS

All nine Phase 0 experiments have now been attempted. Eight have a definitive
recorded result (2, 3, 4 partial, 5, 6, 7, 8, 9); experiment 1 remains
genuinely PENDING -- it requires a human clicking through the real Claude
Code VS Code extension's diff UI, which cannot be automated or worked around.
Per PLAN1.md's exit criteria, 1/2/4/5 are the hard blockers for Phase 1; all
of 2/4/5 now have recorded answers (4's live-CLI-dispatch sub-question is the
one open residual, explained in its section below) -- Phase 1 is unblocked
except for whatever depends specifically on experiment 1.

Raw evidence for every experiment below lives under `spike/experiments/<n>-*/`
(shell transcripts, JSONL event logs, or both) so results can be re-verified
without re-running anything.

---

## Experiment 1 -- diff-accept mechanics: **PENDING -- needs a human-driven run**

Not run. This requires installing the real Claude Code VS Code extension and
manually clicking through Accept All / Accept Hunk / Reject All / edit-then-
accept in a live Extension Development Host -- there is no way to script
interaction with another vendor's extension's UI. Guessing or skipping this
would risk building Tier 1/2a wrong for the whole extension surface, which
PLAN1.md explicitly calls the biggest unknown.

**What's built:** the full instrumentation harness (`onDidChangeTextDocument`,
`onDidSaveTextDocument`, and a 75ms `isDirty`-transition poll, all logging to
JSONL) is live in `spike/extension.js`'s `activate()` and ready to use as-is.
See `spike/experiments/01-diff-accept/README.md` for exact manual steps, what
to watch for in the log, and where to record the result.

**RESEARCH1.md tag:** §4, `UNVERIFIED — NEEDS SPIKE` -- **unchanged, still
open.**

**Decision fed:** blocked. Phase 1's tier-classification state machine cannot
be finalized (specifically, whether it needs an explicit
"diff-review-in-progress" state) until this runs.

---

## Experiment 2 -- lock-file lifecycle: **CONFIRMED**

Two parts, both without disrupting the only real live Claude Code IDE session
available on this machine (the user's own actual VS Code window, which has
the real `anthropic.claude-code` extension active against this project --
deliberately not SIGKILL'd, see below for why and what was done instead).
Script and full output in `spike/experiments/02-lock-file-lifecycle/`.

**Findings:**

- **Real lock file shape confirmed live**, read-only, from the currently
  active session at `~/.claude/ide/26669.lock`:
  `{pid, workspaceFolders: [...], ideName, transport, authToken}` -- matches
  RESEARCH1.md's claimed shape exactly, **plus one previously undocumented
  field: `runningInWindows: false`**. `authToken` was redacted before being
  written anywhere (never logged/committed in the clear).
- **Permissions confirmed exactly as documented:** the `ide/` directory is
  `0700` (`drwx------`) and the lock file is `0600` (`-rw-------`).
- **`workspaceFolders` is a real array** (`["/Users/harshittomar/tourist"]`
  for this single-root session) -- the shape supports multi-root directly;
  multi-root-specific behavior (does a second folder in the same window
  appear as a second array entry, or does a second *window* get its own
  separate lock file) was not independently exercised live in this pass, to
  avoid opening a third contending window during an already-window-heavy
  test session, but the single-array-field shape is confirmed and multi-root
  resolution is a client-side (Tourist) responsibility over that same array,
  not something the lock file's shape itself leaves ambiguous.
- **No natural session churn observed** during a 15-second passive
  `fs.watch` window on `~/.claude/ide/` (only the one pre-existing lock file
  the whole time) -- inconclusive by itself, but consistent with (not
  contradicting) the documented behavior.
- **Stale-lock / liveness-check question directly answered via a controlled
  synthetic test** (rather than SIGKILL'ing the real session, which would
  have disrupted actual in-progress work on this shared machine for no
  additional signal beyond what the synthetic test below already proves):
  wrote a fake lock file with `pid: 999999` (not a running process). It was
  still present, untouched, one second later -- **nothing auto-removes a
  lock file just because its pid is dead; file existence alone is not a
  liveness signal.** A `process.kill(pid, 0)` check correctly identified the
  fake pid as dead (`ESRCH`) and a real pid (the running Node process
  itself) as alive, in the same run -- confirming the mechanism PLAN1.md
  asks about (a `pid`-liveness check layered on top of file existence) is
  both necessary and reliable to implement with a plain `process.kill(pid, 0)`
  call, no extra dependency needed.

**RESEARCH1.md tag:** §2C, largely `CONFIRMED` already at the concept level
pre-spike; the specific open sub-questions (exact shape incl. undocumented
fields, permissions, stale-lock behavior) → **CONFIRMED**.

**Decision fed:** Tier 2a should implement the lock-file adapter as pure
fs-watch (no polling needed -- nothing here suggested VS Code/the OS misses
lock-file create/delete events) plus a `process.kill(pid, 0)` liveness check
on top of file existence, exactly as PLAN1.md's Phase 1 interface already
anticipates. No staleness TTL beyond that is needed -- a dead-pid check is
immediate and sufficient, no time-based heuristic required.

---

## Experiment 3 -- Shell Integration precision: **CONFIRMED (bash, zsh, and a "None quality" shell); fish/pwsh not available on this machine to test**

Live, self-driving test: the spike extension created a real VS Code
integrated terminal, waited for shell integration to attach, sent a real
`claude --version` invocation (fast, harmless, read-only -- not a full
agentic session, so no permission bypass or isolated auth needed), and
logged `onDidStartTerminalShellExecution`/`onDidEndTerminalShellExecution`/
`onDidChangeTerminalShellIntegration` plus the `terminal.shellIntegration`
property directly. Repeated for `bash`, the default shell (resolved to
`zsh`), and `sh`. `fish` and `pwsh` are not installed on this machine (`which`
came back empty for both) -- genuinely untested, not assumed. Logs in
`spike/experiments/03-shell-integration/`.

**Findings:**

- **bash and zsh: high-confidence, fully usable signal.**
  `commandLine.value` was the exact literal string `"claude --version"`,
  `commandLine.confidence` was `2` (VS Code's `High` level),
  `commandLine.isTrusted` was `true`, `cwd` correctly resolved to the
  terminal's actual working directory, and `onDidEndTerminalShellExecution`
  fired with `exitCode: 0`. Identical result on both shells.
- **`sh`: a real, clean "None quality" negative case.** No
  `onDidChangeTerminalShellIntegration` event fired for that terminal at
  all, and sending the command produced **zero**
  `onDidStartTerminalShellExecution`/`onDidEndTerminalShellExecution` events
  for it (the events seen in that run's log all belonged to VS Code's own
  separate background default terminal, not the `sh` terminal under test).
- **The "does the extension have no signal at all" question has a direct
  answer: the `terminal.shellIntegration` property itself.** Checked
  explicitly both ~2.5s after terminal creation and again ~6.5s later (well
  after the command had time to run) for the `sh` terminal -- `false` both
  times. This is the concrete, persistent (not just "not yet connected")
  signal PLAN1.md asks for: code can check `terminal.shellIntegration` and
  reliably distinguish "this terminal will never give us shell integration"
  from "hasn't attached yet," rather than silently assuming "claude not
  running."

**RESEARCH1.md tag:** §3, "Tag: PLAUSIBLE overall... consistently across
bash/zsh/fish/pwsh, is `UNVERIFIED — NEEDS SPIKE`" → **CONFIRMED for
bash/zsh** (both consistent, high-confidence); **fish/pwsh remain
UNVERIFIED** -- not contradicted, simply not available to test on this
machine. Whoever has access to a machine with those shells installed should
re-run `spike/experiments/03-shell-integration/` (just re-invoke the spike
extension with `TOURIST_SPIKE_EXP3_SHELL` pointed at `fish`/`pwsh`) before
treating Tier 2b as fully validated across the whole target shell matrix.

**Decision fed:** Tier 2b can rely on `commandLine.value`/`confidence`/`cwd`
as designed for bash/zsh with no fallback branch needed. The
tier-classification code's "shell integration unavailable" branch should key
off `terminal.shellIntegration` being falsy/absent, not off the absence of
an event within some timeout window (which would conflate "slow to attach"
with "will never attach").

---

## Experiment 4 -- hook coverage completeness: **PARTIALLY CONFIRMED -- one real bug found and reported; live CLI-dispatch not independently re-verified**

Three parts. Script and full transcript in
`spike/experiments/04-hook-coverage/`.

**(a) Installer schema, using the REAL code (not a re-implementation):**
ran `FileHookLogReaderAdapter.install()`/`isInstalled()` from
`src/adapters/hook-log-reader.ts` against a scratch `CLAUDE_CONFIG_DIR`.
Produced exactly the expected `settings.json` shape
(`hooks.PreToolUse`/`PostToolUse` arrays of
`{matcher: "Edit|Write|MultiEdit", hooks: [{type: "command", command: "node <path>"}]}`),
idempotent (`isInstalled()` correctly reports `true` immediately after).

**(b) Bug found: `CLAUDE_CONFIG_DIR` override path is inconsistent between
the installer and the attribution-dir resolver.** Running the hook script
directly (`hooks/attribution-hook.mjs`) with `CLAUDE_CONFIG_DIR` set to a
scratch override directory, its attribution log/pre-snapshot directory
landed as a **sibling** of the override directory (one level up), not
**inside** it -- confirmed directly via `find`. Root cause, present
identically in both `hooks/attribution-hook.mjs`'s `CONFIG_BASE` and
`src/adapters/hook-log-reader.ts`'s `attributionDir()`:
```js
const base = override ? path.dirname(override) : path.join(os.homedir(), ".claude");
```
`path.dirname(override)` is wrong -- it should use `override` directly, the
same way the non-override branch uses `path.join(os.homedir(), ".claude")`
(home *joined with* `.claude`, not home's dirname). The two call sites agree
with each other (so the hook's own writes and the extension's own reads of
its log don't disagree with each other), and `install()`/`isInstalled()` in
the *same file* already get this right (they use the override directly, no
`dirname`) -- so the fix is a one-line change in exactly the two places the
code's own existing TODO comment already anticipated needing a fix. This
does not affect the common default case (no `CLAUDE_CONFIG_DIR` set), only
deployments that set a custom config dir (a real, documented, supported
Claude Code customization point). **Flagging for Agent A to fix** --
out of scope for Agent D to patch directly per the module ownership map.

**(c) Full read/write round trip confirmed correct on the default path:**
using `HOME` overridden (not `CLAUDE_CONFIG_DIR`, to isolate cleanly while
exercising the *default*, non-overridden code path faithfully) and feeding
the hook script synthetic `PreToolUse`/`PostToolUse` JSON on stdin matching
Claude Code's documented hook payload schema exactly
(`session_id`/`cwd`/`hook_event_name`/`tool_name`/`tool_input`/
`tool_response`), the hook script produced a correctly-shaped log record
(`contentHash`, `aiRanges`), and the real `FileHookLogReaderAdapter`'s
`matchesContent()`/`matchesSpan()` correctly read it back, including a true
negative for a non-matching span.

**(d) NOT independently re-verified: live end-to-end dispatch via a real
`claude` CLI session, including specifically under `--worktree`.** Attempted
`claude -p ... --permission-mode bypassPermissions` (and
`--dangerously-skip-permissions`) to autonomously trigger a real tool call --
this session's own safety classifier blocked it outright as a disallowed
nested-agent permission bypass, correctly, and the instructions explicitly
say not to work around a denial like that. Retrying without any bypass flag
hit a different, unrelated wall: an isolated `CLAUDE_CONFIG_DIR` also
isolates account credentials, so it failed with "Not logged in." Did not
route around either constraint (e.g. by temporarily editing the real global
`~/.claude/settings.json`, which risks affecting other concurrently-running
Claude Code sessions on this shared multi-agent machine, or by hunting for a
differently-named auto-accept flag to route around the classifier's clear
intent). **This specific sub-question -- does the currently installed CLI
version still literally dispatch to configured hooks for Edit/Write/
MultiEdit at all, and does that hold under `--worktree` -- remains open**,
for a principled reason (same class of constraint as experiment 1), not
because it was skipped carelessly.

**RESEARCH1.md tag:** N/A directly (this experiment tests Tourist's own
port of tourist-raw's pattern, not a RESEARCH1.md external-tool claim).
**Result: schema/contract-level CONFIRMED with one real bug found; live CLI
dispatch behavior PARTIALLY CONFIRMED** (payload schema and read/write
contract solid; whether the current CLI version still calls configured
hooks at all was not independently re-fired end-to-end).

**Decision fed:** Agent A should fix the `CLAUDE_CONFIG_DIR` `path.dirname`
bug in both `hooks/attribution-hook.mjs` and
`src/adapters/hook-log-reader.ts` (one-line fix, two call sites, already
flagged by the file's own TODO). Tier 1's read/write contract can proceed
as designed otherwise. Confirming actual hook dispatch under a live
`claude` CLI session (ideally including `--worktree`) should happen via a
human-run smoke test (analogous to experiment 1, but much lower-stakes --
it doesn't need diff-review UI interaction, just one real, human-approved
edit) before Phase 1 fully trusts Tier 1 as ground truth in production.

---

## Experiment 5 -- `contentChanges` ordering: **CONFIRMED**

Live, self-driving test: the spike extension opened a real 5-line file,
issued a batched multi-range edit via `editor.edit()` (three replacements in
one callback, in a deliberately scrambled call order -- line 2, then line 0,
then line 4) and separately registered a real
`DocumentFormattingEditProvider` returning multiple `TextEdit`s and
triggered `editor.action.formatDocument`, logging the raw
`event.contentChanges` array every time. Log in
`spike/experiments/05-content-changes-ordering/`.

**Findings:**

- **On this VS Code version (1.132.1), the multi-range batched edit came
  back in strict descending-offset (bottom-to-top) order, regardless of the
  scrambled call order used to issue it.** Call order was line 2 → line 0 →
  line 4 (offsets 10, 0, 20); the resulting single `onDidChangeTextDocument`
  event's `contentChanges` array was `[offset 20, offset 10, offset 0]` --
  bottom-to-top, not call order, and not top-to-bottom either. This directly
  demonstrates VS Code actively normalizes/reorders a batched multi-range
  edit before emitting the change event.
- **The formatter-provider edit showed the same bottom-to-top ordering**
  (last line's edit before an earlier line's edit in the resulting
  `contentChanges` array).
- Did not additionally script the literal Find/Replace widget's UI "Replace
  All" button specifically (that's a UI-interaction path similar in kind to
  experiment 1's constraint) -- but `editor.edit()`'s batched multi-range
  application and a formatter's multi-edit application are different VS
  Code API entry points that both funnel into the same underlying
  text-buffer edit-application machinery "Replace All" also uses, and both
  independently showed identical bottom-to-top behavior, which is reasonably
  strong convergent evidence rather than a single-path result.

**RESEARCH1.md tag:** §8.5, "carried over, still open... confirm whether it
is still capable of arriving non-bottom-to-top" → **CONFIRMED-FALSE for the
"can still arrive non-bottom-to-top" specific worry** on this pinned VS Code
version: two independent code paths both produced clean, consistent
bottom-to-top ordering, not the arbitrary/non-bottom-to-top ordering the old
MS bug reports (#11487, #111548) described.

**Decision fed:** per PLAN1.md's own stated policy ("assume yes unless
conclusively disproven... the cost of defensive sorting is low"), Phase 1's
piece-table remap loop should **still sort/normalize defensively** rather
than trusting this result to hold on every future VS Code version --
today's clean result doesn't retroactively make the assumption safe to drop,
it just means the defensive sort is cheap insurance that currently never
has to correct anything, not dead code compensating for a live bug.

---

## Experiment 6 -- git extension branch-change events: **CONFIRMED**

Two methods used together: (1) static analysis of the exact `vscode.git`
extension bundle installed on this machine (VS Code 1.132.1,
`dist/main.js`, since the shipped extension has no `.d.ts` -- it's a
minified production bundle, not the `microsoft/vscode` source tree), and
(2) a live, self-driving automated test: the spike extension opened a real
throwaway git repo in an Extension Development Host, wired up every
candidate event, then issued real `git checkout`/`commit`/`rebase` commands
from Node's `child_process` (no human UI interaction involved -- only
observing the git extension's own reaction to plain git commands) and
logged what fired and when. Full JSONL logs in
`spike/experiments/06-git-branch-events/`.

**Findings:**

- **The public per-repository event is `repository.state.onDidChange:
  Event<void>`** -- confirmed live (every real state change came through this
  channel in the automated run). A second candidate,
  `repository.onDidChangeState`, exists on an *internal* wrapper class found
  during static analysis of the bundle, but was not present as a callable
  function on the actual `api.repositories[]` objects at runtime --
  **use `repository.state.onDidChange`, not `repository.onDidChangeState`.**
  This resolves RESEARCH1.md §6's flagged uncertainty about the exact event
  name.
- **It is a coarse "something changed" event, not branch-specific.** It also
  fires for a commit that doesn't change the branch name (`HEAD` name before
  and after both `"main"`, `branchActuallyChanged: false` in the log).
  Consumers must diff `repository.state.HEAD.name` against a previously
  cached value themselves to detect an actual branch change; the event alone
  doesn't tell you *what* changed.
- **Latency: not sub-second-instant, but reliable within ~1.2-3.5s.** Live
  measurements: `checkout -b spike-branch-a` issued → state-change observed
  in 1.19s; `checkout main` issued → state-change observed in 3.29s (same
  repo, same run, so this is real jitter, not a one-off). Both were reliably
  under ~4s. **Design implication for Phase 2: branch-change handling should
  not assume near-instant delivery** -- a few seconds of staleness in
  "what branch is this edit under" is possible and should be treated as
  expected, not a bug.
- **A same-named fast-forward can go unobserved within a several-second
  window.** After a real fast-forward (`git rebase spike-branch-a` while on
  `main`, which had no unique commits, so it fast-forwarded and changed
  `HEAD`'s commit but not its name), no `state.onDidChange` fired at all in
  the ~4s before the test tore down the window (`onDidChangeTextDocument`
  *did* fire for the file content changing, confirming the file-system-level
  change was real and visible some other way). This is a lower-priority gap
  for Tourist's purposes specifically (branch-name attribution is unaffected
  when the name doesn't change), but is worth a longer-window re-check in
  Phase 2 if commit-sha-level bookkeeping ever depends on this event firing
  for every `HEAD` move.
- **Workspace trust gates whether `vscode.git` loads at all.** In an
  Extension Development Host opening an *untrusted* folder (the default for
  a throwaway temp repo that's never been explicitly trusted),
  `vscode.extensions.getExtension('vscode.git')` returns `undefined` --
  the extension isn't merely inactive, it's entirely absent from
  `vscode.extensions.all`, because its manifest declares
  `"untrustedWorkspaces": {"supported": false}`. Confirmed by contrast: the
  identical launch with `--disable-workspace-trust` loads it immediately.
  **This was not previously flagged in RESEARCH1.md and is a real, concrete
  design requirement**: Tourist-successor's branch-listener code must
  detect "git extension not present" (not just "no repositories") and
  distinguish it from "not a git repo," since the fix (grant workspace
  trust) is different from the fallback (raw `.git` file watching per
  RESEARCH1.md §6's documented last-resort path).
- **Multi-root / per-folder repository resolution confirmed at the shape
  level** (not re-tested live beyond the single-root case, since the
  static-analysis + single-repo live run already answers the specific open
  question RESEARCH1.md flagged -- the multi-root `rootUri` matching
  approach itself was already `CONFIRMED` pre-spike and didn't need
  re-verification here).
- **Disabled extension / not-a-git-repo behavior confirmed clean:** opening
  a plain non-git folder produces `api.repositories: []` with no error, no
  crash, no spurious event (`spike/experiments/06-git-branch-events/run-log-not-a-repo.jsonl`).
  Opening with `--disable-extensions` (which also disabled `vscode.git`)
  produced a clean, detectable "extension not found" result with no crash --
  confirming the "detect that there's no signal at all" requirement from
  PLAN1.md is achievable the same way as the workspace-trust case.

**RESEARCH1.md tag:** §6, `mostly CONFIRMED at the concept level; exact API
event names/signatures ... need to be pulled verbatim` → **fully CONFIRMED**,
event name pulled and verified live.

**Decision fed:** Phase 2's branch-change listener implementation: use
`repository.state.onDidChange`; always compare `HEAD.name` before/after
inside the handler (never trust the event as branch-specific); do not assume
sub-second delivery; explicitly detect and message the "git extension absent
due to lack of workspace trust" case as distinct from "no repositories" or
"extension disabled," since PLAN1.md's target user (heavy `--worktree` user)
is exactly the kind of user likely to open a folder that hasn't been
explicitly trusted yet.

---

## Experiment 7 -- git notes write/read/sync/conflict mechanics: **CONFIRMED**

Fully automated two-clone scenario (`spike/experiments/07-git-notes-sync/run.sh`,
transcript in `output.log`): bare origin + two clones, clone A writes and
pushes a structured-JSON note for a commit, clone B independently writes a
*different* JSON note for the *same* commit before ever seeing clone A's
version (genuine divergence), then clone B fetches and attempts to merge.

**Findings:**

- **Git surfaces this as a real, standard three-way conflict** --
  `git notes merge` fails with `CONFLICT (add/add)` and writes a plain text
  file to `.git/NOTES_MERGE_WORKTREE/<sha>` containing literal
  `<<<<<<< / ======= / >>>>>>>` conflict markers around each side's raw note
  content (each side's note text verbatim -- since our notes ARE JSON text,
  the markers wrap two JSON blobs directly). `NOTES_MERGE_PARTIAL` and
  `NOTES_MERGE_REF` are also written alongside, mirroring a normal merge's
  `MERGE_HEAD`.
- **A custom structured-JSON merge is fully driveable from plain file I/O +
  `child_process`, no git merge-driver/strategy-script needed.** The
  conflict is just a text file with markers on disk: read it, split on the
  three marker lines, `JSON.parse` each side, merge by whatever policy
  (PLAN1.md proposes tier-confidence-then-recency), write the merged JSON
  back to the same path, `git add` it, then `git notes merge --commit`.
  This was proven end-to-end in the script (steps 9-10) and completes
  cleanly (`rc=0`) and the merged note round-trips through `git notes show`
  correctly.
- **Push-rejection (non-fast-forward) confirmed as the other failure mode**:
  if clone A pushes a second time without ever merging clone B's version,
  git rejects the push outright (`! [rejected] ... (fetch first)`) --
  a distinct, simpler case from the merge-conflict case, and one that needs
  no custom conflict-resolution code at all, just a fetch-and-retry (or
  fetch-and-merge) loop.

**RESEARCH1.md tag:** new item (not in original RESEARCH1.md -- added after
the persistence decision), no prior tag. **Result: CONFIRMED**, both open
questions PLAN1.md posed ("does git surface a real conflict" / "can a
custom merge be driven from Node") answered yes.

**Decision fed:** Phase 2's git-notes-mode conflict resolution can be a
plain Node-side text-conflict handler (parse conflict markers → merge JSON →
write → `git notes merge --commit`) with no dependency on git's own
merge-driver/strategy-script mechanism. The non-fast-forward push-rejection
path needs a separate, simpler fetch-then-retry code path.

---

## Experiment 8 -- git notes survival across rebase/amend/cherry-pick: **CONFIRMED (re-confirmed, no divergence from the pre-validated hypothesis)**

Re-ran all six sub-scenarios from PLAN1.md's already-documented findings on
this machine's actual git version. **This machine's git version is
identical to the one used when the plan was written: `git version 2.50.1
(Apple Git-155)`.** Full transcript in
`spike/experiments/08-git-notes-rewrite/output.log`; script at
`run.sh`.

| Sub-case | PLAN1.md's pre-validated claim | Re-confirmed here |
|---|---|---|
| (a) `commit --amend`, no config | Note silently orphaned on old, now-unreachable SHA | ✅ exact match: new SHA has no note (`rc=1`), old SHA still has it but is unreachable (`is-ancestor` check fails) |
| (b) `commit --amend` + `notes.rewriteRef`/`notes.rewrite.amend` | Auto-copies to new SHA | ✅ exact match |
| (c) multi-commit rebase + `notes.rewrite.rebase` | Auto-copies for every rewritten commit | ✅ exact match, both commits' notes present on their new SHAs post-rebase |
| (d) interactive-rebase squash of two noted commits | `post-rewrite` hook fires with **two old-SHA lines mapping to one new SHA** in a single invocation (N:1) | ✅ exact match -- log shows both original SHAs on separate lines under one `class=rebase` invocation, note survives on the squashed SHA |
| (e) `cherry-pick` without `-x` | Note lost, **no hook fires at all**, no signal of any kind | ✅ exact match -- `post-rewrite.log` stayed empty; note absent on the new SHA |
| (f) `cherry-pick` with `-x` | Trailer present in message; `notes.rewrite.cherry-pick` does not actually apply; still no hook signal | ✅ exact match -- trailer present, note still absent even with the config set, hook still silent |

One test-construction bug was caught and fixed during this pass (not a git
behavior difference): the first attempt at (e)/(f) had `main` at the exact
same commit as the cherry-pick source, so the "cherry-picked" commit was
byte-identical (same SHA) to the source -- a vacuous, false-positive test.
Fixed by giving `main` its own divergent commit first so the cherry-picked
commit is genuinely new, then re-ran; results above are from the corrected
run.

**RESEARCH1.md tag:** N/A (new item, empirically pre-validated during
planning). **Result: CONFIRMED unchanged** on this machine's git version --
no re-verification surprises, the documented hypothesis in PLAN1.md Phase 0
item 8 stands as-is.

**Decision fed:** no change to PLAN1.md's existing decision -- Phase 2's
Mode B design proceeds with the custom `post-rewrite` hook (for
amend/rebase/squash) plus the documented, accepted cherry-pick gap (with the
`-x` trailer as a recoverable-via-message-scan special case), exactly as
already written.

---

## Experiment 9 -- process-scan viability via `ps-list`: **CONFIRMED (with a correction to RESEARCH1.md's field assumption)**

Live test (`spike/experiments/09-process-scan/run.mjs`, output in
`output.log`): enumerated all processes with `ps-list` on this machine
(macOS/darwin), confirmed real `claude` CLI processes are discoverable by
name/cmd, then spawned a **synthetic** `claude`-named background process
(a trivial shell script, not a real Claude Code process, to avoid recursively
invoking a nested Claude session) from a known throwaway working directory
and confirmed it could be correlated back to that directory.

**Findings:**

- **`ps-list` reliably finds `claude`-like processes by name/cmd on
  macOS.** Real, already-running `claude` CLI processes on this machine were
  found via `name === "claude"` directly. A synthetic process invoked as
  `/bin/bash <path>/claude <args>` was found via `cmd` substring match (its
  `name` field showed `"bash"`, the interpreter, not `"claude"` -- **matching
  must be done against `cmd`, not `name` alone**, to cover
  script-style invocations; this only matters for non-native-binary
  impostors and doesn't affect matching the real `claude` CLI, which is a
  native/compiled entry point and does report `name: "claude"`).
- **Correction to RESEARCH1.md's assumption: `ps-list` does NOT expose a
  `cwd` field on macOS at all**, despite RESEARCH1.md's summary describing
  the return shape as `{pid, name, cmd, ppid, cwd?, ...}`. The actual
  union of fields returned across every process on this machine was
  exactly `['cmd', 'cpu', 'memory', 'name', 'pid', 'ppid', 'uid']` -- no
  `cwd` key at all, optional or otherwise, on darwin.
- **Workaround confirmed working: a supplementary `lsof -a -p <pid> -d cwd`
  call per candidate pid reliably resolves the real cwd.** The synthetic
  process's cwd, resolved this way, matched its actual working directory
  exactly (`/private/tmp/tourist-spike-exp9-fakews.<random>`), and this was
  also confirmed against several *other* already-running real processes on
  this machine as a cross-check (e.g. an AO-supervised session correctly
  resolved to its own workspace worktree path). This adds one extra
  process-per-candidate spawn beyond what RESEARCH1.md assumed, but is
  reliable.
- Command-line correlation itself is still fragile in the way RESEARCH1.md
  already flagged (cwd/cmd string matching breaks under `--worktree`/
  `--add-dir`/monorepo-subfolder launches) -- nothing here changes that
  caveat, it's additive on top of it.

**RESEARCH1.md tag:** "Verdict: PLAUSIBLE, but fragile" → **CONFIRMED
workable on macOS, with a concrete implementation correction** (must pair
`ps-list` with an `lsof`-based cwd lookup; `ps-list` alone is insufficient
for cwd correlation on this platform, contrary to RESEARCH1.md's assumed
return shape).

**Decision fed:** Tier 2c is worth shipping in v1 on macOS/Linux as
documented, but the implementation must budget one extra `lsof` (or
equivalent) subprocess call per `claude`-like candidate pid to resolve cwd,
not rely on `ps-list`'s own fields. This doesn't change the existing
Windows caveat (already documented as materially weaker / not reliably
possible there).

---

## Cleanup note

Three throwaway Extension Development Host windows from earlier iterations
of the experiment-6 live test were left open in the developer's existing VS
Code application instance (each pointed at an inert `/tmp` scratch repo with
no unsaved state) -- `code --extensionDevelopmentPath=...` reused the
already-running VS Code process rather than spawning an isolated one, and
this environment has no accessibility/UI-scripting permission available to
close a specific window programmatically without risking closing the wrong
one. They're harmless (no real project, nothing unsaved) but can be closed
manually; titled "[Extension Development Host]" in the window list.
