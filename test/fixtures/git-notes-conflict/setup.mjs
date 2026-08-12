// Reusable setup for the two-clone git-notes-conflict fixture. Reproduces
// spike/experiments/07-git-notes-sync/run.sh steps 1-6 (see FINDINGS.md
// experiment 7 for the validated mechanics) as a Node helper, so Phase 4's
// edge-case suite doesn't need to re-derive the git incantations. Skeleton:
// stops right before the merge step, which is Phase 4's own test to drive
// against Agent B's real git-notes persistence module.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const NOTES_REF = "refs/notes/tourist-attribution";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * @returns {{
 *   workDir: string, originDir: string, cloneADir: string, cloneBDir: string,
 *   sha: string, notesRef: string
 * }}
 */
export function setupDivergentNotesClones() {
  const workDir = mkdtempSync(path.join(tmpdir(), "tourist-fixture-notes-conflict-"));
  const originDir = path.join(workDir, "origin.git");
  const cloneADir = path.join(workDir, "clone-a");
  const cloneBDir = path.join(workDir, "clone-b");

  git(["init", "--bare", "-q", originDir]);
  git(["clone", "-q", originDir, cloneADir]);
  git(["clone", "-q", originDir, cloneBDir]);

  git(["config", "user.email", "a@example.com"], cloneADir);
  git(["config", "user.name", "Clone A"], cloneADir);
  execFileSync("bash", ["-c", "echo hello > file.txt"], { cwd: cloneADir });
  git(["add", "file.txt"], cloneADir);
  git(["commit", "-q", "-m", "seed commit"], cloneADir);
  const sha = git(["rev-parse", "HEAD"], cloneADir);
  git(["push", "-q", "origin", "HEAD:main"], cloneADir);

  git(["fetch", "-q", "origin", "main"], cloneBDir);
  git(["checkout", "-q", "main"], cloneBDir);

  git(["notes", `--ref=${NOTES_REF}`, "add", "-m", JSON.stringify({ author: "clone-a", ranges: [{ start: 0, end: 5, origin: "ai", tier: "2a" }] }), sha], cloneADir);
  git(["push", "-q", "origin", NOTES_REF], cloneADir);

  git(["config", "user.email", "b@example.com"], cloneBDir);
  git(["config", "user.name", "Clone B"], cloneBDir);
  git(["notes", `--ref=${NOTES_REF}`, "add", "-m", JSON.stringify({ author: "clone-b", ranges: [{ start: 0, end: 5, origin: "human", tier: null }] }), sha], cloneBDir);

  // clone-b now has a note for `sha` that diverges from origin's, and has
  // NOT yet fetched/merged origin's version -- the genuine divergence Phase
  // 4's merge test needs. Fetching origin's side into a staging ref (rather
  // than fetching directly onto NOTES_REF) is left to the caller, matching
  // spike experiment 7 step 6 onward.

  return { workDir, originDir, cloneADir, cloneBDir, sha, notesRef: NOTES_REF };
}
