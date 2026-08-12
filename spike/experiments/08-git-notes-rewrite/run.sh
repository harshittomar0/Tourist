#!/usr/bin/env bash
# Experiment 8 -- git notes survival across rebase/amend/cherry-pick.
# PLAN1.md Phase 0 item 8. Re-confirms the strong pre-validated hypothesis
# already written into PLAN1.md (git 2.50.1, macOS) on THIS machine's git
# version. Fully self-contained under a temp dir.
set -euo pipefail

GITVER="$(git --version)"
echo "git version under test: $GITVER"

section() { echo; echo "=== $1 ==="; }

# ---------------------------------------------------------------------------
section "8a. commit --amend with NO rewrite config -- expect silent orphan"
# ---------------------------------------------------------------------------
W="$(mktemp -d /tmp/tourist-spike-exp8a.XXXXXX)"
cd "$W"
git init -q .
git config user.email a@example.com; git config user.name "A"
echo "one" > f.txt; git add f.txt; git commit -q -m "c1"
SHA1=$(git rev-parse HEAD)
git notes --ref=tourist-attribution add -m '{"origin":"ai"}' "$SHA1"
echo "before amend: note on $SHA1 = $(git notes --ref=tourist-attribution show "$SHA1")"
echo "two" >> f.txt; git add f.txt
git commit -q --amend -m "c1 amended"
SHA2=$(git rev-parse HEAD)
echo "old sha $SHA1 -> new sha $SHA2"
set +e
git notes --ref=tourist-attribution show "$SHA2" 2>&1
NEWNOTE_RC=$?
git notes --ref=tourist-attribution show "$SHA1" 2>&1
OLDNOTE_RC=$?
set -e
echo "note on NEW sha present? rc=$NEWNOTE_RC (0=yes,1=no)"
echo "note on OLD sha still present (now unreachable)? rc=$OLDNOTE_RC (0=yes,1=no)"
set +e
git merge-base --is-ancestor "$SHA1" HEAD 2>&1; echo "is old sha still an ancestor of HEAD? rc=$? (0=yes/reachable, 1=no/orphaned)"
set -e

# ---------------------------------------------------------------------------
section "8b. commit --amend WITH notes.rewriteRef + notes.rewrite.amend true -- expect auto-copy"
# ---------------------------------------------------------------------------
W="$(mktemp -d /tmp/tourist-spike-exp8b.XXXXXX)"
cd "$W"
git init -q .
git config user.email a@example.com; git config user.name "A"
git config notes.rewriteRef refs/notes/tourist-attribution
git config notes.rewrite.amend true
echo "one" > f.txt; git add f.txt; git commit -q -m "c1"
SHA1=$(git rev-parse HEAD)
git notes --ref=tourist-attribution add -m '{"origin":"ai"}' "$SHA1"
echo "two" >> f.txt; git add f.txt
git commit -q --amend -m "c1 amended"
SHA2=$(git rev-parse HEAD)
echo "old sha $SHA1 -> new sha $SHA2"
set +e
git notes --ref=tourist-attribution show "$SHA2" 2>&1; echo "note on NEW sha rc=$?"
set -e

# ---------------------------------------------------------------------------
section "8c. rebase (multi-commit) WITH notes.rewriteRef + notes.rewrite.rebase true -- expect auto-copy for all commits"
# ---------------------------------------------------------------------------
W="$(mktemp -d /tmp/tourist-spike-exp8c.XXXXXX)"
cd "$W"
git init -q -b main .
git config user.email a@example.com; git config user.name "A"
git config notes.rewriteRef refs/notes/tourist-attribution
git config notes.rewrite.rebase true
echo base > f.txt; git add f.txt; git commit -q -m base
git checkout -q -b feature
echo "one" >> f.txt; git add f.txt; git commit -q -m "feat1"
FEAT1=$(git rev-parse HEAD)
git notes --ref=tourist-attribution add -m '{"c":"feat1"}' "$FEAT1"
echo "two" >> f.txt; git add f.txt; git commit -q -m "feat2"
FEAT2=$(git rev-parse HEAD)
git notes --ref=tourist-attribution add -m '{"c":"feat2"}' "$FEAT2"
git checkout -q main
echo "divergent" > other.txt; git add other.txt; git commit -q -m "main-divergence"
git checkout -q feature
git rebase -q main
NEWFEAT1=$(git log --oneline main..feature | tail -1 | awk '{print $1}')
echo "post-rebase feature log:"; git log --oneline main..feature
for c in $(git rev-list main..feature); do
  set +e
  NOTE=$(git notes --ref=tourist-attribution show "$c" 2>&1)
  RC=$?
  set -e
  echo "commit $c note(rc=$RC): $NOTE"
done

# ---------------------------------------------------------------------------
section "8d. interactive-rebase SQUASH of two noted commits -- expect N:1, both old SHAs -> one new SHA"
# ---------------------------------------------------------------------------
W="$(mktemp -d /tmp/tourist-spike-exp8d.XXXXXX)"
cd "$W"
git init -q -b main .
git config user.email a@example.com; git config user.name "A"
git config notes.rewriteRef refs/notes/tourist-attribution
git config notes.rewrite.rebase true
mkdir -p .git/hooks
cat > .git/hooks/post-rewrite <<'HOOK'
#!/usr/bin/env bash
{
  echo "post-rewrite fired: class=$1"
  cat
} >> "$(git rev-parse --git-dir)/../post-rewrite.log"
HOOK
chmod +x .git/hooks/post-rewrite
echo base > f.txt; git add f.txt; git commit -q -m base
echo one >> f.txt; git add f.txt; git commit -q -m c1
C1=$(git rev-parse HEAD)
git notes --ref=tourist-attribution add -m '{"c":"c1"}' "$C1"
echo two >> f.txt; git add f.txt; git commit -q -m c2
C2=$(git rev-parse HEAD)
git notes --ref=tourist-attribution add -m '{"c":"c2"}' "$C2"
GIT_SEQUENCE_EDITOR="sed -i '' -e '2s/^pick/squash/'" git rebase -q -i HEAD~2
NEWSHA=$(git rev-parse HEAD)
echo "squashed sha: $NEWSHA"
set +e
git notes --ref=tourist-attribution show "$NEWSHA" 2>&1; echo "note on squashed sha rc=$?"
set -e
echo "post-rewrite.log contents:"
cat post-rewrite.log 2>/dev/null || echo "(none)"

# ---------------------------------------------------------------------------
section "8e. cherry-pick WITHOUT -x -- expect note lost, NO hook fires at all, no signal"
# ---------------------------------------------------------------------------
W="$(mktemp -d /tmp/tourist-spike-exp8e.XXXXXX)"
cd "$W"
git init -q -b main .
git config user.email a@example.com; git config user.name "A"
git config notes.rewriteRef refs/notes/tourist-attribution
git config notes.rewrite.rebase true
git config notes.rewrite.amend true
mkdir -p .git/hooks
cat > .git/hooks/post-rewrite <<'HOOK'
#!/usr/bin/env bash
{
  echo "post-rewrite fired: class=$1"
  cat
} >> "$(git rev-parse --git-dir)/../post-rewrite.log"
HOOK
chmod +x .git/hooks/post-rewrite
echo base > f.txt; git add f.txt; git commit -q -m base
git checkout -q -b feature
echo one >> f.txt; git add f.txt; git commit -q -m c1
C1=$(git rev-parse HEAD)
git notes --ref=tourist-attribution add -m '{"c":"c1"}' "$C1"
git checkout -q main
echo "main-only-divergence" > other.txt; git add other.txt; git commit -q -m "main-divergence"
git cherry-pick "$C1"
NEWSHA=$(git rev-parse HEAD)
echo "cherry-picked (no -x) sha: $NEWSHA (source was $C1) -- must differ from source to be a valid test"
set +e
git notes --ref=tourist-attribution show "$NEWSHA" 2>&1; echo "note on cherry-picked sha rc=$?"
set -e
echo "post-rewrite.log contents (expect NOT present / empty -- hook should not fire for cherry-pick):"
cat post-rewrite.log 2>/dev/null || echo "(none -- confirms no hook signal)"

# ---------------------------------------------------------------------------
section "8f. cherry-pick WITH -x -- expect trailer present, still no rewrite-hook signal, but recoverable via message scan"
# ---------------------------------------------------------------------------
W="$(mktemp -d /tmp/tourist-spike-exp8f.XXXXXX)"
cd "$W"
git init -q -b main .
git config user.email a@example.com; git config user.name "A"
git config notes.rewrite.cherry-pick true
git config notes.rewriteRef refs/notes/tourist-attribution
mkdir -p .git/hooks
cat > .git/hooks/post-rewrite <<'HOOK'
#!/usr/bin/env bash
{
  echo "post-rewrite fired: class=$1"
  cat
} >> "$(git rev-parse --git-dir)/../post-rewrite.log"
HOOK
chmod +x .git/hooks/post-rewrite
echo base > f.txt; git add f.txt; git commit -q -m base
git checkout -q -b feature
echo one >> f.txt; git add f.txt; git commit -q -m c1
C1=$(git rev-parse HEAD)
git notes --ref=tourist-attribution add -m '{"c":"c1"}' "$C1"
git checkout -q main
echo "main-only-divergence" > other.txt; git add other.txt; git commit -q -m "main-divergence"
git cherry-pick -x "$C1"
NEWSHA=$(git rev-parse HEAD)
echo "cherry-picked (WITH -x) sha: $NEWSHA (source was $C1) -- must differ from source to be a valid test"
echo "new commit message:"; git log -1 --format=%B "$NEWSHA"
set +e
git notes --ref=tourist-attribution show "$NEWSHA" 2>&1; echo "note on cherry-picked sha rc=$? (expect 1 -- notes.rewrite.cherry-pick does NOT exist/apply, confirming even with the config set there's no built-in copy path)"
set -e
echo "post-rewrite.log contents (expect NOT present -- confirms hook truly never fires for cherry-pick, -x or not):"
cat post-rewrite.log 2>/dev/null || echo "(none)"

echo; echo "=== ALL 8x SUB-EXPERIMENTS DONE ==="
