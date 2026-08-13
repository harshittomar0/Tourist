# Architecture (plain-language overview)

Tourist is a VS Code extension that colors every line of code by who wrote it: **AI** (Claude
Code), **human** (you), or **unknown** (something else, like a formatter). This is a quick,
non-technical map of the codebase. For the deeper product pitch and design reasoning, see
`README.md` and `GOAL1.md`.

## What's in the folders

- **`src/core/`** — the "brain": figures out who wrote each line, with no dependency on VS Code
  itself (so it's easy to test).
- **`src/adapters/`** — watches for clues that Claude Code is active (log files, lock files,
  terminal activity, running processes).
- **`src/persistence/`** — saves the results to disk, and can optionally sync them via Git so
  teammates share the same history.
- **`src/vscode-integration/`** — the part you actually see: colored gutters, status bar, and the
  "Knowledge Map" side panel.
- **`src/extension.ts`** — the one file that starts everything up when the extension loads.
- **`hooks/`** — a small script Claude Code itself runs, giving Tourist a direct, guaranteed-
  accurate signal ("I just edited this file") instead of a guess.
- **`test/`** — the automated tests, including ones that launch a real VS Code window.
- **`ideation/knowledge-forest/`** — a separate, experimental feature that tries to map what a
  developer knows, using some of the same data.
- **`spike/`** — early, disposable research code used to answer open questions before real
  building started.
- **`website/`** — the marketing landing page; not part of the extension itself.
- **`GOAL1.md`, `PLAN1.md`, `RESEARCH1.md`, `REVIEW_JRDEV.md`, `REVIEW_SENIOR.md`** — background
  docs: the original vision, the build plan, research notes, and two code reviews done partway
  through.

## How it decides who wrote what

Tourist doesn't just guess "if I don't recognize it, it must be AI." It only labels something
`ai` when it has real evidence, in order of strength:

1. **Best evidence** — Claude Code tells Tourist directly, via the hook script, that it just made
   this exact edit.
2. **Good evidence** — no direct tip-off, but a file was silently rewritten (not typed by hand)
   *and* there's a sign Claude Code was active at the time (its session was open, or it was
   running in the terminal).
3. **No evidence** — a file was silently rewritten with no sign of Claude Code nearby. This gets
   labeled **unknown**, not AI — it could be a code formatter, another tool, or something else.
4. Anything typed by hand is labeled **human**.

That "unknown" bucket is the key design choice: without it, any silent rewrite would get
misattributed to AI, which would make the whole tool untrustworthy.

## How it was built

The project was built by several AI agents working in parallel, each one responsible for a
different folder (the "brain," the storage layer, the VS Code UI, and the tests), coordinating
through a shared, agreed-upon plan rather than stepping on each other's code.

Worth saying honestly: the first version didn't actually work. After merging everyone's work
together, two independent reviews found real bugs — most notably, the piece that was supposed to
detect Claude Code activity was never actually turned on, so every real AI edit was being labeled
"unknown," the opposite of what it should do. There were a couple of other bugs too, like some
attribution history not surviving a save/reload. All of these were caught by writing real tests
that exercised the actual code, not just by reading it, and were then fixed. The lesson: having
multiple agents build in parallel is fast, but the seams where their work joins together need real
testing before you can trust the result.
