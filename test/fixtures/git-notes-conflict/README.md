# Two-clone git-notes-conflict fixture (Phase 4 scaffold)

Backs the "NEW -- git notes concurrent-write conflict" edge-case row in
PLAN1.md: two collaborators independently write structured-JSON attribution
notes for the same commit before syncing, and Phase 2's git-notes-mode merge
logic must produce a sane combined result with no silent data loss.

The underlying git mechanics (does git surface a real conflict, what do the
conflict markers look like, is a from-scratch structured-JSON merge scriptable
from Node) were validated empirically in
`spike/experiments/07-git-notes-sync/run.sh` -- see `spike/FINDINGS.md`
experiment 7. This fixture formalizes that same scenario as a reusable
Node helper so Phase 4's edge-case suite can call one function to get two
already-diverged clones, instead of re-deriving the git incantations.

## Status

Skeleton: `setup.mjs` exports `setupDivergentNotesClones()`, which reproduces
spike experiment 7 steps 1-6 (bare origin, two clones, one seed commit, two
independently-written notes for the same commit, clone B has fetched but not
yet merged origin's note) and returns the paths + shas a test needs. It does
NOT yet perform or assert on the merge step itself -- that's the actual
Phase 4 test's job, once Sync point 2 lands and Agent B's real git-notes
persistence module exists to drive the merge against.
