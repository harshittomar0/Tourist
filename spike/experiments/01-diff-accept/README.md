# Experiment 1 -- diff-accept mechanics (PENDING, needs a human-driven run)

**Status: PENDING.** This cannot be automated: it requires a human to
install the real Claude Code VS Code extension, drive Claude Code (Manual
permission mode) to propose an edit, and click through Accept All / Accept
Hunk / Reject All / edit-then-accept in a live Extension Development Host.
There is no way to script interaction with another vendor's extension's
diff-review UI from here, and no result below should be treated as
guessed or inferred -- it is genuinely unknown until a human runs this.

## The harness (built, ready to use)

`spike/extension.js`'s `activate()` already installs the exact
instrumentation this experiment needs, always-on for every launch of the
spike extension (not gated behind an env var, since a human will be
interacting with the editor UI directly rather than this harness driving
anything):

- `vscode.workspace.onDidChangeTextDocument` -- logs `uri`, `isDirty`,
  `reason` (typed/undo/redo/undefined), change count, and each change's
  `rangeOffset`/`rangeLength`/text length.
- `vscode.workspace.onDidSaveTextDocument` -- logs `uri`, `isDirty`.
- A 75ms poll over `vscode.workspace.textDocuments` comparing each open
  doc's `isDirty` to its last-seen value, logging any transition. This is
  the important one for this experiment specifically: it is the only way to
  catch a transient dirty→clean→dirty flicker that doesn't line up with a
  change/save event, which is exactly the ambiguous case PLAN1.md flags
  ("does the plain tab's document dirty transiently, or does it silently
  reload clean→clean exactly like a bare-CLI write?").

All events append to a JSON-lines log file at `$TOURIST_SPIKE_LOG` (default
`spike/logs/run-<timestamp>.jsonl`).

## Manual steps for the human running this

1. Install the real Claude Code VS Code extension in a **throwaway** VS Code
   profile or Extension Development Host window (do not run this against a
   real project you care about -- Claude Code will be making live edits).
2. Launch the spike harness alongside it. From a terminal:
   ```
   TOURIST_SPIKE_LOG=/tmp/tourist-spike-exp1.jsonl \
   code --new-window --extensionDevelopmentPath=/Users/harshittomar/tourist/spike <a throwaway repo folder>
   ```
   (Do **not** pass `TOURIST_SPIKE_AUTOTEST=1` for this experiment -- that
   env var only drives the unrelated experiment 6 git self-test.)
3. In that window, open a plain file in a plain editor tab (not through any
   Claude-specific view).
4. Start a `claude` session in **Manual** permission mode (either the
   extension's own terminal, or an external terminal with `/ide` run inside
   Claude Code to connect it to this VS Code window -- see experiment 2's
   findings on how that connection is detected).
5. Ask Claude Code to propose an edit to the file that's open in the plain
   tab. For each of the following, note the log's `isDirtyPollTransition`
   and `onDidChangeTextDocument`/`onDidSaveTextDocument` entries around the
   moment of interaction, with timestamps:
   - (a) **Accept the diff unmodified.** Does the plain tab's document dirty
     transiently, or does it silently reload clean→clean exactly like a bare
     CLI write?
   - (b) **Edit the proposed diff before accepting.** Does that dirty
     anything observable?
   - (c) **Repeat (a) with `acceptEdits`/auto-accept mode enabled.**
   - (d) **Repeat using "Accept Hunk" and "Reject All" specifically**, not
     just whole-file accept.
6. Copy the resulting log file into this directory (e.g.
   `01-diff-accept/run-log-<date>.jsonl`) and update `spike/FINDINGS.md`'s
   experiment 1 entry with the observed answer and timestamps, replacing
   this PENDING status.

## What to watch for / how to read the log

- If (a) shows **no** `isDirtyPollTransition` entry and the
  `onDidChangeTextDocument` entries show `isDirty: false` throughout
  (content changes arriving while already clean, never dirtying) --
  that's "clean→clean identical to bare CLI." Per PLAN1.md, **if true for
  every path (a)-(d), Tier 1/2a need no VS Code-extension-specific branch.**
- If **any** path shows a transient `isDirtyPollTransition` (false→true→false
  in quick succession) or an `onDidChangeTextDocument` entry with
  `isDirty: true` that doesn't correspond to a real human edit -- Phase 1's
  tier-classification state machine needs an explicit "diff-review-in-progress"
  state that suppresses misclassifying the human's touch of the diff view as
  an authored "human" edit. Note exactly which of (a)-(d) triggered it.
