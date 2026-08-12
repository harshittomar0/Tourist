#!/usr/bin/env bash
# Experiment 7 -- git notes write/read/sync/conflict mechanics.
# PLAN1.md Phase 0 item 7. Creates a scratch bare "origin" + two local
# clones, writes divergent structured-JSON notes for the SAME commit in
# each clone before either has seen the other's note, and observes what
# git does on push/fetch/merge. Fully self-contained under a temp dir;
# nothing here is meant to be committed to the tourist repo itself.
set -euo pipefail

WORK="$(mktemp -d /tmp/tourist-spike-exp7.XXXXXX)"
echo "== workdir: $WORK =="
cd "$WORK"

NOTES_REF="refs/notes/tourist-attribution"

echo; echo "--- 1. init bare origin + two clones ---"
git init --bare -q origin.git
git clone -q origin.git clone-a
git clone -q origin.git clone-b

echo; echo "--- 2. clone-a: seed commit + push ---"
cd "$WORK/clone-a"
git config user.email a@example.com; git config user.name "Clone A"
echo "hello" > file.txt
git add file.txt
git commit -q -m "seed commit"
SHA=$(git rev-parse HEAD)
echo "seed commit sha: $SHA"
git push -q origin HEAD:main

echo; echo "--- 3. clone-b: fetch the seed commit (but NOT any note yet) ---"
cd "$WORK/clone-b"
git fetch -q origin main
git checkout -q main

echo; echo "--- 4. clone-a: write note A for \$SHA, push notes ref ---"
cd "$WORK/clone-a"
git notes --ref="$NOTES_REF" add -m '{"author":"clone-a","ranges":[{"start":0,"end":5,"origin":"ai","tier":"2a"}]}' "$SHA"
git push -q origin "$NOTES_REF"
echo "clone-a note pushed. Current note in clone-a:"
git notes --ref="$NOTES_REF" show "$SHA"

echo; echo "--- 5. clone-b: WITHOUT fetching origin's note, write a DIFFERENT note for the SAME sha (genuine divergence) ---"
cd "$WORK/clone-b"
git config user.email b@example.com; git config user.name "Clone B"
git notes --ref="$NOTES_REF" add -m '{"author":"clone-b","ranges":[{"start":0,"end":5,"origin":"human","tier":null}]}' "$SHA"
echo "clone-b note (local, divergent):"
git notes --ref="$NOTES_REF" show "$SHA"

echo; echo "--- 6. clone-b: fetch origin's notes ref into a staging ref (does NOT clobber local) ---"
set +e
git fetch origin "$NOTES_REF:refs/notes/origin/tourist-attribution" 2>&1
FETCH_RC=$?
set -e
echo "fetch rc=$FETCH_RC"

echo; echo "--- 7. clone-b: attempt \`git notes merge\` of the fetched ref into the local notes ref ---"
set +e
git notes --ref="$NOTES_REF" merge refs/notes/origin/tourist-attribution 2>&1
MERGE_RC=$?
set -e
echo "merge rc=$MERGE_RC"

echo; echo "--- 8. inspect merge state ---"
if [ -d .git/NOTES_MERGE_WORKTREE ]; then
  echo "CONFLICT: .git/NOTES_MERGE_WORKTREE exists. Contents:"
  find .git/NOTES_MERGE_WORKTREE -type f -print -exec echo "  ---" \; -exec cat {} \;
  echo
  echo "git status inside the notes-merge state:"
  git status --porcelain=v1 -- 2>&1 || true
  echo "(NOTES_MERGE_PARTIAL / NOTES_MERGE_REF, if present):"
  ls -la .git | grep -i NOTES || true
else
  echo "No .git/NOTES_MERGE_WORKTREE directory -- merge did not conflict (unexpected for a genuine two-sided divergence; investigate)."
fi

echo; echo "--- 9. attempt a scripted structured-JSON conflict resolution driven purely from the shell (proxy for child_process) ---"
if [ -d .git/NOTES_MERGE_WORKTREE ]; then
  NOTE_FILE=$(find .git/NOTES_MERGE_WORKTREE -type f | head -1)
  echo "conflicted note file: $NOTE_FILE"
  cat "$NOTE_FILE"
  # Simulate a custom merge-driver: deserialize both sides is not directly
  # possible from the conflict file alone (git notes conflicts do NOT emit
  # <<<<<<< markers the way normal merges do -- see finding below) --
  # instead each side's git-notes conflict resolution replaces the note
  # object outright with "ours" and stages "theirs" as a separate blob one
  # must diff for. We write a merged JSON combining both by hand here to
  # prove the plumbing (`git notes add -f` + `git notes merge --commit`)
  # accepts a freshly-serialized result.
  python3 - "$NOTE_FILE" <<'PYEOF'
import json, sys
path = sys.argv[1]
with open(path) as f:
    raw = f.read()
print("RAW CONTENT OF CONFLICTED NOTE FILE:")
print(raw)
PYEOF
  echo '{"author":"merged","ranges":[{"start":0,"end":5,"origin":"ai","tier":"2a"},{"start":0,"end":5,"origin":"human","tier":null}]}' > "$NOTE_FILE"
  git add "$NOTE_FILE"
  set +e
  git notes --ref="$NOTES_REF" merge --commit 2>&1
  COMMIT_RC=$?
  set -e
  echo "notes merge --commit rc=$COMMIT_RC"
  echo "final merged note in clone-b:"
  git notes --ref="$NOTES_REF" show "$SHA"
else
  echo "skipped (no conflict directory found)"
fi

echo; echo "--- 10. attempt clone-b push of its (now merged) notes ref back to origin ---"
cd "$WORK/clone-b"
set +e
git push origin "$NOTES_REF" 2>&1
PUSH_RC=$?
set -e
echo "push rc=$PUSH_RC"

echo; echo "--- 11. sanity: rejected-push case -- clone-a pushes again without ever merging clone-b's version ---"
cd "$WORK/clone-a"
git notes --ref="$NOTES_REF" add -f -m '{"author":"clone-a-v2","ranges":[]}' "$SHA"
set +e
git push origin "$NOTES_REF" 2>&1
PUSH2_RC=$?
set -e
echo "clone-a's second (unmerged, stale-base) push rc=$PUSH2_RC (expect non-zero / rejected as non-fast-forward)"

echo; echo "== DONE. workdir left at $WORK for manual inspection. =="
