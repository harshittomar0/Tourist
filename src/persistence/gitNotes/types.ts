import type { AttributionInfo, RangeSpan } from "../types.js";

export interface AttributionNoteEntry {
  contentHash: string;
  range: RangeSpan;
  attribution: AttributionInfo;
}

/**
 * The structured JSON body stored under `refs/notes/tourist-attribution`,
 * scoped to a single commit — not a full-file snapshot. `commit` is
 * self-referential (redundant with the note's target) purely so a note blob
 * remains meaningful if ever inspected outside of `git notes show`.
 */
export interface AttributionNote {
  version: 1;
  commit: string;
  entries: AttributionNoteEntry[];
}

export interface GitRunResult {
  stdout: string;
  code: number;
}

/**
 * Injectable seam over `git` subprocess execution. Real usage goes through
 * `defaultGitRunner` (execFile); tests inject a spy/fake to assert exactly
 * which git-notes commands did or didn't run.
 */
export type GitRunner = (repoRoot: string, args: string[]) => Promise<GitRunResult>;
