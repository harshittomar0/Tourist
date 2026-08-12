# Large-repo performance fixture (Phase 4 scaffold)

Backs the three "NEW" risk rows in PLAN1.md's edge-case table that need a
large synthetic repo, not unit-level engine fixtures:

- large-repo activation/scan performance
- workspace-watcher OS-level overhead/limits
- bulk background-change bursts (branch switch / rebase touching thousands
  of files)

Not checked into git as static fixture files (tens of thousands of files
would bloat the repo for no benefit) -- `generate.mjs` builds the tree
on demand into a gitignored scratch directory instead.

## Status

Skeleton only. `generate.mjs` produces the file tree; no benchmark harness
consumes it yet -- that's Phase 4's job, once Sync point 2 lands.

## Usage (once Phase 4 wires this up)

```
node test/fixtures/large-repo-performance/generate.mjs --out /tmp/tourist-large-repo --files 30000
```

Produces:
- a real git repo (so exclusion-filter-then-git-op-suppression behavior can
  be exercised, not just raw file count)
- a realistic mix of tracked source files and default-excluded paths
  (`node_modules/`, `dist/`, `.git/` is real already) so Phase 4 can assert
  the exclusion predicate is applied *before* a path is ever watched, per
  RESEARCH1.md's exclusion-filter requirement -- not just measure raw scan
  time over everything.
- a `MANIFEST.json` listing how many files were generated in each bucket
  (tracked vs. excluded), so a benchmark can assert against expected counts
  rather than re-deriving them.
