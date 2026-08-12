# Knowledge forest (ideation)

An interactive representation of "what does this developer know" as three tree-forests — Tech Stacks, CS Fundamentals, Engineering Practice — plus a spike pipeline that populates it from real evidence via Claude. See `PLAN.md` for the full architecture and honest status (what's built vs. verified vs. deferred).

## Layout

```
taxonomy-guidelines.md   Single source of truth for what belongs in each forest, at what
                         depth, and what "proficiency" means in each. Read by both a human
                         designing new nodes by hand and by analyser/ as the literal system
                         prompt for the LLM classifier.
PLAN.md                  Architecture, data flow, provenance/merge rules, privacy boundary,
                         and what's actually been run vs. just written.
ui/
  knowledge-forest.html      The three-forest UI. Self-contained, open directly in a browser
                             (or `ao preview ui/knowledge-forest.html`). Currently loads
                             hardcoded demo data — see PLAN.md "Not built yet."
  knowledge-diagrams.html    Earlier treemap + Johari-window mockups from the same design
                             thread; kept for reference.
data/
  forest.seed.json        The UI's hardcoded demo data, extracted into the persisted JSON
                           schema (no id/expanded — those are UI-runtime fields). Useful as
                           a realistic "existing forest" input when testing merge behavior.
analyser/                 The ingestion pipeline. Self-contained TypeScript package —
                           own package.json/tsconfig/vitest config, deliberately never
                           touches tourist's root build (see PLAN.md "Scope boundary").
```

## Running the analyser

```bash
cd analyser
npm install

# Inspect what would be sent to Claude, without spending an API call or
# invoking any Claude backend:
npx tsx src/cli.ts --repo /path/to/some/repo --dry-run --out ../data/forest.json

# The real run — default backend is "cli": it shells out to the already-
# authenticated `claude` CLI (whatever you're logged in with), no separate
# API key needed:
npx tsx src/cli.ts --repo /path/to/some/repo --out ../data/forest.json

# Or call the Anthropic API directly with your own key instead (never runs
# implicitly — see PLAN.md "Privacy boundary"):
export ANTHROPIC_API_KEY=sk-...
npx tsx src/cli.ts --repo /path/to/some/repo --out ../data/forest.json --claude-backend api-key

# Flags:
#   --since "30 days ago"      git log window (default: 30 days ago)
#   --max-commits 20           cap on commits considered (default: 20)
#   --forest tech,cs,practice  which forests to classify into (default: all three)
#   --include-prompts          also read Claude Code session transcripts for this repo —
#                              opt-in, off by default (see PLAN.md, privacy-sensitive)
#   --max-chars 60000          evidence-bundle size cap sent to Claude
#   --model claude-sonnet-5    model id, passed to whichever backend is active
#   --claude-backend cli       "cli" (default, shells out to the `claude` CLI) or
#                              "api-key" (calls the Anthropic API directly)
#   --claude-cli-path claude   path to the `claude` binary — only used when
#                              --claude-backend is "cli"
#   --deep-dive "Django,Big-O" comma-separated existing category labels (or
#                              "Parent > Child" paths to disambiguate a
#                              repeated label) to expand in much more detail
#                              this run, instead of the normal shallow pass.
#                              A label that isn't found in the current forest
#                              is skipped and reported on stderr, not an error.
```

```bash
npm test        # 65 tests, no network/API needed
npx tsc --noEmit -p .   # strict type-check
```

## The one thing to not lose sight of

This whole folder answers "how do we represent developer knowledge and how do we infer it" — a different question from what the rest of the `tourist` repo answers ("who wrote this specific line, AI or human"). They're related (the attribution log is one of this pipeline's evidence sources) but not the same system, and this should stay a self-contained `ideation/` spike unless a deliberate decision is made to promote it into a real feature — see `PLAN.md`'s "Scope boundary" section for why that matters given tourist's local-first design principle.
