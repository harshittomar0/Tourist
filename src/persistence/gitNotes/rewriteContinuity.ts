import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveCommonGitDir, resolveGitDir } from "../gitContext.js";
import { isAttributionSharingEnabled, type AttributionSharingConfig } from "./config.js";
import { ATTRIBUTION_NOTES_REF } from "./notesStore.js";
import { copyNote, readNote } from "./notesStore.js";
import type { GitRunner } from "./types.js";

/**
 * Continuity across amend/rebase is handled by git's own builtin note-copying
 * (empirically confirmed: `git config notes.rewrite.<amend|rebase> true` +
 * `notes.rewriteRef` is enough — no custom hook logic needed for that path).
 * This just turns that on when Mode B is enabled.
 */
export async function configureNotesRewrite(runner: GitRunner, repoRoot: string): Promise<void> {
  await runner(repoRoot, ["config", "notes.rewrite.amend", "true"]);
  await runner(repoRoot, ["config", "notes.rewrite.rebase", "true"]);
  await runner(repoRoot, ["config", "notes.rewriteRef", ATTRIBUTION_NOTES_REF]);
}

// --- Hook file installation -------------------------------------------------

export const HOOK_MARKER = "# --- tourist-attribution-hook (managed by Tourist; safe to leave, do not hand-edit below) ---";

export interface InstallHookOptions {
  repoRoot: string;
  hookName: "post-commit" | "post-rewrite";
  /** Shell command line to append, e.g. `node "/abs/path/hookRunner.mjs" post-commit`. */
  invocationCommand: string;
}

export interface InstallHookResult {
  hookPath: string;
  installed: boolean;
  alreadyPresent: boolean;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Installs (or re-confirms) our block in `<hookName>`, appending to whatever
 * is already there — husky, pre-commit, a hand-written script — rather than
 * overwriting it. Idempotent: re-running when our marker is already present
 * is a no-op.
 */
export async function installHook(options: InstallHookOptions): Promise<InstallHookResult> {
  const commonGitDir = await resolveCommonGitDir(options.repoRoot);
  const hooksDir = join(commonGitDir, "hooks");
  await mkdir(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, options.hookName);

  let existing = "";
  if (await pathExists(hookPath)) {
    existing = await readFile(hookPath, "utf8");
  }

  if (existing.includes(HOOK_MARKER)) {
    return { hookPath, installed: false, alreadyPresent: true };
  }

  const block = `${HOOK_MARKER}\n${options.invocationCommand}\n`;
  const newContent =
    existing.length > 0
      ? `${existing.endsWith("\n") ? existing : `${existing}\n`}${block}`
      : `#!/usr/bin/env bash\nset -e\n\n${block}`;

  await writeFile(hookPath, newContent, "utf8");
  await chmod(hookPath, 0o755);
  return { hookPath, installed: true, alreadyPresent: false };
}

// --- Hook-runner logic (invoked by the installed hook scripts) -------------

export type PostCommitOutcome =
  | { skipped: true }
  | { action: "not-a-cherry-pick" }
  | { action: "cherry-pick-copied"; from: string; to: string }
  | { action: "cherry-pick-no-source-note"; from: string }
  /**
   * Documented, visibly-flagged gap: a cherry-pick without `-x` carries no
   * `(cherry picked from commit ...)` trailer, so we cannot identify the
   * source commit at all. We know continuity *may* have been lost — we log
   * that fact loudly rather than pretending nothing happened.
   */
  | { action: "cherry-pick-gap-no-trailer"; commit: string };

const CHERRY_PICK_TRAILER = /^\s*\(cherry picked from commit ([0-9a-f]{7,40})\)\s*$/m;

/**
 * Cherry-pick has no post-rewrite hook and isn't covered by
 * `notes.rewrite.*` at all — this is the one continuity path that must be
 * handled by hand, in post-commit. Empirically confirmed: `CHERRY_PICK_HEAD`
 * still exists (with the source SHA) at the moment post-commit fires for a
 * cherry-pick, whether or not `-x` was used.
 */
export async function handlePostCommit(
  runner: GitRunner,
  repoRoot: string,
  config: AttributionSharingConfig,
  log: (message: string) => void = console.warn
): Promise<PostCommitOutcome> {
  if (!isAttributionSharingEnabled(config)) return { skipped: true };

  const gitDir = await resolveGitDir(repoRoot);
  const cherryPickHeadPath = join(gitDir, "CHERRY_PICK_HEAD");
  if (!(await pathExists(cherryPickHeadPath))) {
    return { action: "not-a-cherry-pick" };
  }

  const commitMessageResult = await runner(repoRoot, ["log", "-1", "--pretty=%B", "HEAD"]);
  const trailerMatch = commitMessageResult.stdout.match(CHERRY_PICK_TRAILER);
  if (!trailerMatch) {
    const head = (await runner(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
    log(
      `[tourist] cherry-pick detected without "-x" — attribution continuity for commit ${head} ` +
        `cannot be traced to its source and will be treated as a fresh, unattributed range. ` +
        `Use "git cherry-pick -x" to preserve continuity.`
    );
    return { action: "cherry-pick-gap-no-trailer", commit: head };
  }

  const fromSha = trailerMatch[1];
  const sourceNote = await readNote(runner, repoRoot, fromSha);
  if (!sourceNote) {
    return { action: "cherry-pick-no-source-note", from: fromSha };
  }
  const toSha = (await runner(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
  await copyNote(runner, repoRoot, fromSha, toSha);
  return { action: "cherry-pick-copied", from: fromSha, to: toSha };
}

export interface RewritePair {
  oldSha: string;
  newSha: string;
}

export function parseRewriteStdin(stdin: string): RewritePair[] {
  return stdin
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [oldSha, newSha] = line.split(/\s+/);
      return { oldSha, newSha };
    })
    .filter((pair): pair is RewritePair => Boolean(pair.oldSha && pair.newSha));
}

export type PostRewriteOutcome =
  | { skipped: true }
  | { checked: RewritePair[]; safetyNetCopies: RewritePair[] };

/**
 * Safety net, not the primary mechanism: `configureNotesRewrite` makes git
 * copy notes across amend/rebase on its own. This just double-checks — if a
 * pair's old commit has a note the new one is missing (e.g. the config above
 * was never applied because Mode B was enabled after this repo already had
 * history), copy it ourselves so continuity doesn't silently depend on that
 * config having been set at exactly the right time.
 */
export async function handlePostRewrite(
  runner: GitRunner,
  repoRoot: string,
  config: AttributionSharingConfig,
  stdin: string
): Promise<PostRewriteOutcome> {
  if (!isAttributionSharingEnabled(config)) return { skipped: true };

  const pairs = parseRewriteStdin(stdin);
  const safetyNetCopies: RewritePair[] = [];
  for (const pair of pairs) {
    const newNote = await readNote(runner, repoRoot, pair.newSha);
    if (newNote) continue; // git's builtin copy already handled it
    const oldNote = await readNote(runner, repoRoot, pair.oldSha);
    if (!oldNote) continue; // nothing to copy
    await copyNote(runner, repoRoot, pair.oldSha, pair.newSha);
    safetyNetCopies.push(pair);
  }
  return { checked: pairs, safetyNetCopies };
}
