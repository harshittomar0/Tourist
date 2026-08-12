import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isAttributionSharingEnabled, type AttributionSharingConfig } from "./config.js";
import { runGitOrThrow } from "./gitPlumbing.js";
import { mergeNotes } from "./merge.js";
import { ATTRIBUTION_NOTES_REF, listNotedObjects } from "./notesStore.js";
import type { AttributionNote, GitRunner } from "./types.js";

const FETCH_TMP_REF = "refs/notes/tourist-attribution-fetch-tmp";

export type PushResult = { skipped: true; reason: "disabled" } | { skipped: false };

export type FetchResult = { skipped: true; reason: "disabled" } | { skipped: false; mergedCommits: string[] };

/**
 * "Push Attribution Notes" — explicit, user-triggered. Never called
 * automatically by anything else in this module; no background sync exists.
 */
export async function pushAttributionNotes(
  runner: GitRunner,
  repoRoot: string,
  config: AttributionSharingConfig
): Promise<PushResult> {
  if (!isAttributionSharingEnabled(config)) return { skipped: true, reason: "disabled" };
  const remote = config.remote ?? "origin";
  await runGitOrThrow(runner, repoRoot, ["push", remote, ATTRIBUTION_NOTES_REF]);
  return { skipped: false };
}

/**
 * Reconstructs both full sides of a `.git/NOTES_MERGE_WORKTREE/<sha>`
 * conflict file (real, confirmed format per spike/FINDINGS.md Experiment 7).
 * Git's notes merge does a line-level diff of the two JSON blobs, not a
 * whole-file `<<<<<<<`/`>>>>>>>` wrap -- lines outside any conflict hunk are
 * shared context (e.g. the common `{`/`"version": 1,`/`]`/`}` lines), and
 * only the actually-differing lines are wrapped per hunk, so each full side
 * must be reassembled from common-plus-that-side's-lines across every hunk,
 * not read verbatim out of a single pair of markers.
 */
function reconstructConflictSides(raw: string): { ours: string; theirs: string } {
  const oursLines: string[] = [];
  const theirsLines: string[] = [];
  let mode: "common" | "ours" | "theirs" = "common";
  let sawConflict = false;
  for (const line of raw.split("\n")) {
    if (line.startsWith("<<<<<<<")) {
      mode = "ours";
      sawConflict = true;
      continue;
    }
    if (mode === "ours" && line === "=======") {
      mode = "theirs";
      continue;
    }
    if (mode === "theirs" && line.startsWith(">>>>>>>")) {
      mode = "common";
      continue;
    }
    if (mode !== "theirs") oursLines.push(line);
    if (mode !== "ours") theirsLines.push(line);
  }
  if (!sawConflict) throw new Error("Unrecognized attribution-notes conflict marker format");
  return { ours: oursLines.join("\n"), theirs: theirsLines.join("\n") };
}

/**
 * "Fetch Attribution Notes" — explicit, user-triggered. Fetches the remote's
 * notes ref into a throwaway local ref, then reconciles it into our own
 * notes ref via real `git notes merge` (per spike/FINDINGS.md Experiment 7's
 * confirmed mechanism), rather than rewriting the ref with a fresh, parentless
 * `notes add -f` commit that shares no ancestry with the remote's history —
 * the latter is what made every subsequent push fail non-fast-forward
 * (REVIEW_SENIOR.md finding #3). A clean/fast-forward merge needs nothing
 * further; a real `CONFLICT (add/add)` is resolved per-object with our own
 * tier-then-recency policy (`merge.ts`'s `mergeNotes`), then finalized with
 * `notes merge --commit` -- a real two-parent merge commit, so a later push
 * is a genuine fast-forward again.
 */
export async function fetchAttributionNotes(
  runner: GitRunner,
  repoRoot: string,
  config: AttributionSharingConfig
): Promise<FetchResult> {
  if (!isAttributionSharingEnabled(config)) return { skipped: true, reason: "disabled" };
  const remote = config.remote ?? "origin";

  await runGitOrThrow(runner, repoRoot, ["fetch", remote, `${ATTRIBUTION_NOTES_REF}:${FETCH_TMP_REF}`]);
  try {
    const mergedCommits = await listNotedObjects(runner, repoRoot, FETCH_TMP_REF);
    const mergeResult = await runner(repoRoot, ["notes", `--ref=${ATTRIBUTION_NOTES_REF}`, "merge", FETCH_TMP_REF]);

    if (mergeResult.code === 0) {
      // Clean automatic merge, or a fast-forward (including the "nothing
      // local yet" first-fetch case) -- git already produced a real ref
      // history with correct parentage; nothing more to do.
      return { skipped: false, mergedCommits };
    }

    // A genuine add/add (or add/modify) conflict -- resolve each conflicted
    // object file under NOTES_MERGE_WORKTREE with our structured-JSON policy
    // by rewriting the file in place, then finalize with a real merge
    // commit. Deliberately does NOT run `notes add -f` to stage the
    // resolution: that writes straight through to the real ref mid-merge,
    // which moves the ref out from under `notes merge --commit`'s expected
    // pre-merge tip and makes it fail with "cannot lock ref ... is at X but
    // expected Y" (confirmed empirically) -- `merge --commit` already reads
    // the resolved content directly from NOTES_MERGE_WORKTREE itself.
    const worktree = resolve(
      repoRoot,
      (await runGitOrThrow(runner, repoRoot, ["rev-parse", "--git-path", "NOTES_MERGE_WORKTREE"])).trim()
    );
    const conflictedShas = await readdir(worktree).catch(() => [] as string[]);

    for (const commitSha of conflictedShas) {
      const filePath = join(worktree, commitSha);
      const raw = await readFile(filePath, "utf8");
      const { ours, theirs } = reconstructConflictSides(raw);
      const oursNote = JSON.parse(ours) as AttributionNote;
      const theirsNote = JSON.parse(theirs) as AttributionNote;
      const merged = mergeNotes(oursNote, theirsNote);
      await writeFile(filePath, JSON.stringify(merged, null, 2), "utf8");
    }

    const commitResult = await runner(repoRoot, ["notes", `--ref=${ATTRIBUTION_NOTES_REF}`, "merge", "--commit"]);
    if (commitResult.code !== 0) {
      await runner(repoRoot, ["notes", `--ref=${ATTRIBUTION_NOTES_REF}`, "merge", "--abort"]);
      throw new Error(`Failed to finalize attribution-notes merge in ${repoRoot}: exit ${commitResult.code}`);
    }
    return { skipped: false, mergedCommits };
  } finally {
    // Best-effort cleanup of the throwaway ref; a leftover tmp ref is harmless but untidy.
    await runner(repoRoot, ["update-ref", "-d", FETCH_TMP_REF]);
  }
}
