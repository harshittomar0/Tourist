import { execFileSync } from "node:child_process";

export interface CommitSummary {
  sha: string;
  timestamp: number;
  message: string;
  files: string[];
}

function git(repoPath: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoPath, encoding: "utf8", maxBuffer: 1024 * 1024 * 64 });
}

// A control-character marker + field separator that will never legitimately
// appear in a commit message or file path, so header lines and file-list
// lines can never be confused with each other (git log --name-only
// interleaves them in the same stream with no other reliable marker).
const HEADER_MARK = "\x02COMMIT\x01";
const FIELD_SEP = "\x01";

/**
 * Commits since `sinceIso` (e.g. "2026-07-01" or "30 days ago" — anything
 * `git log --since` accepts), newest first, each with the files it touched.
 */
export function listRecentCommits(repoPath: string, sinceIso: string): CommitSummary[] {
  const out = git(repoPath, [
    "log",
    `--since=${sinceIso}`,
    `--pretty=format:${HEADER_MARK}%H${FIELD_SEP}%ct${FIELD_SEP}%s`,
    "--name-only"
  ]);

  const commits: CommitSummary[] = [];
  let current: CommitSummary | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith(HEADER_MARK)) {
      if (current) commits.push(current);
      const [sha, ts, message] = line.slice(HEADER_MARK.length).split(FIELD_SEP);
      current = { sha, timestamp: Number(ts) * 1000, message, files: [] };
    } else if (line.trim() && current) {
      current.files.push(line.trim());
    }
  }
  if (current) commits.push(current);
  return commits;
}

/** Raw content of `filePath` as it existed at `sha`. Empty string if the file didn't exist at that commit. */
export function getFileContentAtCommit(repoPath: string, sha: string, filePath: string): string {
  try {
    return git(repoPath, ["show", `${sha}:${filePath}`]);
  } catch {
    return "";
  }
}

/** Unified diff for a single commit, context collapsed to 0 lines to keep prompts small. */
export function getCommitDiff(repoPath: string, sha: string): string {
  try {
    return git(repoPath, ["show", sha, "--unified=0", "--format="]);
  } catch {
    return "";
  }
}

export function repoRoot(fromPath: string): string {
  return git(fromPath, ["rev-parse", "--show-toplevel"]).trim();
}
