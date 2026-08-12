# Knowledge forest — ingestion pipeline plan

Status: spike, verified end-to-end except an actual live call to either Claude backend (neither a `claude` CLI nor an `ANTHROPIC_API_KEY` is available in the environment this was built in — everything up to and including prompt construction was run for real against this repo's own git history and tourist's real attribution log; see "What's built vs. not built yet" below).

## Scope boundary — read this first

**This is a separate, opt-in CLI tool, not a feature of the Tourist extension.** Tourist's own stated design principle (`GOAL1.md`: local-first, "no phoning code home to a classifier... a hard no") is specifically about the shipped extension's always-on runtime. This tool is a different thing entirely: a manually-invoked script that sends git diffs and (optionally) prompt text to the Anthropic API, and it should stay that way —

- Never wired into `src/extension.ts` or any `activationEvents`.
- Never runs without the user explicitly typing the CLI command. It talks to Claude via one of two backends (`claude/client.ts`, chosen with `--claude-backend`): the default `cli` backend shells out to the already-authenticated `claude` CLI (no separate key — same shape as tourist-raw's `_run_claude_cli`); the `api-key` backend calls the Anthropic API directly and requires the user to have set `ANTHROPIC_API_KEY` themselves. Neither ever runs implicitly.
- Lives in `ideation/`, with its own `package.json`, never added to the root `tourist` package's dependencies or build.

If this ever graduates out of `ideation/` into a real feature, that's a deliberate product decision to make explicitly (probably as an opt-in VS Code command, default off, with its own clear consent screen) — not something to back into by ideation code slowly migrating into `src/`.

## What problem this solves

The UI (`ui/knowledge-forest.html`) already represents the three forests and lets a human confirm/reject/edit nodes. What it doesn't have is a way to *populate* the initial `ai`-provenance guesses — right now that's hand-written demo data (`data/forest.seed.json`). This pipeline is that population step.

## Data flow

```
                    ┌─────────────────────┐
                    │ taxonomy-guidelines  │  (single source of truth for
                    │        .md           │   what belongs where — read
                    └──────────┬───────────┘   verbatim into the system prompt)
                               │
  ┌──────────────┐             │            ┌──────────────────┐
  │  git history  │──diffs────▶│            │ tourist's own     │
  │  (gitSource)  │             │◀──ai/human─│ ai-edits.jsonl    │
  └──────────────┘             │  line split │ (attributionSource)│
                               │            └──────────────────┘
  ┌──────────────────┐         │
  │ Claude Code      │──user───▶
  │ session          │  prompts   (opt-in only, --include-prompts)
  │ transcripts      │
  │ (promptSource)   │
  └──────────────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │   buildPrompt.ts     │  system = guidelines + strict
                    │                      │  output contract; user = evidence
                    └──────────┬───────────┘  bundle, size-truncated
                               │
                               ▼
                    ┌─────────────────────┐
                    │  Claude call         │  (client.ts — "cli" backend
                    │  (--claude-backend)   │   [default] shells out to the
                    └──────────┬───────────┘   `claude` CLI, or "api-key"
                               │                calls the API directly)
                               │
                               ▼
                    ┌─────────────────────┐
                    │   validate.ts         │  forces provenance:"ai",
                    │                      │  drops uncited nodes,
                    │                      │  clamps proficiency 0-5
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │    merge.ts           │  never overwrites confirmed/gap;
                    │                      │  replaces stale ai guesses;
                    │                      │  appends new nodes; deletes nothing
                    └──────────┬───────────┘
                               │
                               ▼
                       data/forest.json  ◀── ui/knowledge-forest.html's
                                              next loader iteration reads
                                              this (see "Not built yet" below)
```

## Evidence sources, in detail

### 1. Git history (`sources/gitSource.ts`)
`listRecentCommits` + `getCommitDiff` + `getFileContentAtCommit`. This is the primary evidence source for **Tech Stack** (imports, dependency files, framework-specific code) and a secondary source for **Engineering Practice** (commit message quality, diff size/shape) and **CS Fundamentals** (algorithmic choices visible in the diff, per the guidelines' explicit note that this is a *weak* signal there).

### 2. Tourist's attribution log (`sources/attributionSource.ts`)
Reads the real `~/.claude/tourist-attribution/ai-edits.jsonl` that `hooks/attribution-hook.mjs` writes — the exact schema is `{ts, cwd, file, tool, contentHash, aiRanges: [{start,end}]}` (0-based post-edit line ranges). Used to answer: *of the lines in this diff, how many were actually Claude-Code-authored rather than the developer's own?* — directly implementing the "don't over-credit AI-assisted commits" concern flagged earlier in this project's design discussion.

**Known limitation, verified for real against this repo**: correlation works by exact content-hash match (sha1 of the full file content at a git commit vs. the hook's recorded post-edit snapshot hash). Running the CLI with `--dry-run` against tourist's own last 5 commits found **zero matches** — expected, since the hook only records a snapshot at the moment Claude Code makes an edit, and by the time that content is committed it's often been touched again (formatting, additional human edits, a different commit boundary). Exact-match correlation is deliberately conservative (never wrongly says "this was AI" when it wasn't), but it means real-world hit rate will be low until either (a) commits happen close to the edit with no intervening changes, or (b) a future version does fuzzy/hunk-level correlation instead of whole-file-hash matching. Documented here rather than silently shipped as if it reliably works — it's a real gap, not a bug to fix quietly.

### 3. Claude Code session transcripts (`sources/promptSource.ts`) — opt-in only
Reads `~/.claude/projects/<encoded-repo-path>/*.jsonl` (path-encoding scheme verified against a real transcript directory: both `/` and `.` become `-`). Only **user**-authored turns are extracted — Claude's own responses aren't evidence about the developer. This is the richest available signal for **CS Fundamentals** specifically (per the guidelines: reasoning/explanation is a stronger signal there than passive code-pattern inference), but it's also the most privacy-sensitive source in this pipeline — raw conversation content, not just code — hence gated behind an explicit `--include-prompts` flag, off by default.

## The Claude call

- **System prompt** = `taxonomy-guidelines.md`'s content embedded verbatim, plus a strict output contract (`claude/buildPrompt.ts`). Embedding the file directly (not a paraphrase in code) means the guidelines doc stays the single source of truth — edit that file, the next run picks it up with no code change.
- **Hard rule enforced in the prompt, and re-enforced defensively in code regardless of whether the model obeys**: the model may only ever emit `provenance: "ai"`. `confirmed` and `gap` are exclusively human states. `validate.ts` force-overwrites this field on every node regardless of what the model returned, so a prompt-injection-style attempt to get the model to claim `"confirmed"` (e.g. from adversarial content hiding in a commit message) can't actually produce a false "confirmed" node even if it fooled the model.
- **Every node must cite evidence** (`ref` + `detail`) or it's dropped during validation — this is both a hallucination guard and what makes the UI's future "why does it think this?" affordance possible.
- **Token budget**: `truncateEvidence` caps total evidence text (default 60k chars ≈ rough proxy for a safe token budget, not a precise count) before it's ever sent. For a repo with much more history than that, the honest fix is chunking into multiple calls (one per time window or per forest), not raising this number indefinitely — noted as Phase 3 below, not solved by this v1.
- **The model sees the existing forest, not just fresh evidence.** `buildUserContent` includes a `<existing-forest>` snapshot (label/provenance/proficiency per node, `forest/buildPrompt.ts`'s `renderExistingForest`) so the model can reuse exact existing labels (rule 4/7) instead of classifying blind, and so it knows which categories to actively look for fresh evidence about rather than only inventing new ones. `latent` stubs are left out of the snapshot on purpose — they're unevidenced guesses, not something worth spending context on avoiding duplicates of.
- **`--deep-dive "Django,Big-O"`** resolves each comma-separated label (or `"Parent > Child"` path, for disambiguating a repeated label) against the existing forest (`forest/deepDive.ts`) and, for anything that resolves, appends a system-prompt addendum asking the model to go well beyond the normal shallow pass for just those categories — finer-grained children, more specific evidence citations — while everything else stays at the usual depth. A label that doesn't exist yet is skipped and reported on stderr, not a run-ending error.
- **Two backends, one call site.** `claude/client.ts` exposes `createClaudeCaller({backend, model, cliPath})`; both `createCliClaudeCaller` (default — shells out to the already-authenticated `claude` CLI, no API key, ported from tourist-raw's `_run_claude_cli`) and `createApiKeyClaudeCaller` (calls the Anthropic API directly) implement the same `ClaudeCaller` signature, so `buildPrompt.ts`/`cli.ts` never need to know which one ran.

## Merge semantics (the provenance contract, enforced in code)

| Existing node's provenance | New run's finding for that label | Result |
|---|---|---|
| `confirmed` | anything | untouched (proficiency, provenance, evidence all frozen) — but children/latent still recurse, so a new sub-skill can still be *proposed* under a confirmed parent |
| `gap` | anything | untouched, same reasoning |
| `tracked` | new `ai` guess | proficiency/evidence/children/latent updated from the guess, but the node stays `tracked` (label frozen) — see types.ts. For a category the human typed in directly with no assessed proficiency yet, unlike `confirmed`/`gap` it's meant to keep tracking new evidence. |
| `ai` | new `ai` guess | fully replaced — an unconfirmed guess is exactly what's supposed to improve as more evidence arrives |
| *(no existing node)* | new `ai` guess | appended |
| existing node | *(run didn't mention it)* | untouched — silence isn't evidence a skill disappeared |

This is `forest/merge.ts`, unit-tested (`test/merge.test.ts`) including the "confirmed parent, new child" recursion case and the `tracked`-proficiency-updates-but-stays-`tracked` case specifically.

**On `tracked`**: `ui/knowledge-forest.html`'s "add node" action currently hardcodes `provenance: "confirmed"` for anything the human types in directly (it's still demo-data-only — see "Not built yet" below, so this isn't live yet either way). That conflates two different human intents that `confirmed` alone can't distinguish: "I reviewed a specific proficiency assessment and it's right, freeze it" vs. "I know this category exists, but I haven't assessed how deep — keep tracking it." `tracked` exists for the second case; a future pass wiring the UI to real `forest.json` data should have "add node" emit `tracked` (proficiency 1, as it does today) rather than `confirmed`, and reserve `confirmed` for the explicit "confirm" action on an AI-proposed node. Not done here — it's a one-line change in a file that's still demo-only, and out of this pass's scope.

## What's built vs. not built yet

**Built and tested** (65 passing tests, `tsc --strict` clean, and a real dry-run against tourist's own repo/attribution-log/guidelines that produced a real, inspectable prompt):
- All evidence sources (git, attribution, prompts)
- Prompt construction + truncation, existing-forest context, and the deep-dive addendum
- Response validation (provenance-forcing, evidence-requiring, proficiency-clamping)
- Merge logic with full provenance-safety, including the new `tracked` state
- Both Claude backends (`cli` default, `api-key`) behind one `ClaudeCaller` signature, with the CLI backend's process-spawning/timeout/error paths covered by mocked-subprocess tests
- Deep-dive label/path resolution against the existing forest
- CLI wiring all of the above together, with `--dry-run` for prompt inspection without invoking either backend

**Not built / explicitly deferred**:
- Neither backend has been exercised against a live model in this environment — the `cli` backend needs the real `claude` binary on `PATH`, the `api-key` backend needs an `ANTHROPIC_API_KEY`, and neither is available here. The dry-run path proves everything up to the call boundary works, and the CLI backend's process-handling is covered by tests that mock `node:child_process`, but "tested with a mocked subprocess" isn't the same claim as "observed working against the real `claude` CLI or API," and this doc isn't going to pretend otherwise.
- `ui/knowledge-forest.html` still loads its three hardcoded demo arrays, not `data/forest.json`. Wiring a `fetch("data/forest.json")` loader (with the hardcoded arrays as a fallback if the file 404s) — and updating "add node" to emit `tracked` instead of `confirmed` per the note above — is a small, well-scoped follow-up — deliberately not done in this pass to keep this plan's claims matched to what was actually run.
- Fuzzy/hunk-level attribution correlation (see limitation above) — v1 ships with exact-match only, which is honest about being low-hit-rate.
- Multi-call chunking for repos whose history exceeds the truncation budget.
- Surfacing `evidence[]` in the UI (currently the schema carries it, nothing renders it yet).

## Phased rollout

1. **(this spike)** CLI produces `data/forest.json` from git + attribution evidence, human runs it manually, inspects the JSON.
2. Wire `ui/knowledge-forest.html`'s loader to read `data/forest.json`, falling back to the hardcoded demo data if absent. Add an evidence-on-hover affordance to the node tooltip.
3. `--include-prompts` gets exercised for real once there's a repo with actual transcript history to test against (this repo's own `.claude/projects/` history is a candidate).
4. Chunked/incremental runs (per time window) instead of one big call, for repos with long histories.
5. *(explicitly optional, not assumed)* — if this ever becomes a real Tourist feature rather than an ideation spike, it needs its own consent-screen design given the local-first principle this project is built on. Not scoped here.

## Testing strategy

- Unit tests for every pure-logic module (`merge`, `validate`, `buildPrompt`, `attributionSource`, `deepDive`) — no network, no filesystem outside `mkdtempSync` temp dirs, run in CI-friendly isolation.
- The CLI's orchestration itself is exercised via `--dry-run` against a real repo rather than further mocked — deliberately, since the goal was to prove the evidence-gathering wiring is correct against real data (real git history, real attribution log format, real transcript path encoding), not just against fixtures that encode my own assumptions about those formats.
- `claude/client.ts`'s `api-key` backend is still untested directly (it's a thin SDK passthrough; the thing worth testing — does the rest of the pipeline handle its output correctly — is covered by `validate.test.ts` against hand-written response fixtures instead). The `cli` backend *is* tested (`test/client.test.ts`), by mocking `node:child_process`'s `spawn` and driving the fake child process through each success/error/timeout/ENOENT path — this is the one place in the pipeline that talks to a real subprocess, so it gets the most direct test coverage rather than relying on downstream validation to catch problems.
