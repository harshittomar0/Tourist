# RESEARCH.md — Live AI-vs-Human Line Attribution (VS Code)

Research pass for a new, VS Code-only extension whose single core feature is
**robust, live, line-level attribution of AI (Claude Code) vs human edits**.
Builds directly on the prior research pass (Tourist's heuristic and its bugs,
Claude Code hooks, CodePause's tiered-signal model, the 3-tier hypothesis, and
the piece-table idea) — those are treated as given, not re-derived here.

Tag legend used throughout: **CONFIRMED** (primary-source docs/code checked),
**PLAUSIBLE** (strong secondary evidence, internally consistent, not directly
observed), **UNVERIFIED — NEEDS SPIKE** (genuinely unknown, must be tested
empirically before relying on it).

---

## 1. Competing extensions — deep dive

Eight tools researched (more than the four requested), spanning fully
open-source to closed marketplace-only.

| Extension | Signal(s) used | Accuracy claims | Open source? | Verdict |
|---|---|---|---|---|
| **AuthentiCraft** (`DibyaDarshanKhanal.authenticraft`) | Keystroke pattern/speed monitoring, structural analysis of formatting, "language-based indicators" (doc style, apparent complexity), edit-size-vs-context heuristics, HIGH/MEDIUM/LOW confidence tiers, immutable "blockchain" record | None quantified | **Yes** — [github.com/Dibae101/AuthentiCraft](https://github.com/Dibae101/AuthentiCraft), MIT | Confidence-tiering is worth borrowing (matches our own tier idea independently). The keystroke/speed heuristic is a plausible *fallback* signal for files never touched by a hook, but is inherently statistical/fuzzy — avoid using it as a primary signal. "Blockchain" for a local per-workspace log is over-engineering we should avoid. |
| **DifAI** (`Ph03n1x.difai`) | "Direct IDE event integration", pattern-based detection, statistical analysis, git-metadata inspection, code-structure analysis; stores state in `.aidetector.json` | None | Not linked from listing | Multi-signal-with-timeline idea (shows AI contribution timeline + subsequent human edits) is a nice UX pattern for our decorations/hover, independent of its unverified detection accuracy. Storing attribution as a plain workspace JSON file (vs git notes or a piece-table) is the simplest-possible persistence model — a low bar we should clear. |
| **Codespy AI Detector** (`CodespyAIDetectorforSourceCode.codespy-ai-detector`) | Undisclosed — likely a hosted classifier (extension requires registering + a token at codespy.ai and phones home per file) | None | No | **Avoid this pattern**: sending code to a third-party server for detection is a hard no for a local-first, privacy-preserving design like ours (and Tourist's). Confirms our "no server" constraint is a real differentiator, not just an implementation shortcut. |
| **AI Code Detector** (`johnoseni.is-ai-code-vscode`, wraps the `is-ai-code` library) | Undisclosed pattern-based detection ("explainability" panel shows "specific patterns" but none documented); also offers a code action to "rewrite AI code to look more human" | None | Library not clearly linked | The "rewrite to look more human" feature is a red flag for the whole static-detection category — it implicitly admits these are surface-pattern heuristics that can be gamed, i.e. round-trippable. Reinforces why we anchor on *provenance* (hooks, disk-write timing) rather than *style* wherever possible. |
| **vscode-ai-model-detector** (`thisis-romar/vscode-ai-model-detector`) | Reads VS Code's `state.vscdb` SQLite store, extracts the `chat.currentLanguageModel.panel` key, matches against a 41-model registry | Claims **"100% accuracy"** in its own README | **Yes** — [github.com/thisis-romar/vscode-ai-model-detector](https://github.com/thisis-romar/vscode-ai-model-detector) | The claim is **misleading**: it detects which model is *currently configured in settings*, not which model *wrote a given line*. Concretely useful lesson: don't conflate "which AI tool/model is active" with "who wrote this code" — they're different questions, and marketing-grade accuracy claims in this space should be treated skeptically by default. |
| **git-ai** (`git-ai-project/git-ai`) | **Explicit attribution, not detection.** Agents call `git-ai checkpoint` to self-report which lines they wrote; data is stored in **Git Notes** and is "eventually consistent" — recomputed after rebase/squash/cherry-pick rather than tracked live through them | N/A (ground truth by construction, not inferred) | **Yes** — [github.com/git-ai-project/git-ai](https://github.com/git-ai-project/git-ai) | Most technically relevant prior art. Explicitly lists Claude Code as a supported agent. Storing attribution in **Git Notes** (rather than extension local-storage/JSON) is a genuinely different, more portable persistence model than Tourist's — worth a deliberate compare against our branch-scoped local-storage approach (see §6). Documented gaps we should note as shared hard problems: `git mv`/renames not tracked, `git filter-branch`/`filter-repo` unsupported, and multi-repo `cwd` correctness for bash-only attribution. |
| **HumanAI Tracker** (`altmemy/humanai-tracker`) | Large-insertion detection (≥30 chars), direct Copilot/TabNine/Kite/CodeWhisperer API integration, superhuman typing speed (>50 chars/sec), clipboard-paste monitoring for ChatGPT/Claude-style pastes, AI "comment signature" pattern matching, user-adjustable confidence threshold | None validated | **Yes** — [github.com/altmemy/humanai-tracker](https://github.com/altmemy/humanai-tracker) | Confirms clipboard/paste-velocity heuristics (the CodePause-style signals) are common in this space but the project's own docs mark most of them "Basic"/"Limited" — i.e., even its author doesn't trust them much. Reinforces that velocity/paste-size heuristics belong at a low-confidence tier, never as ground truth. |
| **AI Insights – Token Tracker** (`thewalking-dev.ai-insights`, aka `milan-holes/ai-insights-extension`) | Not line attribution — reads **existing local session logs** per tool: Claude Code's own `~/.claude/projects/*.jsonl` token counts, Copilot's workspace-storage chat files, Codex's local session snapshots, estimated text-length heuristics for others | Explicitly caveats its own numbers as "local, best-effort... not an exact reconciliation" | **Yes** — [github.com/milan-holes/ai-insights-extension](https://github.com/milan-holes/ai-insights-extension), MIT | Not a line-attribution tool, but useful confirmation that **reading Claude Code's own on-disk session transcripts is an established, working pattern** (this is exactly the data source Tourist's prompt-scoring feature already uses) — a viable *supplementary* ground-truth source alongside hooks if we ever need richer session context (e.g., correlating an edit's timestamp to a specific user prompt, similar to Tourist's "Fix Line Attribution" LLM step). |
| *(bonus)* **@codeslick/ai-detection** (npm) | 13 "code smell" heuristics (over-engineering, wrapper functions, "too-perfect" code), 32 named "LLM fingerprints" tied to specific tools including Claude Code (verbose docstrings/defensive null-checks → GPT-4 style; boilerplate comments/generic names → Copilot style; explanatory comments/custom errors → "Claude Code style"), plus hallucination-pattern detection; weighted score: hallucinations 60%, heuristics 25%, fingerprints 15% | Confidence bands only, no validated accuracy | Package is published to npm; repo not directly confirmed in this pass | The most methodologically sophisticated *pure-stylometric* approach found. Worth keeping in mind purely as a **Tier-4 fallback** (see revised model, §5) for files with zero hook coverage and zero live-process corroboration — but per-model "fingerprints" are trivially defeated by prompting style/formatter changes and will rot as models evolve, so treat as a weak, decaying signal only. |

**Overall takeaway for our design:** none of the 8 tools use anything resembling Claude Code's own hooks as ground truth combined with disk-write timing as a corroborating signal — our Tier-1/Tier-2 combination (§5) appears to be a genuinely novel synthesis in this landscape, not something to copy from a competitor. The one directly comparable idea (git-ai's Git-Notes-based explicit attribution) is a *push*-model (agent self-reports) rather than our *pull*-model (we infer from hooks + editor state), and is worth a deliberate architecture comparison, not just a footnote.

---

## 2. Tier-2 corroboration: detecting a live `claude` process for the workspace

**Goal:** when we see "disk write while document was clean," decide with higher
confidence whether it's Claude Code (vs. prettier, git, another agent, Live
Share, etc.) by corroborating with "is a `claude` process currently active for
this workspace."

### Approach A — OS process scan (`ps`/`ps-list`)

- `ps-list` (npm, by sindresorhus) is a maintained, cross-platform (macOS/
  Linux/Windows) wrapper that returns `{pid, name, cmd, ppid, cwd?, ...}` for
  running processes. **CONFIRMED** it exists and is maintained — [github.com/sindresorhus/ps-list](https://github.com/sindresorhus/ps-list), [npmjs.com/package/ps-list](https://www.npmjs.com/package/ps-list).
- Caveats **CONFIRMED** from its own docs: on **Windows**, `cmd`, `cpu`,
  `memory`, `uid`, `path`, and `startTime` are **not available** — so matching
  a Windows `claude` process to a specific workspace path by inspecting its
  command line/cwd is not reliably possible with this library on Windows.
  Windows ARM64 is also unsupported.
- Even on macOS/Linux where `cmd` is available, matching "this `claude`
  process belongs to *this* workspace" requires string-matching the process's
  reported cwd or command-line args against the workspace path — fragile if
  the user launched `claude` from a parent directory, a monorepo subfolder,
  or `--worktree`/`--add-dir` flags. **PLAUSIBLE** but not demonstrated.
- Process scanning is inherently polling-based (no push notification when a
  process starts/stops), so there's an unavoidable latency/battery-usage
  trade-off, and a race window right at the start/end of a `claude` session.

**Verdict: PLAUSIBLE, but fragile — workable as a coarse corroboration signal
on macOS/Linux, materially weaker on Windows.**

### Approach B — Claude Code's own environment variables

- **CONFIRMED**: Claude Code sets `CLAUDECODE=1` in the environment of
  processes it considers itself to be "running inside" — [code.claude.com/docs/en/env-vars](https://code.claude.com/docs/en/env-vars), corroborated by multiple community references (e.g. [gist.github.com/unkn0wncode](https://gist.github.com/unkn0wncode/f87295d055dd0f0e8082358a0b5cc467)).
- **Important limitation, CONFIRMED by design intent**: this variable is set
  in the environment Claude Code *hands to child processes it spawns* (e.g.
  when it shells out to run a bash command). It is **not** something a
  separate VS Code extension process can read out of a sibling terminal's
  `claude` process without itself being a child of that process or reading
  `/proc/<pid>/environ` (Linux-only, permissions-gated) or platform
  equivalents. On macOS there is no direct unprivileged API to read another
  process's environment variables from Node.js. **UNVERIFIED — NEEDS SPIKE**
  whether any practical, permission-safe way exists to read env vars of an
  arbitrary sibling process across macOS/Linux/Windows from a VS Code
  extension host.
- **More promising, CONFIRMED**: the VS Code extension's own IDE-side
  auto-connect mechanism works by "injecting `CLAUDE_CODE_SSE_PORT` +
  `ENABLE_IDE_INTEGRATION` into processes spawned by the integrated terminal"
  ([code.claude.com/docs/en/vs-code](https://code.claude.com/docs/en/vs-code), corroborated by [coder/claudecode.nvim PROTOCOL.md](https://github.com/coder/claudecode.nvim/blob/main/PROTOCOL.md)). This means: **when a `claude` process is started inside VS Code's own integrated terminal**, VS Code (or the Claude Code extension) is already threading environment variables into it. This is a strong, structural signal — but it only covers surface (b) (Claude Code CLI launched from VS Code's integrated terminal), not a `claude` process in an external Terminal.app/iTerm2/tmux session outside VS Code's purview.

### Approach C — VS Code lock-file discovery mechanism (the real ground truth)

This is the most reliable and well-documented mechanism found, and arguably
should **replace** naive process-scanning as the corroboration signal:

- **CONFIRMED** (official docs, [code.claude.com/docs/en/vs-code](https://code.claude.com/docs/en/vs-code)): when the Claude Code VS Code extension is active, it runs a local MCP server named `ide`. It binds to `127.0.0.1` on a random port in `10000–65535`, writes a lock file to `~/.claude/ide/<port>.lock` (or `$CLAUDE_CONFIG_DIR/ide/` if set) with `0600` permissions in a `0700` directory. The lock file contains connection info (confirmed by the independent [claudecode.nvim PROTOCOL.md](https://github.com/coder/claudecode.nvim/blob/main/PROTOCOL.md) reverse-engineering to include `pid`, `workspaceFolders`, `ideName`, `transport`, `authToken`).
- This means: **our own extension can watch `~/.claude/ide/*.lock` (or `$CLAUDE_CONFIG_DIR/ide/`)** and parse `workspaceFolders` to determine, with high confidence and near-zero polling cost (a filesystem watcher, not a process scan), whether *some* IDE-integrated Claude Code session is currently connected for this workspace. This directly covers surface (b).
- For surface (a) (bare terminal CLI with no VS Code extension involved, or run with `/ide` in an external terminal that then also connects to the same lock file/WebSocket) — **CONFIRMED**: docs say "If using an external terminal, run `/ide` inside Claude Code to connect it to VS Code" ([code.claude.com/docs/en/vs-code](https://code.claude.com/docs/en/vs-code)). When that happens, the same lock-file/WebSocket mechanism is used, so **watching the lock file directory covers both surfaces (a) and (b) whenever the CLI is IDE-connected** — but a bare-terminal `claude` session that is *never* `/ide`-connected produces no lock file we can observe this way, and Tier-2 corroboration falls back to the (weaker) process-scan approach for that specific case.
- We could go further: since the lock file is just JSON with `0600`
  permissions readable by our own extension process (same user), we could
  in principle **open a WebSocket connection to that same `ide` server
  ourselves** (using the auth token from the lock file) to ask it directly
  for `getWorkspaceFolders`/`getOpenEditors`, turning "is Claude active" into
  a live, authoritative RPC call instead of an inference. This is an
  interesting stretch idea but overlaps with functionality the *official*
  extension already owns, and running two consumers against the same
  loopback WebSocket needs testing. **UNVERIFIED — NEEDS SPIKE.**

**Revised recommendation:** replace "scan `ps` for a `claude` process" with
"watch `~/.claude/ide/*.lock` for a lock file whose `workspaceFolders` (or
`pid`'s cwd) matches this workspace" as the *primary* Tier-2 corroboration
signal, since it's push-based (fs watch, not polling), documented, and
directly reflects Claude Code's own concept of "connected to this workspace."
Keep OS process-scanning (`ps-list`) purely as a secondary fallback for the
pure-bare-terminal, never-`/ide`-connected case.

---

## 3. Terminal Shell Integration API as a precision signal

**CONFIRMED** (VS Code docs + API reference, [code.visualstudio.com/docs/terminal/shell-integration](https://code.visualstudio.com/docs/terminal/shell-integration), [code.visualstudio.com/api/references/vscode-api](https://code.visualstudio.com/api/references/vscode-api)):

- `vscode.window.onDidStartTerminalShellExecution` / `onDidEndTerminalShellExecution`
  fire **only when shell integration is active** for that terminal — VS Code's
  own docs state the end event "will fire only when shell integration is
  activated for the terminal," and by symmetry the start event has the same
  gate.
- `TerminalShellExecution` exposes a `commandLine` (a `ShellExecutionCommandLine`
  with `value`, `confidence` — reported reliability of the captured string
  — and `isTrusted`) and (per API surface) a `cwd`.
- Shell integration is supported for **bash, fish, pwsh, zsh on macOS/Linux**,
  and **Git Bash, pwsh on Windows** — notably **not** plain `cmd.exe**, and
  quality is tiered **None / Basic / Rich** depending on how well the
  auto-injected shell script could hook into the given shell.
- Auto-injection can silently fail on older shell versions, in nested
  shells/`tmux`, or in some SSH scenarios, requiring manual script
  installation — meaning the "None" quality tier (no events at all) is a
  real, non-corner-case failure mode. **CONFIRMED** as documented behavior, not
  a hypothetical edge case.

**Implication for us:** if we can get `onDidStartTerminalShellExecution` to
fire with `commandLine.value` starting with `claude ` (or matching `claude`
with args) **and** a `cwd` matching our workspace, that is a genuinely more
precise corroboration signal than either process-scanning or the lock-file
approach — it tells us not just "a claude process exists somewhere" but "the
user, in this integrated terminal, in this cwd, just ran `claude`." This is
strictly better for surface (a) (bare CLI in VS Code's *integrated* terminal)
specifically.

**Important scope limitation, CONFIRMED by API semantics:** this only covers
`claude` invoked inside **VS Code's own integrated terminal**. It cannot see
a `claude` process running in an external Terminal.app/iTerm2/Windows
Terminal window outside VS Code, and it cannot see anything if the user's
shell doesn't support shell integration or the injection failed. So: **great
precision, narrower coverage than the lock-file approach** — the two are
complementary, not substitutes. Recommend using shell-integration detection
as an *additional*, higher-confidence corroboration path layered on top of
lock-file watching, not a replacement.

**Tag: PLAUSIBLE overall** (the API surface and its gating behavior are
confirmed from docs), but the actual reliability of `commandLine.confidence`
for a real `claude ...` invocation, and whether `cwd` is populated
consistently across bash/zsh/fish/pwsh, is **UNVERIFIED — NEEDS SPIKE.**

---

## 4. Claude Code VS Code extension diff Accept/Reject mechanics

This was the hardest area to pin down and directly determines whether
Tourist's dirty-state heuristic would misfire inside the official extension.
Findings, layered from most to least authoritative:

### What's CONFIRMED from Anthropic's own docs ([code.claude.com/docs/en/vs-code](https://code.claude.com/docs/en/vs-code)):

- The extension runs a local **`ide` MCP server** the CLI auto-connects to.
  It exposes "a dozen tools" internally, but **only two are visible to the
  model itself**: `mcp__ide__getDiagnostics` (read-only) and
  `mcp__ide__executeCode` (Jupyter-only, always requires a native confirm
  dialog). Quote: *"The rest are internal RPC the CLI uses for its own UI —
  opening diffs, reading selections, saving files — and are filtered out
  before the tool list reaches Claude."*
- This is a critical finding: **the model does not "call a tool" to open a
  diff or write a file as far as its own tool-use loop is concerned.** The
  actual file mutation is still Claude Code's ordinary `Edit`/`Write`/
  `MultiEdit` tool (the same ones hooks already fire for identically in CLI
  and extension, per the prior research pass) — the diff *viewer* is a
  side-effect the IDE integration adds transparently around that same
  tool call, gated by the session's **permission mode**: *"Manual: Claude
  asks permission before file edits... Edit automatically: Claude makes
  edits without asking."*
- This directly reinforces (does not contradict) prior finding #2: hooks fire
  around the same underlying tool execution in both surfaces. What differs
  between CLI and extension is only *whether/how a human approves the edit
  before it executes*, not the mechanism of the edit itself once approved.

### What's PLAUSIBLE from a reverse-engineered, independent third-party client implementing the *same* CLI-facing protocol:

`coder/claudecode.nvim` ([github.com/coder/claudecode.nvim](https://github.com/coder/claudecode.nvim), [PROTOCOL.md](https://github.com/coder/claudecode.nvim/blob/main/PROTOCOL.md)) is a Neovim plugin that implements the identical `ide` MCP protocol so that the *same* `claude` CLI binary can talk to Neovim as if it were VS Code. Because it targets interoperability with the real CLI, its protocol-level description is a good proxy for what the CLI expects any IDE (including the real VS Code extension) to do, even though it says nothing about VS Code's own internal implementation:

- The CLI-internal tool is called **`openDiff`**, taking `old_file_path`,
  `new_file_path`, `new_file_contents`, `tab_name`. It's a **blocking/deferred
  call**: the IDE shows a diff and the tool call doesn't resolve until the
  user acts. It resolves to either **`FILE_SAVED`** (with final, possibly
  user-edited, content) or **`DIFF_REJECTED`**.
  - This matches the docs' own description of the review step: *"If you edit
    the proposed content directly in the diff view before accepting, Claude
    is told that you modified it."*
- A companion internal tool, **`saveDocument`**, and **`checkDocumentDirty`**
  (returning `{isDirty, isUntitled}` for a given `filePath`) exist in the
  tool inventory — meaning the IDE-side protocol itself has an explicit
  concept of document dirtiness, which the extension presumably uses
  internally for its own UI logic (e.g. auto-saving before Claude reads a
  file, per the `autosave` setting documented as `true` by default).

### The open, unresolved question — UNVERIFIED, NEEDS SPIKE:

**Does accepting a diff in the VS Code extension result in (a) a raw
`fs.writeFile`-style disk write identical to bare-CLI behavior (so any
*separately open, unmodified* editor tab on that file would see it as a
silent "clean → clean" reload, exactly like Tourist's existing heuristic
expects), or (b) an editor-mediated `TextDocument`/`WorkspaceEdit` apply +
save on the *diff tab's own document* that could interact with dirty-state
differently** — e.g. if the diff tab and the "real" open editor for that file
are, under the hood, either the same document object or two different ones
that get reconciled on save?

Neither the official docs nor the Neovim protocol doc (which describes only
its own Emacs/Neovim-side buffer-mediated implementation, not VS Code's)
settle this. Genuinely undocumented from the outside. Two plausible resolutions
exist and have different implications for our heuristic:

1. If the underlying `Edit`/`Write` tool call writes to disk exactly as it
   does in the bare CLI (most likely, since the doc explicitly says the model
   only ever sees the ordinary file-editing tools, and the diff/approval
   layer is described as a wrapper *around*, not a *replacement* for, that
   tool) — then **Tourist's dirty-heuristic behaves identically** for both
   surfaces once the edit is approved: any *other* open, clean tab on that
   file reloads silently and would correctly read as "ai" under our Tier-2
   disk-write-while-clean signal, corroborated by the `ide` lock file being
   present (§2).
2. If VS Code's diff editor itself *is* backed by the real document (i.e.
   the "right-hand side" of the diff view is the live editable document for
   that file, and clicking "Accept" is functionally a save on that document)
   — then the document could transiently show as **dirty** during review
   (especially if the user edits the proposed diff before accepting, which
   the docs explicitly support), which would cause Tourist's heuristic to
   mislabel the edit as "human" the moment a human so much as *touches* the
   proposed diff, even without typing original code.

Recommendation: this is exactly the kind of thing item in the "open questions"
list (§7) that must be settled with a throwaway spike — instrument
`onDidChangeTextDocument`/`workspace.onDidSaveTextDocument`/document
`isDirty` while driving the real Claude Code VS Code extension through a
Manual-mode edit-and-accept cycle on a file that is simultaneously open in a
plain editor tab, and separately through an edit-and-manually-tweak-then-
accept cycle. This is fast to test empirically and should be one of the
first things the spike does, since it gates whether the Tier-1/Tier-2 design
needs a VS Code-extension-specific branch at all.

---

## 5. Prior art: AI-text detection heuristics unrelated to editor integration (light pass)

For a possible future Tier-4 fallback signal on files with neither hook
coverage nor a corroborated live process:

- **Perplexity/burstiness** (the "classic" GPTZero-era approach): score text
  by how surprising it is to a reference language model; AI text tends to
  have lower average perplexity and lower "burstiness" (more uniform
  per-sentence perplexity) than human text. **CONFIRMED** as GPTZero's
  original approach, but also **CONFIRMED abandoned by GPTZero itself**: "as
  of autumn 2023, GPTZero no longer uses perplexity and burstiness... it
  migrated to a deep-learning based architecture" ([gptzero.me/news/perplexity-and-burstiness-what-is-it](https://gptzero.me/news/perplexity-and-burstiness-what-is-it/)). Notable as a
  cautionary data point: even the tool that popularized this heuristic
  concluded it wasn't good enough on its own.
- **DetectGPT / Fast-DetectGPT**: perturb the text with LLM-suggested word
  substitutions and check how much the log-probability under a reference
  model changes; the hypothesis is that AI-written text sits in a local
  probability-density optimum, so perturbations drop its likelihood more
  than for human text. Fast-DetectGPT approximates this with a single model
  call instead of many. **CONFIRMED** as a real, cited research approach
  (arXiv). Compute-heavy for a live editor extension (needs a reference LLM
  available locally or via API on every check).
- **Binoculars**: uses *two* LLMs and a "cross-perplexity" ratio between them
  to score AI-likelihood without needing labeled training data.
  **CONFIRMED** as a real method (cited in research summaries), same
  compute-cost caveat as above.
- **Code-specific stylometric/fingerprint detectors** (see §1's
  `@codeslick/ai-detection`): heuristics like "too-perfect" code, defensive
  null-checks, verbose docstrings, generic variable names, boilerplate
  comments mapped to specific tools/models. **PLAUSIBLE** as a supplementary
  weak signal, but self-admittedly brittle (per-model "fingerprints" drift as
  models and default system prompts change) and gameable by anyone
  reformatting the code or changing prompting style.

**Overall assessment:** none of these are close to precise enough, or cheap
enough at editor-typing latency, to be more than a last-resort, clearly
lower-confidence bucket — consistent with treating this as secondary. If we
ever build it, it should compute lazily (on-demand / on-save, not on every
keystroke) and should never be allowed to override a hook-based or
corroborated-disk-write signal.

---

## 6. Multi-root workspaces and git worktrees for per-branch attribution

- **CONFIRMED**: VS Code exposes the built-in Git extension's API via
  `vscode.extensions.getExtension('vscode.git')` → `.exports.getAPI(1)` →
  `gitApi.repositories` (each a `Repository` with `.rootUri` and `.state`).
  `repository.state.HEAD.name` is the documented pattern for reading the
  current branch name; the extension's own source (`extensions/git/src/api/git.d.ts`,
  `api1.ts` in `microsoft/vscode`) is the ground truth for the full typed
  surface, though this pass didn't pull the exact `.d.ts` text (**UNVERIFIED
  — worth pulling verbatim during the spike** since exact event names for
  "branch changed" (`repository.state.onDidChange`?) matter for wiring a
  live branch-change listener rather than polling).
- **CONFIRMED**: for **multi-root workspaces**, each root folder that's a git
  repo gets its **own** `Repository` object in `gitApi.repositories` and its
  own Source Control provider entry — so per-folder branch resolution is a
  matter of matching a given file's `Uri` to the correct `workspaceFolder`
  (`vscode.workspace.getWorkspaceFolder(uri)`) and then to the matching
  `Repository` by comparing `rootUri`, not just taking "the" active
  repository.
- **CONFIRMED** (git internals, independent of VS Code): a **linked git
  worktree**'s `.git` is a **file**, not a directory, containing
  `gitdir: /path/to/main/.git/worktrees/<name>` — any code (ours included)
  that assumes `.git` is always a directory (e.g. naively watching
  `<repo>/.git/HEAD` as Tourist's existing git-guard logic does) will
  **break silently** in a worktree checkout, since the real `HEAD`/`index`
  files live under the *main* repo's `.git/worktrees/<name>/` directory, not
  under the worktree's own `.git`. This is a concrete, previously-unlisted
  bug class for our design to defend against explicitly, given that Claude
  Code itself **documents and encourages using `--worktree`/`-w` for
  parallel sessions** ([code.claude.com/docs/en/vs-code](https://code.claude.com/docs/en/vs-code), [.../worktrees](https://code.claude.com/docs/en/worktrees)) — i.e. our exact target user is likely to
  be a heavy worktree user.
- **Practical implication:** rather than hand-rolling `.git/HEAD` file
  parsing at all (which has to special-case the worktree indirection file,
  and doesn't cover detached-HEAD edge cases well), we should **prefer the
  VS Code Git extension API** (`repository.state.HEAD.name`,
  `repository.state.HEAD.commit`) as the source of truth for "current
  branch," per-folder, and only fall back to raw `.git` file watching (with
  correct worktree indirection handling) as a last resort if the Git
  extension isn't installed/enabled — this is materially more robust than
  Tourist's approach of watching `.git/HEAD`/`.git/index` directly.

**Tag: mostly CONFIRMED at the concept level; the exact API event names/
signatures for live branch-change notification need to be pulled verbatim
from `vscode.git`'s `.d.ts` during the spike.**

---

## 7. Revised 3-tier signal model + data model

### Revised tier model (changes from the prior pass marked with →)

| Tier | Signal | Confidence | Notes |
|---|---|---|---|
| **1 — Ground truth** | Claude Code `PreToolUse`/`PostToolUse` hook diff (per prior pass) | Highest | Unchanged from prior hypothesis. Covers both surfaces (a) and (b) since hooks fire identically regardless of terminal-vs-extension (CONFIRMED, prior pass + reinforced by §4's finding that the model only ever calls the ordinary Edit/Write tools regardless of surface). |
| **2a — Corroborated disk write (lock-file based)** → *new, replaces plain process-scan as primary* | Disk write while doc was clean-before-and-after, **corroborated by an active `~/.claude/ide/*.lock` file** whose `workspaceFolders`/`pid` matches this workspace | High | §2 Approach C. Push-based (fs watch), documented, and reflects Claude Code's own notion of "connected to this workspace." Covers CLI-in-integrated-terminal-with-`/ide`, and the full VS Code-extension surface. |
| **2b — Corroborated disk write (shell-integration based)** → *new, additive precision layer* | Same disk-write-while-clean signal, additionally corroborated by `onDidStartTerminalShellExecution` reporting a `commandLine` starting with `claude` and a matching `cwd` in a VS Code **integrated** terminal | High (higher precision, narrower coverage than 2a) | §3. Layer on top of 2a when available; don't require it (only fires for integrated-terminal shells with shell-integration active). |
| **2c — Corroborated disk write (process-scan fallback)** → *demoted from primary to fallback* | Same disk-write-while-clean signal, corroborated by an OS-level `claude` process found via `ps-list` with cwd/cmd matching the workspace | Medium (fragile, esp. Windows) | §2 Approach A. Only consulted when 2a/2b both come back "no corroboration," to catch the pure-bare-terminal-never-`/ide`-connected case. |
| **3 — Uncorroborated disk write** | Disk write while doc was clean-before-and-after, but **none** of 2a/2b/2c corroborate an active Claude Code session | **"external/unknown"**, not "ai" | Unchanged from prior hypothesis — this remains the key differentiator vs. Tourist. Catches prettier/black/gofmt/other-agent/Live-Share/codegen cases correctly instead of mislabeling them "ai." |
| **4 — Stylometric fallback** → *new, explicitly optional/experimental* | Static code-pattern/fingerprint heuristics (§5) run lazily (on save, not per-keystroke) on files/ranges that fall into Tier 3 | Low, decaying over time | Never overrides 1/2a/2b/2c. Off by default; consider it a stretch feature, not core scope. |

Everything the *document-dirty* signal touches (i.e., distinguishing "human
typed this" from "not human typed this" in the first place) is unchanged
from Tourist's original insight — the tiers above only refine how we decide
*which flavor* of "disk write while clean" we're looking at.

### Data model refinement (unchanged core idea, sharpened by research)

- Keep the **piece-table / position-mapped range structure** from the prior
  pass (remap attribution ranges through each edit's `rangeOffset`/
  `rangeLength`/`text` via `onDidChangeTextDocument`, since VS Code's native
  `DecorationRangeBehavior` only stretches range *edges*, not interior
  edits) — nothing in this research pass contradicts that; it's still the
  right structural fix to Tourist's flat-array desync bug.
- **Branch-scoped persistence**: prefer using the VS Code Git extension API
  (`repository.state.HEAD.name`) as the branch key instead of raw
  `.git/HEAD` parsing (§6), and explicitly resolve `.git`-as-file (worktree
  indirection) if ever falling back to raw filesystem watching. Key
  persistence per **repository root + branch name** pair (not just branch
  name) so multi-root workspaces with same-named branches in different repos
  don't collide.
- **Corroboration state** should be modeled as its own small piece of
  observable state (e.g. `activeClaudeSessions: Map<workspaceFolderUri,
  {source: 'lock-file'|'shell-integration'|'process-scan', since: Date}>`)
  that Tier 2a/2b/2c all write into and Tier-2/3 classification reads from —
  keeping "is Claude active here" as a single reusable fact rather than
  three parallel ad hoc checks scattered through the edit-classification
  code path.

---

## 8. Open questions for an empirical spike (ordered)

A minimal throwaway extension should answer these, in roughly this order
(each mostly gates the next; do 1–3 before investing in 4+):

1. **Diff-accept mechanics (§4, the biggest unknown).** Drive the real Claude
   Code VS Code extension through: (a) Manual-mode edit + Accept on a file
   simultaneously open in a plain tab — does the plain tab's document ever
   go dirty, or does it silently reload clean-to-clean exactly like bare-CLI
   writes? (b) Same, but edit the proposed diff before accepting — does
   *that* dirty anything observable via `onDidChangeTextDocument`/
   `isDirty`? (c) Repeat with `acceptEdits`/auto-accept mode. This
   determines whether the VS Code-extension surface needs any special-casing
   at all beyond Tier-1/2a, or whether it's already handled identically to
   bare-CLI.
2. **Lock-file corroboration in practice (§2C).** Watch
   `~/.claude/ide/*.lock` (and `$CLAUDE_CONFIG_DIR/ide/*.lock`) while opening/
   closing Claude Code sessions (both extension-native and `/ide`-connected
   external terminal) — confirm file appears/disappears reliably and
   promptly on session start/stop, confirm `workspaceFolders` contents match
   expectations for single-root and multi-root workspaces, and measure
   staleness (does a crashed session leave a stale lock file behind, and for
   how long?).
3. **Shell-integration precision (§3).** Confirm `onDidStartTerminalShellExecution`
   actually fires with a usable `commandLine.value`/`cwd` for a real `claude`
   invocation across bash, zsh, fish, and pwsh on the team's actual dev
   machines — and confirm the "None quality" (no events) failure mode is
   detectable so we know when to *not* trust the absence of a shell-execution
   event as "claude isn't running."
4. **Hook coverage completeness.** Re-verify (per prior pass's own caveat)
   that PreToolUse/PostToolUse hooks reliably fire for Edit/Write/MultiEdit
   in *current* Claude Code versions in both surfaces, including the
   `--worktree` case, since that's Tier 1 and everything else is secondary
   to it.
5. **`contentChanges` ordering (carried over from prior pass, still open).**
   Confirm on current VS Code whether `TextDocumentContentChangeEvent[]` can
   still arrive non-bottom-to-top, since this affects the piece-table remap
   loop's correctness, not just Tourist's original splice loop.
6. **Git extension branch-change events (§6).** Pull the exact `.d.ts` for
   `vscode.git`'s `Repository.state` change events (verbatim), confirm they
   fire promptly on checkout/rebase/worktree-switch, and confirm behavior
   when the Git extension is disabled or a folder isn't a git repo at all
   (need a documented fallback path).
7. **Process-scan viability as last-resort (§2A).** If time allows, confirm
   `ps-list` can actually correlate a `claude` process to a specific
   workspace path on macOS/Linux (Windows already known-weaker per its own
   docs) — this is the lowest-priority item since it's Tier 2c (fallback of
   a fallback).

---

## Sources

- [github.com/Dibae101/AuthentiCraft](https://github.com/Dibae101/AuthentiCraft) — AuthentiCraft source
- [marketplace.visualstudio.com/.../authenticraft](https://marketplace.visualstudio.com/items?itemName=DibyaDarshanKhanal.authenticraft)
- [marketplace.visualstudio.com/.../difai](https://marketplace.visualstudio.com/items?itemName=Ph03n1x.difai)
- [marketplace.visualstudio.com/.../codespy-ai-detector](https://marketplace.visualstudio.com/items?itemName=CodespyAIDetectorforSourceCode.codespy-ai-detector)
- [marketplace.visualstudio.com/.../is-ai-code-vscode](https://marketplace.visualstudio.com/items?itemName=johnoseni.is-ai-code-vscode)
- [github.com/thisis-romar/vscode-ai-model-detector](https://github.com/thisis-romar/vscode-ai-model-detector)
- [github.com/git-ai-project/git-ai](https://github.com/git-ai-project/git-ai)
- [github.com/altmemy/humanai-tracker](https://github.com/altmemy/humanai-tracker)
- [marketplace.visualstudio.com/.../ai-insights (thewalking-dev)](https://marketplace.visualstudio.com/items?itemName=thewalking-dev.ai-insights) / [github.com/milan-holes/ai-insights-extension](https://github.com/milan-holes/ai-insights-extension)
- [npmjs.com/package/@codeslick/ai-detection](https://www.npmjs.com/package/@codeslick/ai-detection) (via codeslick.dev learn article)
- [github.com/sindresorhus/ps-list](https://github.com/sindresorhus/ps-list)
- [code.claude.com/docs/en/env-vars](https://code.claude.com/docs/en/env-vars)
- [code.claude.com/docs/en/vs-code](https://code.claude.com/docs/en/vs-code) — official IDE MCP server + diff behavior docs
- [code.claude.com/docs/en/worktrees](https://code.claude.com/docs/en/worktrees)
- [github.com/coder/claudecode.nvim](https://github.com/coder/claudecode.nvim), [PROTOCOL.md](https://github.com/coder/claudecode.nvim/blob/main/PROTOCOL.md)
- [deepwiki.com/manzaltu/claude-code-ide.el/4.3-diff-operations](https://deepwiki.com/manzaltu/claude-code-ide.el/4.3-diff-operations)
- [code.visualstudio.com/docs/terminal/shell-integration](https://code.visualstudio.com/docs/terminal/shell-integration)
- [code.visualstudio.com/api/references/vscode-api](https://code.visualstudio.com/api/references/vscode-api)
- [gptzero.me/news/perplexity-and-burstiness-what-is-it](https://gptzero.me/news/perplexity-and-burstiness-what-is-it/)
- arXiv papers on DetectGPT/Fast-DetectGPT/Binoculars-family detection (surfaced via search, titles: "GPTZero: Robust Detection of LLM-Generated Texts"; general AI-text-detection surveys)
- microsoft/vscode issues on `contentChanges` ordering: #11487, #111548 (carried over from prior pass, not re-verified this pass)
