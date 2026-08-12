import { isAttributionSharingEnabled, type AttributionSharingConfig } from "./config.js";
import { runGitOrThrow } from "./gitPlumbing.js";
import { mergeNotes } from "./merge.js";
import { ATTRIBUTION_NOTES_REF, listNotedObjects, readNote, writeNote } from "./notesStore.js";
import type { GitRunner } from "./types.js";

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
 * "Fetch Attribution Notes" — explicit, user-triggered. Fetches the remote's
 * notes ref into a throwaway local ref, merges it commit-by-commit into our
 * own notes ref via `merge.ts`'s field-level policy, then deletes the
 * throwaway ref.
 *
 * This in-process merge (rather than relying on `git notes merge`) is a
 * deliberate placeholder pending Phase 0 experiment 7 — see merge.ts. It's
 * correct, just possibly not the final git-level mechanism.
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
    const remoteObjects = await listNotedObjects(runner, repoRoot, FETCH_TMP_REF);
    const mergedCommits: string[] = [];
    for (const commitSha of remoteObjects) {
      const remoteNote = await readNote(runner, repoRoot, commitSha, FETCH_TMP_REF);
      if (!remoteNote) continue;
      const localNote = await readNote(runner, repoRoot, commitSha);
      const merged = localNote ? mergeNotes(localNote, remoteNote) : remoteNote;
      await writeNote(runner, repoRoot, commitSha, merged);
      mergedCommits.push(commitSha);
    }
    return { skipped: false, mergedCommits };
  } finally {
    // Best-effort cleanup of the throwaway ref; a leftover tmp ref is harmless but untidy.
    await runner(repoRoot, ["update-ref", "-d", FETCH_TMP_REF]);
  }
}
